// minimap.js
// Canvas document minimap for CodeMirror 5 (EasyMDE).
// Entire file is scaled to the panel height (VS Code–style), so the map never
// looks like the document "ended early" while the editor still has content.

/**
 * @param {object} cm CodeMirror instance
 * @param {HTMLCanvasElement} canvasEl
 * @param {{ width?: number, colors?: object, getPreviewEl?: () => HTMLElement|null, isPreviewActive?: () => boolean }} [opts]
 * getPreviewEl/isPreviewActive let the map follow the visible preview pane in
 * Preview layout, where CodeMirror itself is display:none (all its heights and
 * scroll metrics read 0, so the map would freeze and clicks would do nothing).
 */
export function createMinimap(cm, canvasEl, opts = {}) {
  const width = opts.width || 96;
  const colors = {
    bg: '#0d1117',
    text: '#8b949e',
    heading: '#58a6ff',
    code: '#3fb950',
    list: '#a371f7',
    viewport: 'rgba(88, 166, 255, 0.20)',
    viewportBorder: 'rgba(88, 166, 255, 0.65)',
    cursor: '#f0883e',
    ...(opts.colors || {}),
  };

  let destroyed = false;
  let dragging = false;
  let raf = 0;
  let paintTimer = 0;
  let boundPreview = null;
  // Scroll-sync echo guard. The browser delivers the target pane's scroll
  // event ASYNCHRONOUSLY — after our sync write already returned — so a flag
  // cleared in `finally` is always gone by then and can never swallow the
  // echo: every programmatic write bounced straight back into the opposite
  // handler (measured in prod: echoes === writes, 50-88 ping-pong alternations
  // per second) and each hop wrote again. The rules that actually terminate
  // the loop, in order of application inside each sync handler:
  //   (1) skip the OTHER direction while OUR write is still in flight: a CM
  //       write sets `expectCmEcho`; the CM handler consumes (clears) it on
  //       the very next cm scroll, and likewise for pv. The flags are cleared
  //       by consumption OR by a short rAF/timeout release, never by finally —
  //       only the flag's own echo may consume it, so a stuck flag cannot
  //       swallow unrelated user input forever;
  //   (2) never write when either pane has no scrollable range (max <= 0):
  //       ratio = top/0 was 0 (or Infinity before the zero guard), which threw
  //       the other pane to the document start — the `pvMax: 0` case that threw
  //       CM from mid-document to 0 in the field capture;
  //   (3) skip the step when a max jumped materially since the last stable
  //       sample (EasyMDE re-render / async image resolve shrinks pv.scrollHeight
  //       mid-scroll, the browser clamps scrollTop to the new bottom, and the
  //       bogus ratio 1.0 dragged everything to the document end — the reported
  //       bug; caught here as a ~2x pvMax swing);
  //   (4) skip-if-already-close: if the target lies within 1px of where the
  //       pane already sits, do not write at all — no new scroll event, the
  //       feedback chain dies structurally instead of amplifying subpixel drift.
  let expectCmEcho = false;
  let expectPvEcho = false;
  let releaseTimer = 0;
  let lastCmMax = 0;
  let lastPvMax = 0;
  let cmScrollHandler = null;
  let pvScrollHandler = null;
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => schedulePaint())
    : null;

  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  // In Preview layout CodeMirror is display:none (all its heights/scroll read
  // 0) while .editor-preview-side is the visible scroller. The map then follows
  // that pane for viewport + click-to-scroll instead of the hidden editor.
  const getPreviewEl = typeof opts.getPreviewEl === 'function' ? opts.getPreviewEl : () => null;
  const isPreviewActive = typeof opts.isPreviewActive === 'function' ? opts.isPreviewActive : () => false;
  function previewEl() {
    try {
      const el = getPreviewEl();
      return el && el.isConnected ? el : null;
    } catch (_) { return null; }
  }
  function inPreviewMode() {
    try { return !!isPreviewActive() && !!previewEl(); }
    catch (_) { return false; }
  }
  function bindPreview() {
    const el = previewEl();
    if (el === boundPreview) return;
    if (boundPreview) {
      try { boundPreview.removeEventListener('scroll', schedulePaint); } catch (_) {}
      try { if (ro) ro.unobserve(boundPreview); } catch (_) {}
    }
    boundPreview = el;
    if (boundPreview) {
      boundPreview.addEventListener('scroll', schedulePaint, { passive: true });
      try { if (ro) ro.observe(boundPreview); } catch (_) {}
    }
  }

  // Keep CodeMirror and the visible preview pane scrolled to the same relative
  // position. EasyMDE's built-in sync is disabled (it divides by scrollHeight
  // minus clientHeight with no zero guard → Infinity during relayout), so the
  // minimap owns scroll sync instead. Echo guard uses per-direction flags that
  // survive the async delivery window: each handler swallows ONLY the echo of
  // its own opposite-direction write (consumed once or released via rAF, never
  // cleared in finally), so user input on either pane always flows through.
  // A skipped (already-close or unstable) write arms no flag and fires no
  // event, which is exactly what breaks the write→echo→write feedback loop.
  function releaseEchoSoon() {
    try { if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; } } catch (_) {}
    try {
      releaseTimer = setTimeout(() => {
        releaseTimer = 0;
        expectCmEcho = false;
        expectPvEcho = false;
      }, 120);
    } catch (_) {}
  }

  // Drifts beyond 10% cannot come from scrolling (scrolling moves tops, not
  // heights): the pane content re-rendered mid-gesture. Syncing a ratio across
  // two different content heights is how a mid-document position became
  // ratio~1 and threw everything to the document end — skip the step and
  // resync from the new stable snapshot on the next event.
  function metricDrifted(prev, next) {
    if (!(prev > 0) || !(next > 0)) return false;
    return Math.abs(next - prev) > prev * 0.1;
  }

  function syncCmToPreview() {
    // CM echo of our own pv->cm write: consume (clear) and swallow.
    if (expectCmEcho) { expectCmEcho = false; return; }
    const pv = previewEl();
    if (!pv) return;
    try {
      const info = cm.getScrollInfo();
      const max = info.height - info.clientHeight;
      const pvMax = pv.scrollHeight - pv.clientHeight;
      if (max <= 0 || pvMax <= 0) return; // empty pane: ratio would be 0/Infinity
      if (metricDrifted(lastCmMax, max) || metricDrifted(lastPvMax, pvMax)) {
        lastCmMax = max; lastPvMax = pvMax;
        return; // relayout in progress: skip one step, resync from the new max
      }
      lastCmMax = max; lastPvMax = pvMax;
      const ratio = Math.min(1, Math.max(0, info.top / max));
      const target = Math.min(Math.max(0, ratio * pvMax), pvMax);
      if (Math.abs(target - pv.scrollTop) <= 1) return; // already there: no write, no echo
      pv.scrollTop = target;
      expectPvEcho = true;
      releaseEchoSoon();
    } finally {
      schedulePaint();
    }
  }

  function syncPreviewToCm() {
    // PV echo of our own cm->pv write: consume (clear) and swallow.
    if (expectPvEcho) { expectPvEcho = false; return; }
    const pv = previewEl();
    if (!pv) return;
    try {
      const pvMax = pv.scrollHeight - pv.clientHeight;
      const info = cm.getScrollInfo();
      const max = info.height - info.clientHeight;
      if (max <= 0 || pvMax <= 0) return; // empty pane: ratio would be 0/Infinity
      if (metricDrifted(lastPvMax, pvMax) || metricDrifted(lastCmMax, max)) {
        lastPvMax = pvMax; lastCmMax = max;
        return; // relayout in progress: skip one step, resync from the new max
      }
      lastPvMax = pvMax; lastCmMax = max;
      const ratio = Math.min(1, Math.max(0, pv.scrollTop / pvMax));
      const target = Math.max(0, Math.min(ratio * max, max));
      if (Math.abs(target - info.top) <= 1) return; // already there: no write, no echo
      cm.scrollTo(null, target);
      expectCmEcho = true;
      releaseEchoSoon();
    } finally {
      schedulePaint();
    }
  }

  function bindScrollSync() {
    // Re-bind on every refresh() so a mode switch that swaps the preview pane
    // does not leave stale listeners on the old element, and so we never add
    // the same listener twice.
    if (cmScrollHandler) { try { cm.off('scroll', cmScrollHandler); } catch (_) {} cmScrollHandler = null; }
    if (pvScrollHandler && boundPreview) { try { boundPreview.removeEventListener('scroll', pvScrollHandler); } catch (_) {} pvScrollHandler = null; }

    cmScrollHandler = syncCmToPreview;
    cm.on('scroll', cmScrollHandler);

    const pv = previewEl();
    if (pv) {
      pvScrollHandler = syncPreviewToCm;
      pv.addEventListener('scroll', pvScrollHandler, { passive: true });
    }
  }

  function resizeCanvas(cssW, cssH) {
    const ratio = dpr();
    const bw = Math.max(1, Math.floor(cssW * ratio));
    const bh = Math.max(1, Math.floor(cssH * ratio));
    if (canvasEl.width !== bw || canvasEl.height !== bh) {
      canvasEl.width = bw;
      canvasEl.height = bh;
    }
    canvasEl.style.width = cssW + 'px';
    canvasEl.style.height = cssH + 'px';
    return ratio;
  }

  function schedulePaint() {
    if (destroyed) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  }

  function schedulePaintDebounced() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(schedulePaint, 50);
  }

  function lineStyle(lineText) {
    const t = lineText || '';
    if (/^\s*#{1,6}\s/.test(t)) return colors.heading;
    if (/^\s*```/.test(t)) return colors.code;
    if (/^\s{4,}\S/.test(t)) return colors.code;
    if (/^\s*([-*+]|\d+\.)\s/.test(t)) return colors.list;
    return colors.text;
  }

  function paint() {
    if (destroyed || !cm) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const parent = canvasEl.parentElement;
    const cssW = width;
    const cssH = Math.max(1, parent ? parent.clientHeight : 200);
    const ratio = resizeCanvas(cssW, cssH);

    const w = canvasEl.width;
    const h = canvasEl.height;
    const lineCount = Math.max(1, cm.lineCount());

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Fit ALL lines into the panel height — never leave a false "empty tail".
    const rowH = h / lineCount;

    for (let i = 0; i < lineCount; i++) {
      const text = cm.getLine(i) || '';
      if (!text.trim()) continue;
      const density = Math.min(1, text.trim().length / 72);
      const barW = Math.max(2 * ratio, Math.floor((0.12 + density * 0.78) * w));
      const y = i * rowH;
      const bh = Math.max(ratio, rowH * 0.9);
      ctx.fillStyle = lineStyle(text);
      ctx.globalAlpha = 0.5 + density * 0.4;
      ctx.fillRect(3 * ratio, y, barW, bh);
    }
    ctx.globalAlpha = 1;

    // Viewport: in Preview mode CodeMirror is hidden (its scroll metrics read
    // 0), so derive the rectangle from the visible preview pane instead.
    bindPreview();
    let vpTop;
    let vpH;
    if (inPreviewMode()) {
      const pv = previewEl();
      const max = Math.max(1, pv.scrollHeight - pv.clientHeight);
      const frac = max > 0 ? Math.max(0, Math.min(1, pv.scrollTop / max)) : 0;
      const visFrac = pv.scrollHeight > 0
        ? Math.max(0.02, Math.min(1, pv.clientHeight / pv.scrollHeight))
        : 1;
      vpH = Math.max(6 * ratio, visFrac * h);
      vpTop = frac * Math.max(0, h - vpH);
    } else {
      // Viewport from visible lines (works with wrap + partial scrolls)
      let first = 0;
      let last = lineCount - 1;
      try {
        const scroll = cm.getScrollInfo();
        first = cm.lineAtHeight(scroll.top, 'local');
        last = cm.lineAtHeight(scroll.top + scroll.clientHeight, 'local');
        if (typeof first !== 'number' || first < 0) first = 0;
        if (typeof last !== 'number' || last < first) last = Math.min(lineCount - 1, first + 20);
      } catch (_) {
        first = 0;
        last = Math.min(lineCount - 1, 30);
      }
      vpTop = (first / lineCount) * h;
      vpH = Math.max(6 * ratio, ((last - first + 1) / lineCount) * h);
    }

    ctx.fillStyle = colors.viewport;
    ctx.fillRect(0, vpTop, w, vpH);
    ctx.strokeStyle = colors.viewportBorder;
    ctx.lineWidth = Math.max(1, ratio);
    ctx.strokeRect(0.5 * ratio, vpTop, w - ratio, Math.max(ratio, vpH));

    // Cursor
    try {
      const cur = cm.getCursor();
      const cy = ((cur.line + 0.5) / lineCount) * h;
      ctx.fillStyle = colors.cursor;
      ctx.fillRect(0, cy - ratio, w, 2 * ratio);
    } catch (_) { /* ignore */ }
  }

  /** Map pointer Y on the canvas to a document line and centre the viewport there. */
  function scrollToClientY(clientY) {
    const rect = canvasEl.getBoundingClientRect();
    const y = clientY - rect.top;
    const cssH = Math.max(1, rect.height);
    const ratioY = Math.max(0, Math.min(1, y / cssH));
    // In Preview the visible pane wins; CodeMirror is hidden and cm.scrollTo
    // would move nothing on screen. Scroll both: the preview for display and
    // the editor (best effort) so Source/Live land where the user pointed.
    if (inPreviewMode()) {
      const pv = previewEl();
      if (pv) {
        const max = Math.max(0, pv.scrollHeight - pv.clientHeight);
        syncingPvToCm = true;
        pv.scrollTop = ratioY * max;
        syncingPvToCm = false;
      }
      syncingCmToPv = true;
      try {
        const lineCount = Math.max(1, cm.lineCount());
        const line = Math.min(lineCount - 1, Math.floor(ratioY * lineCount));
        const scroll = cm.getScrollInfo();
        const lineTop = cm.heightAtLine(line, 'local');
        const target = lineTop - scroll.clientHeight / 3;
        cm.scrollTo(null, Math.max(0, target));
      } catch (_) { /* hidden editor — preview scroll is what matters */ }
      syncingCmToPv = false;
      schedulePaint();
      return;
    }
    const lineCount = Math.max(1, cm.lineCount());
    const line = Math.min(lineCount - 1, Math.floor(ratioY * lineCount));

    try {
      const scroll = cm.getScrollInfo();
      const lineTop = cm.heightAtLine(line, 'local');
      const target = lineTop - scroll.clientHeight / 3;
      cm.scrollTo(null, Math.max(0, target));
    } catch (_) {
      try {
        cm.setCursor({ line, ch: 0 });
        cm.scrollIntoView({ line, ch: 0 }, 80);
      } catch (__) {}
    }
    schedulePaint();
  }

  function onPointerDown(e) {
    e.preventDefault();
    dragging = true;
    try { canvasEl.setPointerCapture(e.pointerId); } catch (_) {}
    scrollToClientY(e.clientY);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    scrollToClientY(e.clientY);
  }
  function onPointerUp(e) {
    dragging = false;
    try { canvasEl.releasePointerCapture(e.pointerId); } catch (_) {}
  }

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);

  cm.on('scroll', schedulePaint);
  cm.on('viewportChange', schedulePaint);
  cm.on('change', schedulePaintDebounced);
  cm.on('cursorActivity', schedulePaintDebounced);

  // The HTML height handshake grows the iframe WITHOUT any scroll event, which
  // changes the pane's scrollHeight and therefore the viewport rectangle —
  // repaint when a frame reports its new height.
  function onFrameHeightMessage(e) {
    if (e && e.data && e.data.type === 'md-editor-frame-height') schedulePaint();
  }
  window.addEventListener('message', onFrameHeightMessage);

  if (ro && canvasEl.parentElement) ro.observe(canvasEl.parentElement);
  bindPreview();
  bindScrollSync();

  schedulePaint();

  return {
    refresh() {
      bindPreview();
      bindScrollSync();
      schedulePaint();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      clearTimeout(paintTimer);
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointercancel', onPointerUp);
      try { cm.off('scroll', schedulePaint); } catch (_) {}
      try { cm.off('viewportChange', schedulePaint); } catch (_) {}
      try { cm.off('change', schedulePaintDebounced); } catch (_) {}
      try { cm.off('cursorActivity', schedulePaintDebounced); } catch (_) {}
      try { window.removeEventListener('message', onFrameHeightMessage); } catch (_) {}
      if (boundPreview) {
        try { boundPreview.removeEventListener('scroll', schedulePaint); } catch (_) {}
        try { if (ro) ro.unobserve(boundPreview); } catch (_) {}
        boundPreview = null;
      }
      if (cmScrollHandler) { try { cm.off('scroll', cmScrollHandler); } catch (_) {} cmScrollHandler = null; }
      const curPv = previewEl();
      if (curPv && pvScrollHandler) {
        try { curPv.removeEventListener('scroll', pvScrollHandler); } catch (_) {}
      }
      pvScrollHandler = null;
      if (ro) ro.disconnect();
    },
  };
}

