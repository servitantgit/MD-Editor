// minimap.js
// Canvas document minimap for CodeMirror 5 (EasyMDE).
// Shows a scaled overview of the file; click / drag scrolls the editor.

/**
 * @param {object} cm CodeMirror instance
 * @param {HTMLCanvasElement} canvasEl
 * @param {{ width?: number, scale?: number, colors?: object }} [opts]
 */
export function createMinimap(cm, canvasEl, opts = {}) {
  const width = opts.width || 96;
  const lineH = opts.lineH || 2; // px per source line in the map
  const colors = {
    bg: opts.colors?.bg || '#0d1117',
    text: opts.colors?.text || '#8b949e',
    heading: opts.colors?.heading || '#58a6ff',
    code: opts.colors?.code || '#3fb950',
    viewport: opts.colors?.viewport || 'rgba(88, 166, 255, 0.22)',
    viewportBorder: opts.colors?.viewportBorder || 'rgba(88, 166, 255, 0.55)',
    cursor: opts.colors?.cursor || '#f0883e',
    ...opts.colors,
  };

  let destroyed = false;
  let dragging = false;
  let raf = 0;
  let paintTimer = 0;

  canvasEl.width = width;
  canvasEl.style.width = width + 'px';

  function schedulePaint() {
    if (destroyed) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  }

  function schedulePaintDebounced() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(schedulePaint, 40);
  }

  function lineStyle(lineText) {
    const t = lineText || '';
    if (/^\s*#{1,6}\s/.test(t)) return colors.heading;
    if (/^\s*```/.test(t) || /^\s{4,}\S/.test(t)) return colors.code;
    if (/^\s*([-*+]|\d+\.)\s/.test(t)) return colors.text;
    return colors.text;
  }

  function paint() {
    if (destroyed || !cm) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const lineCount = cm.lineCount();
    const mapH = Math.max(1, Math.ceil(lineCount * lineH));
    const viewH = canvasEl.parentElement
      ? Math.max(1, canvasEl.parentElement.clientHeight)
      : mapH;

    // Canvas height = max(viewport, content) so short docs still fill the strip
    const cssH = Math.max(viewH, Math.min(mapH, viewH * 4));
    if (canvasEl.height !== cssH) {
      canvasEl.height = cssH;
      canvasEl.style.height = cssH + 'px';
    }

    const w = canvasEl.width;
    const h = canvasEl.height;

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Scale so the whole document fits in the canvas height when possible
    const scaleY = mapH > h ? h / mapH : 1;
    const drawnLineH = lineH * scaleY;

    for (let i = 0; i < lineCount; i++) {
      const text = cm.getLine(i) || '';
      if (!text.trim()) continue;
      const y = i * drawnLineH;
      if (y > h) break;
      // Approximate line width by non-space density
      const density = Math.min(1, text.trim().length / 80);
      const barW = Math.max(2, Math.floor(w * 0.15 + density * w * 0.75));
      ctx.fillStyle = lineStyle(text);
      ctx.globalAlpha = 0.55 + density * 0.35;
      ctx.fillRect(4, y, barW, Math.max(1, drawnLineH * 0.85));
    }
    ctx.globalAlpha = 1;

    // Viewport rectangle
    const scroll = cm.getScrollInfo();
    const totalH = Math.max(1, scroll.height);
    const visible = scroll.clientHeight;
    const topRatio = scroll.top / totalH;
    const heightRatio = visible / totalH;
    const vpTop = topRatio * h;
    const vpH = Math.max(8, heightRatio * h);

    ctx.fillStyle = colors.viewport;
    ctx.fillRect(0, vpTop, w, vpH);
    ctx.strokeStyle = colors.viewportBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpTop + 0.5, w - 1, Math.max(1, vpH - 1));

    // Cursor line
    try {
      const cur = cm.getCursor();
      const cy = (cur.line / Math.max(1, lineCount)) * h;
      ctx.fillStyle = colors.cursor;
      ctx.fillRect(0, cy, w, 2);
    } catch (_) { /* ignore */ }
  }

  function scrollToY(clientY) {
    const rect = canvasEl.getBoundingClientRect();
    const y = clientY - rect.top;
    const h = canvasEl.height || 1;
    const ratio = Math.max(0, Math.min(1, y / h));
    const scroll = cm.getScrollInfo();
    const maxTop = Math.max(0, scroll.height - scroll.clientHeight);
    cm.scrollTo(null, ratio * maxTop);
    schedulePaint();
  }

  function onPointerDown(e) {
    e.preventDefault();
    dragging = true;
    canvasEl.setPointerCapture?.(e.pointerId);
    scrollToY(e.clientY);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    scrollToY(e.clientY);
  }
  function onPointerUp(e) {
    dragging = false;
    try { canvasEl.releasePointerCapture?.(e.pointerId); } catch (_) {}
  }

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);

  cm.on('scroll', schedulePaint);
  cm.on('viewportChange', schedulePaint);
  cm.on('change', schedulePaintDebounced);
  cm.on('cursorActivity', schedulePaintDebounced);

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => schedulePaint())
    : null;
  if (ro && canvasEl.parentElement) ro.observe(canvasEl.parentElement);

  schedulePaint();

  return {
    refresh: schedulePaint,
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
      if (ro) ro.disconnect();
    },
  };
}
