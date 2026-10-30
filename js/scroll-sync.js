// scroll-sync.js
// Keeps the Source (CodeMirror) and Preview panes of the Live layout on the
// same place in the document. The position is mapped by CONTENT, not by
// percentage: an image is one line in Source but hundreds of pixels in
// Preview, so "40% of Source" and "40% of Preview" show different places.
//
// This part is pure (no DOM): anchors are pairs of scroll offsets that show
// the same content in both panes (an image, a heading); between two anchors
// the position is interpolated linearly. Without anchors it degrades to a
// plain percentage.
// createScrollSync() at the end of the file is the DOM part.

import { parseHeadingOutline } from './doc-outline.js';

/**
 * Ordered anchor pairs from the start to the end of both panes.
 * Anchors outside the scroll range, with NaN, or breaking the order in either
 * pane are dropped (kept greedily from the top). An empty pane gives [].
 * @param {Array<{src: number, pv: number}>} anchors
 * @param {number} srcMax  scrollable range of Source (scrollHeight - clientHeight)
 * @param {number} pvMax   scrollable range of Preview
 * @returns {Array<{src: number, pv: number}>}
 */
export function buildScrollPairs(anchors, srcMax, pvMax) {
  if (!(srcMax > 0) || !(pvMax > 0)) return [];
  const inside = (anchors || [])
    .filter((a) => a && Number.isFinite(a.src) && Number.isFinite(a.pv))
    .filter((a) => a.src > 0 && a.src < srcMax && a.pv > 0 && a.pv < pvMax)
    .map((a) => ({ src: a.src, pv: a.pv }))
    .sort((a, b) => a.src - b.src || a.pv - b.pv);
  const pairs = [{ src: 0, pv: 0 }];
  for (const a of inside) {
    const last = pairs[pairs.length - 1];
    if (a.src > last.src && a.pv > last.pv) pairs.push(a);
  }
  pairs.push({ src: srcMax, pv: pvMax });
  return pairs;
}

/**
 * Maps a scroll offset of one pane to the other through the anchor pairs.
 * @param {Array<{src: number, pv: number}>} pairs  from buildScrollPairs()
 * @param {number} value  scroll offset in the `from` pane
 * @param {'src'|'pv'} from
 * @param {'src'|'pv'} to
 * @returns {number}
 */
export function mapScroll(pairs, value, from, to) {
  if (!pairs || pairs.length < 2) return 0;
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  const v = Math.min(last[from], Math.max(first[from], Number(value) || 0));
  for (let i = 0; i < pairs.length - 1; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (v > b[from]) continue;
    const span = b[from] - a[from];
    if (!(span > 0)) return a[to];
    return a[to] + ((v - a[from]) / span) * (b[to] - a[to]);
  }
  return last[to];
}

/**
 * DOM part: keeps CodeMirror and the Preview pane in step in the Live layout.
 * Independent of the minimap (it used to live there, so with the map closed
 * the panes scrolled on their own).
 *
 * Echo guard by VALUE, not by timer: after writing a pane we remember where it
 * actually landed; a scroll event at that position (+-1px) is our own echo and
 * is ignored, any other position is the user and makes that pane the source.
 * A pane still animating (smooth wheel, touchpad inertia) stays the source
 * while it moves, and the pane under the mouse takes over as soon as it moves.
 * @param {object} cm CodeMirror 5 instance
 * @param {{getPreviewEl: () => HTMLElement|null, isActive: () => boolean}} opts
 * @returns {{refresh: () => void, destroy: () => void}}
 */
export function createScrollSync(cm, opts = {}) {
  const getPreviewEl = typeof opts.getPreviewEl === 'function' ? opts.getPreviewEl : () => null;
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true;
  let boundPv = null;
  const writtenCm = [];
  const writtenPv = [];
  const GLIDE_FRACTION = 0.35;
  let glide = null; // { pane: 'pv' | 'cm', target }
  let frame = 0;
  const raf = typeof opts.raf === 'function' ? opts.raf
    : typeof requestAnimationFrame === 'function' ? (f) => requestAnimationFrame(f) : (f) => setTimeout(f, 16);
  const caf = typeof opts.caf === 'function' ? opts.caf
    : typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);
  let lastSrcMax = 0;
  let lastPvMax = 0;
  let headingsKey = null;
  let headingsCache = [];
  let destroyed = false;

  function previewEl() {
    try {
      const el = getPreviewEl();
      return el && el.isConnected ? el : null;
    } catch (_) { return null; }
  }

  // EasyMDE replaces the preview element on layout switches: re-bind to the
  // current one and always unbind from the element we were really bound to.
  function bind() {
    const el = previewEl();
    if (el === boundPv) return;
    if (boundPv) boundPv.removeEventListener('scroll', onPv);
    boundPv = el;
    writtenPv.length = 0;
    if (boundPv) boundPv.addEventListener('scroll', onPv, { passive: true });
  }

  // A range that jumped by more than 10% means the pane re-rendered (an image
  // loaded): skip one step instead of syncing across two different layouts.
  function drifted(prev, next) {
    return prev > 0 && Math.abs(next - prev) > prev * 0.1;
  }

  function sourceHeadings() {
    const key = typeof cm.changeGeneration === 'function' ? cm.changeGeneration() : null;
    if (key === null || key !== headingsKey) {
      headingsCache = parseHeadingOutline(cm.getValue());
      headingsKey = key;
    }
    return headingsCache;
  }

  // Pairs of scroll offsets showing the same content in both panes. An image
  // gives two: top of its line <-> top of the image, bottom of the line <->
  // bottom of the image. Headings only when both panes have the same count.
  function anchors(pv) {
    const out = [];
    const base = pv.getBoundingClientRect().top - pv.scrollTop;
    const lineCount = cm.lineCount();
    for (const img of pv.querySelectorAll('img[data-md-line]')) {
      const line = parseInt(img.getAttribute('data-md-line'), 10);
      if (!(line >= 0 && line < lineCount)) continue;
      const r = (img.closest('.md-img-wrap') || img).getBoundingClientRect();
      if (!(r.bottom > r.top)) continue;
      out.push({ src: cm.heightAtLine(line, 'local'), pv: r.top - base });
      out.push({ src: cm.heightAtLine(line + 1, 'local'), pv: r.bottom - base });
    }
    const heads = pv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (heads.length) {
      const items = sourceHeadings();
      if (items.length === heads.length) {
        items.forEach((it, i) => {
          out.push({ src: cm.heightAtLine(it.line, 'local'), pv: heads[i].getBoundingClientRect().top - base });
        });
      }
    }
    return out;
  }

  // The FOLLOWING pane glides: each frame it moves GLIDE_FRACTION of the
  // remaining distance (at least 1px) instead of leaping. An image is one line
  // in Source but hundreds of pixels in Preview, so a leap was a visible jolt.
  // Every position we write is remembered: its scroll event is our own echo,
  // any other position is the user, who takes over at once.
  function glideTo(pane, target, current) {
    if (Math.abs(target - current) <= 1) {
      if (glide && glide.pane === pane) glide = null;
      return;
    }
    glide = { pane, target };
    if (!frame) frame = raf(step);
  }

  function stopGlide() {
    glide = null;
    if (frame) {
      try { caf(frame); } catch (_) { /* already ran */ }
      frame = 0;
    }
  }

  function step() {
    frame = 0;
    if (destroyed || !glide) return;
    const pv = boundPv;
    if (!isActive() || (glide.pane === 'pv' && !pv)) { glide = null; return; }
    const onPvPane = glide.pane === 'pv';
    const cur = onPvPane ? pv.scrollTop : cm.getScrollInfo().top;
    const rest = glide.target - cur;
    const done = Math.abs(rest) <= 1;
    const move = rest * GLIDE_FRACTION;
    const next = done ? glide.target : cur + (Math.abs(move) < 1 ? Math.sign(rest) : move);
    let after;
    if (onPvPane) {
      pv.scrollTop = next;
      after = pv.scrollTop;
      remember(writtenPv, after);
    } else {
      cm.scrollTo(null, next);
      after = cm.getScrollInfo().top;
      remember(writtenCm, after);
    }
    if (done || Math.abs(after - cur) < 0.5) { glide = null; return; }
    frame = raf(step);
  }

  function remember(list, pos) {
    list.push(pos);
    if (list.length > 4) list.shift();
  }

  // True when `pos` is one of our recent writes; drops it and anything older.
  function isEcho(list, pos) {
    const i = list.findIndex((v) => Math.abs(pos - v) <= 1);
    if (i < 0) return false;
    list.splice(0, i + 1);
    return true;
  }

  function sync(from) {
    if (destroyed || !isActive()) return;
    bind();
    const pv = boundPv;
    if (!pv) return;
    const info = cm.getScrollInfo();
    const srcMax = info.height - info.clientHeight;
    const pvMax = pv.scrollHeight - pv.clientHeight;
    if (!(srcMax > 0) || !(pvMax > 0)) return;
    if (drifted(lastSrcMax, srcMax) || drifted(lastPvMax, pvMax)) {
      lastSrcMax = srcMax;
      lastPvMax = pvMax;
      return;
    }
    lastSrcMax = srcMax;
    lastPvMax = pvMax;
    const pairs = buildScrollPairs(anchors(pv), srcMax, pvMax);
    if (from === 'src') glideTo('pv', mapScroll(pairs, info.top, 'src', 'pv'), pv.scrollTop);
    else glideTo('cm', mapScroll(pairs, pv.scrollTop, 'pv', 'src'), info.top);
  }

  function onCm() {
    if (isEcho(writtenCm, cm.getScrollInfo().top)) return;
    if (glide && glide.pane === 'cm') glide = null;
    sync('src');
  }

  function onPv() {
    if (boundPv && isEcho(writtenPv, boundPv.scrollTop)) return;
    if (glide && glide.pane === 'pv') glide = null;
    sync('pv');
  }

  cm.on('scroll', onCm);
  bind();

  return {
    refresh() {
      stopGlide();
      writtenCm.length = 0;
      writtenPv.length = 0;
      lastSrcMax = 0;
      lastPvMax = 0;
      bind();
    },
    destroy() {
      destroyed = true;
      stopGlide();
      try { cm.off('scroll', onCm); } catch (_) { /* editor already gone */ }
      if (boundPv) boundPv.removeEventListener('scroll', onPv);
      boundPv = null;
    },
  };
}
