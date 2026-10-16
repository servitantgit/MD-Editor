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
  // Programmatic scroll guard: prevents scroll listeners from fighting a
  // programmatic scroll we just issued (scroll-to on minimap click/drag).
  let programmaticScroll = 0;
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => schedulePaint())
    : null;

  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  // In Preview layout CodeMirror is display:none (all its heights/scroll read
  // 0) while .editor-preview-side is the visible scroller. The map then follows
  // that pane for viewport + click-to-scroll instead of the hidden editor.
  const getPreviewEl = typeof opts.getPreviewEl === 'function' ? opts.getPreviewEl : () => null;
  const isPreviewActive = typeof opts.isPreviewActive === 'function' ? opts.isPreviewActive : () => false;
  const isSplitActive = typeof opts.isSplit === 'function' ? opts.isSplit : () => false;
  // Scroll-sync guard with async release: cm.scrollTo() / pv.scrollTop fire
  // their scroll events ASYNC (next tick / rAF). Clearing the guard in a
  // finally{} releases it BEFORE those events arrive, so the follower's event
  // is mistaken for a user scroll and writes back with rounding error —
  // the pair then ping-pongs and converges to the bottom ("throws down").
  // Guard is released on rAF/timeout instead, after both events land.
  let syncingScroll = 0;
  function guardSync(fn) {
    syncingScroll++;
    try { fn(); } finally {
      const release = () => { syncingScroll = Math.max(0, syncingScroll - 1); };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(release, 0));
      } else {
        setTimeout(release, 0);
      }
    }
  }
  function onCMScroll() {
    if (programmaticScroll || syncingScroll) { return; }
    if (isSplitActive()) {
      try { syncFromCM(); } catch (_) { /* ignore */ }
    }
    schedulePaint();
  }
  function onPreviewScroll() {
    if (programmaticScroll || syncingScroll) { return; }
    if (isSplitActive()) {
      try { syncFromPreview(); } catch (_) { /* ignore */ }
    }
    schedulePaint();
  }
  function cmRatio() {
    const s = cm.getScrollInfo();
    const max = Math.max(1, s.height - s.clientHeight);
    return Math.min(1, Math.max(0, s.top / max));
  }
  function pvRatio(pv) {
    const max = Math.max(1, pv.scrollHeight - pv.clientHeight);
    return Math.min(1, Math.max(0, pv.scrollTop / max));
  }
  // Epsilon: skip the write when the follower is already there, so rounding
  // between different content heights cannot start a ping-pong.
  function syncFromCM() {
    const pv = previewEl();
    if (!pv) return;
    const max = Math.max(0, pv.scrollHeight - pv.clientHeight);
    if (max <= 0) return;
    const target = cmRatio() * max;
    if (Math.abs(pv.scrollTop - target) < 2) return;
    guardSync(() => { pv.scrollTop = target; });
  }
  function syncFromPreview() {
    const pv = previewEl();
    if (!pv) return;
    const ratio = pvRatio(pv);
    const s = cm.getScrollInfo();
    const max = Math.max(1, s.height - s.clientHeight);
    const target = ratio * max;
    if (Math.abs(s.top - target) < 2) return;
    guardSync(() => { cm.scrollTo(null, target); });
  }
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
      try { boundPreview.removeEventListener('scroll', onPreviewScroll); } catch (_) {}
      try { if (ro) ro.unobserve(boundPreview); } catch (_) {}
    }
    boundPreview = el;
    if (boundPreview) {
      boundPreview.addEventListener('scroll', onPreviewScroll, { passive: true });
      try { if (ro) ro.observe(boundPreview); } catch (_) {}
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
    // Click/drag scrolls the visible scroller(s). In Live (split) BOTH panes
    // move together to the same fraction; writes go through guardSync() and
    // the guard releases ASYNC (scroll events arrive a tick later), so the
    // follower's event cannot bounce back with rounding error ("throws down").
    programmaticScroll++;
    try {
      if (isSplitActive()) {
        const pv = previewEl();
        if (pv) {
          const max = Math.max(0, pv.scrollHeight - pv.clientHeight);
          if (max > 0) { syncingScroll++; try { pv.scrollTop = ratioY * max; } finally { asyncRelease(); } }
        }
        const lineCount = Math.max(1, cm.lineCount());
        const line = Math.min(lineCount - 1, Math.floor(ratioY * lineCount));
        const scroll = cm.getScrollInfo();
        const lineTop = cm.heightAtLine(line, 'local');
        const target = lineTop - scroll.clientHeight / 3;
        syncingScroll++; try { cm.scrollTo(null, Math.max(0, target)); } finally { asyncRelease(); }
      } else if (inPreviewMode()) {
        const pv = previewEl();
        if (pv) {
          const max = Math.max(0, pv.scrollHeight - pv.clientHeight);
          pv.scrollTop = ratioY * max;
        }
      } else {
        const lineCount = Math.max(1, cm.lineCount());
        const line = Math.min(lineCount - 1, Math.floor(ratioY * lineCount));
        const scroll = cm.getScrollInfo();
        const lineTop = cm.heightAtLine(line, 'local');
        const target = lineTop - scroll.clientHeight / 3;
        cm.scrollTo(null, Math.max(0, target));
      }
    } catch (_) {
      const fallbackLine = Math.min(Math.max(1, cm.lineCount()) - 1, Math.floor(ratioY * cm.lineCount()));
      try {
        cm.setCursor({ line: fallbackLine, ch: 0 });
        cm.scrollIntoView({ line: fallbackLine, ch: 0 }, 80);
      } catch (__) { /* ignore */ }
    } finally {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(() => { programmaticScroll = Math.max(0, programmaticScroll - 1); }, 0));
      } else {
        setTimeout(() => { programmaticScroll = Math.max(0, programmaticScroll - 1); }, 0);
      }
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

  cm.on('scroll', onCMScroll);
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

  schedulePaint();

  return {
    refresh() {
      bindPreview();
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
      try { cm.off('scroll', onCMScroll); } catch (_) {}
      try { cm.off('viewportChange', schedulePaint); } catch (_) {}
      try { cm.off('change', schedulePaintDebounced); } catch (_) {}
      try { cm.off('cursorActivity', schedulePaintDebounced); } catch (_) {}
      try { window.removeEventListener('message', onFrameHeightMessage); } catch (_) {}
      if (boundPreview) {
        try { boundPreview.removeEventListener('scroll', onPreviewScroll); } catch (_) {}
        try { if (ro) ro.unobserve(boundPreview); } catch (_) {}
        boundPreview = null;
      }
      if (ro) ro.disconnect();
    },
  };
}
