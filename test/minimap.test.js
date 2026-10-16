// minimap.test.js
// Preview layout hides CodeMirror (display:none), so the minimap must follow
// the visible preview pane there — viewport rectangle + click-to-scroll — while
// Source follows CodeMirror; Live follows whichever pane the user scrolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function makeCm(lineCount = 100) {
  const handlers = {};
  return {
    handlers,
    on(e, fn) { (handlers[e] ||= []).push(fn); },
    off(e, fn) { handlers[e] = (handlers[e] || []).filter((f) => f !== fn); },
    lineCount: () => lineCount,
    getLine: () => 'some text content here',
    getScrollInfo: () => ({ top: 0, clientHeight: 0 }),
    lineAtHeight: () => 0,
    heightAtLine: () => 0,
    scrollToCalls: [],
    scrollTo(x, y) { this.scrollToCalls.push([x, y]); },
    getCursor: () => ({ line: 0, ch: 0 }),
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><body><div id="wrap"><canvas id="map"></canvas></div><div id="pv"></div></body>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const rafQueue = [];
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => { rafQueue.length = 0; };
  return { dom, rafQueue };
}

// jsdom has no canvas 2d context — record the calls paint() makes instead.
function stubContext(canvas) {
  const calls = [];
  const ctx = {
    __calls: calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    setTransform() {},
    fillRect(x, y, w, h) { calls.push({ m: 'fillRect', x, y, w, h }); },
    strokeRect(x, y, w, h) { calls.push({ m: 'strokeRect', x, y, w, h }); },
  };
  canvas.getContext = () => ctx;
  return ctx;
}

test('in Preview mode viewport follows the preview pane scroll, not CodeMirror', async () => {
  const { dom, rafQueue } = installDom();
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  const canvas = dom.window.document.getElementById('map');
  const wrap = canvas.parentElement;
  const pv = dom.window.document.getElementById('pv');
  // jsdom has no layout: stub the scroller metrics the map reads.
  Object.defineProperty(pv, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(wrap, 'clientHeight', { value: 200, configurable: true });
  pv.scrollTop = 1500; // bottom

  const ctx = stubContext(canvas);
  createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => true,
  });
  rafQueue.forEach((fn) => fn());

  const calls = ctx.__calls || [];
  // paint order: full-width bg, then per-line bars (x > 0), then full-width
  // viewport + cursor. Never assume fills[1] is the viewport — line bars land first.
  const fullWidth = calls.filter((c) => c.m === 'fillRect' && c.x === 0);
  assert.ok(
    fullWidth.length >= 3,
    `expected bg + viewport + cursor full-width fills, got ${JSON.stringify(fullWidth)}`
  );
  const vp = fullWidth[1];
  // Fully scrolled to the bottom: viewport rect must sit at the bottom of the map.
  assert.ok(
    vp.y + vp.h >= canvas.height - 1,
    `viewport should be at bottom, got y=${vp.y} h=${vp.h} canvasH=${canvas.height}`
  );
});

test('in Preview mode a click scrolls the preview pane', async () => {
  const { dom, rafQueue } = installDom();
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  const canvas = dom.window.document.getElementById('map');
  const pv = dom.window.document.getElementById('pv');
  Object.defineProperty(pv, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 200, configurable: true });
  pv.scrollTop = 0;

  stubContext(canvas);
  createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => true,
  });
  rafQueue.forEach((fn) => fn());

  canvas.getBoundingClientRect = () => ({ top: 0, height: 200, left: 0, width: 96 });
  canvas.setPointerCapture = () => {};
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientY: 200 }));
  // Click at the very bottom → max scroll of the preview pane.
  assert.equal(pv.scrollTop, 1500, 'preview pane should scroll to the clicked fraction');
  // Only the visible preview pane is scrolled; hidden CodeMirror is not touched
  // to avoid scroll feedback loops between the two panes.
  assert.equal(cm.scrollToCalls.length, 0, 'hidden editor is not scrolled in Preview mode');
});

test('in Live (split) mode CM scroll syncs preview pane to same fraction', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="wrap"><canvas id="map"></canvas></div><div id="pv"></div></body>').window.document;
  globalThis.window = dom.defaultView || globalThis.window;
  globalThis.document = dom;
  const rafQueue = [];
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => { rafQueue.length = 0; };
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  // CM scrolled to 50%: top=500 of max=1000.
  cm.getScrollInfo = () => ({ top: 500, height: 1400, clientHeight: 400 });
  const canvas = dom.getElementById('map');
  const pv = dom.getElementById('pv');
  Object.defineProperty(pv, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 200, configurable: true });
  pv.scrollTop = 0;
  stubContext(canvas);
  createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => true,
    isSplit: () => true,
  });
  rafQueue.forEach((fn) => fn());
  // Fire a CM scroll event → preview must follow to ~50% (750 of max 1500).
  cm.handlers.scroll.forEach((fn) => fn());
  assert.ok(Math.abs(pv.scrollTop - 750) < 5, `preview should follow CM fraction, got ${pv.scrollTop}`);
});


test('Live mode keeps Preview as the source while delayed CodeMirror scroll events arrive', async () => {
  const { dom, rafQueue } = installDom();
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  let cmTop = 800;
  cm.getScrollInfo = () => ({ top: cmTop, height: 1400, clientHeight: 400 });
  cm.scrollTo = (_left, top) => {
    cmTop = Math.max(0, Math.min(1000, top));
    // CodeMirror's scroll event may arrive after the Preview handler returns.
    setTimeout(() => (cm.handlers.scroll || []).forEach((fn) => fn()), 15);
  };

  const canvas = dom.window.document.getElementById('map');
  const pv = dom.window.document.getElementById('pv');
  Object.defineProperty(pv, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 200, configurable: true });
  stubContext(canvas);

  const cmScroll = dom.window.document.createElement('div');
  cmScroll.className = 'CodeMirror-scroll';
  dom.window.document.body.appendChild(cmScroll);

  const map = createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => true,
    isSplit: () => true,
  });
  rafQueue.forEach((fn) => fn());

  // Scroll near the end, then quickly scroll upward. Late CM events from the
  // first movement must not overwrite the newer Preview destination.
  pv.scrollTop = 1200;
  pv.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(cmTop, 800, 'CodeMirror should follow the first Preview position');

  pv.scrollTop = 300;
  pv.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(cmTop, 200, 'CodeMirror should follow the newer upward Preview position');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pv.scrollTop, 300, 'delayed CodeMirror events must not push Preview back down');
  assert.equal(cmTop, 200, 'the editor should retain the latest Preview position');

  // Even if an intermediate CodeMirror notification reports another position,
  // Preview remains authoritative and CodeMirror is corrected toward it.
  cmTop = 560;
  cm.handlers.scroll.forEach((fn) => fn());
  assert.equal(cmTop, 200, 'an out-of-date editor position should be corrected from Preview');
  assert.equal(pv.scrollTop, 300, 'the authoritative Preview position must not change');

  // A direct user interaction in CodeMirror switches the source to the editor.
  cmScroll.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  cmTop = 700;
  cm.handlers.scroll.forEach((fn) => fn());
  assert.equal(pv.scrollTop, 1050, 'Preview should follow a new CodeMirror-originated scroll');

  map.destroy();
  dom.window.close();
});

test('Live mode minimap click scrolls both panes without an undefined async release', async () => {
  const { dom, rafQueue } = installDom();
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  cm.getScrollInfo = () => ({ top: 0, height: 1400, clientHeight: 400 });
  cm.heightAtLine = (line) => line * 14;
  const canvas = dom.window.document.getElementById('map');
  const pv = dom.window.document.getElementById('pv');
  Object.defineProperty(pv, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 200, configurable: true });
  stubContext(canvas);

  const map = createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => true,
    isSplit: () => true,
  });
  rafQueue.forEach((fn) => fn());
  canvas.getBoundingClientRect = () => ({ top: 0, height: 200, left: 0, width: 96 });
  canvas.setPointerCapture = () => {};
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientY: 150 }));

  assert.equal(pv.scrollTop, 1125, 'Preview should scroll to 75% of its range');
  assert.equal(cm.scrollToCalls.length, 1, 'CodeMirror should receive the corresponding minimap scroll');
  map.destroy();
  dom.window.close();
});

test('in Source mode a click still scrolls CodeMirror, not the preview pane', async () => {
  const { dom, rafQueue } = installDom();
  const { createMinimap } = await import('../js/minimap.js');
  const cm = makeCm();
  cm.getScrollInfo = () => ({ top: 0, clientHeight: 400 });
  cm.lineAtHeight = () => 0;
  cm.heightAtLine = () => 500;
  const canvas = dom.window.document.getElementById('map');
  const pv = dom.window.document.getElementById('pv');
  pv.scrollTop = 0;

  stubContext(canvas);
  createMinimap(cm, canvas, {
    getPreviewEl: () => pv,
    isPreviewActive: () => false,
  });
  rafQueue.forEach((fn) => fn());

  canvas.getBoundingClientRect = () => ({ top: 0, height: 200, left: 0, width: 96 });
  canvas.setPointerCapture = () => {};
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientY: 100 }));
  assert.equal(pv.scrollTop, 0, 'preview pane must stay untouched in Source mode');
  assert.equal(cm.scrollToCalls.length, 1, 'CodeMirror should receive the scroll');
});
