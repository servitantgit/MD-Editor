import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Imported inside every test: until js/scroll-sync.js exists each test fails
// on its own (ERR_MODULE_NOT_FOUND) instead of the whole file failing to load.
const load = () => import('../js/scroll-sync.js');

test('scroll sync: buildScrollPairs adds the start and the end of both panes', async () => {
  const { buildScrollPairs } = await load();
  assert.deepEqual(buildScrollPairs([], 100, 200), [{ src: 0, pv: 0 }, { src: 100, pv: 200 }]);
});

test('scroll sync: buildScrollPairs drops anchors that are out of order or out of range', async () => {
  const { buildScrollPairs } = await load();
  const anchors = [
    { src: 30, pv: 300 },
    { src: 20, pv: 100 },
    { src: 50, pv: 250 },
    { src: -5, pv: 10 },
    { src: 150, pv: 50 },
    { src: NaN, pv: 500 },
  ];
  assert.deepEqual(buildScrollPairs(anchors, 100, 1000), [
    { src: 0, pv: 0 },
    { src: 20, pv: 100 },
    { src: 30, pv: 300 },
    { src: 100, pv: 1000 },
  ]);
});

// One image: a single line in Source (40..60), 400px tall in Preview (400..800).
const IMAGE = [{ src: 40, pv: 400 }, { src: 60, pv: 800 }];

test('scroll sync: an image moves Preview through its full height while Source moves one line', async () => {
  const { buildScrollPairs, mapScroll } = await load();
  const pairs = buildScrollPairs(IMAGE, 100, 1000);
  assert.equal(mapScroll(pairs, 20, 'src', 'pv'), 200);
  assert.equal(mapScroll(pairs, 50, 'src', 'pv'), 600);
  assert.equal(mapScroll(pairs, 80, 'src', 'pv'), 900);
});

test('scroll sync: without anchors the position is a plain percentage', async () => {
  const { buildScrollPairs, mapScroll } = await load();
  const pairs = buildScrollPairs([], 200, 800);
  assert.equal(mapScroll(pairs, 50, 'src', 'pv'), 200);
});

test('scroll sync: values are clamped and an empty pane maps to 0', async () => {
  const { buildScrollPairs, mapScroll } = await load();
  const pairs = buildScrollPairs([], 200, 800);
  assert.equal(mapScroll(pairs, -10, 'src', 'pv'), 0);
  assert.equal(mapScroll(pairs, 500, 'src', 'pv'), 800);
  assert.deepEqual(buildScrollPairs([], 0, 800), []);
  assert.equal(mapScroll([], 10, 'src', 'pv'), 0);
});

test('scroll sync: Preview to Source uses the same pairs in reverse', async () => {
  const { buildScrollPairs, mapScroll } = await load();
  const pairs = buildScrollPairs(IMAGE, 100, 1000);
  assert.equal(mapScroll(pairs, 600, 'pv', 'src'), 50);
  assert.equal(mapScroll(pairs, 900, 'pv', 'src'), 80);
});

// ---- DOM part: createScrollSync (jsdom has no layout, so metrics are stubbed) ----
// Source: 200px document, 100px viewport -> range 100; heightAtLine(n) = n * 20,
// so an image on line 2 spans 40..60. Preview: 1100px content, 100px viewport
// -> range 1000; the image wrapper spans 400..800. Same numbers as above.
function setup({ active = true, image = false } = {}) {
  const dom = new JSDOM('<div id="pv"></div>');
  const pv = dom.window.document.getElementById('pv');
  Object.defineProperty(pv, 'scrollHeight', { value: 1100, configurable: true });
  Object.defineProperty(pv, 'clientHeight', { value: 100, configurable: true });
  Object.defineProperty(pv, 'scrollTop', { value: 0, writable: true, configurable: true });
  pv.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
  if (image) {
    pv.innerHTML = '<span class="md-img-wrap"><img data-md-line="2"></span>';
    const wrap = pv.querySelector('.md-img-wrap');
    wrap.getBoundingClientRect = () => ({ top: 400 - pv.scrollTop, bottom: 800 - pv.scrollTop, height: 400 });
  }
  const handlers = {};
  const cm = {
    top: 0,
    calls: [],
    on(e, f) { (handlers[e] ||= []).push(f); },
    off(e, f) { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
    getScrollInfo() { return { top: this.top, height: 200, clientHeight: 100 }; },
    scrollTo(x, y) { this.calls.push([x, y]); this.top = y; },
    heightAtLine(line) { return line * 20; },
    lineCount: () => 10,
    getValue: () => '',
  };
  // Animation frames are driven by hand: runFrame() runs one frame,
  // settle() runs frames until every glide has finished.
  const queue = new Map();
  let nextId = 1;
  const s = {
    pv,
    cm,
    active,
    raf: (f) => { const id = nextId++; queue.set(id, f); return id; },
    caf: (id) => { queue.delete(id); },
    runFrame() {
      const batch = [...queue.values()];
      queue.clear();
      batch.forEach((f) => f());
      return batch.length;
    },
    settle() { for (let i = 0; i < 200 && s.runFrame(); i++) { /* next frame */ } },
    fireCm: () => (handlers.scroll || []).forEach((f) => f()),
    firePv: () => pv.dispatchEvent(new dom.window.Event('scroll')),
  };
  return s;
}

async function start(opts) {
  const { createScrollSync } = await load();
  const s = setup(opts);
  s.sync = createScrollSync(s.cm, { getPreviewEl: () => s.pv, isActive: () => s.active, raf: s.raf, caf: s.caf });
  return s;
}

test('scroll sync DOM: scrolling Source moves Preview to the matching place', async () => {
  const s = await start();
  s.cm.top = 50;
  s.fireCm();
  s.settle();
  assert.equal(s.pv.scrollTop, 500);
  s.sync.destroy();
});

test('scroll sync DOM: the echo of our own write does not scroll Source back', async () => {
  const s = await start();
  s.cm.top = 50;
  s.fireCm();
  s.settle();
  s.firePv();
  s.settle();
  assert.equal(s.cm.calls.length, 0, 'the Preview echo must not move Source');
  s.sync.destroy();
});

test('scroll sync DOM: scrolling Preview moves Source', async () => {
  const s = await start();
  s.pv.scrollTop = 600;
  s.firePv();
  s.settle();
  assert.deepEqual(s.cm.calls[s.cm.calls.length - 1], [null, 60]);
  s.sync.destroy();
});

test('scroll sync DOM: an image is an anchor - middle of its line maps to middle of the image', async () => {
  const s = await start({ image: true });
  s.cm.top = 50;
  s.fireCm();
  s.settle();
  assert.equal(s.pv.scrollTop, 600);
  s.sync.destroy();
});

test('scroll sync DOM: nothing moves outside the Live layout', async () => {
  const s = await start({ active: false });
  s.cm.top = 50;
  s.fireCm();
  s.settle();
  assert.equal(s.pv.scrollTop, 0);
  s.pv.scrollTop = 600;
  s.firePv();
  s.settle();
  assert.equal(s.cm.calls.length, 0);
  s.sync.destroy();
});

test('scroll sync DOM: a big jump glides over several frames and lands exactly', async () => {
  const s = await start();
  s.cm.top = 50;
  s.fireCm();
  assert.equal(s.pv.scrollTop, 0, 'Preview must not leap on the scroll event itself');
  s.runFrame();
  assert.ok(s.pv.scrollTop > 0 && s.pv.scrollTop < 500, 'one frame moves part of the way, got ' + s.pv.scrollTop);
  s.settle();
  assert.equal(s.pv.scrollTop, 500);
  s.sync.destroy();
});

test('scroll sync DOM: Source glides behind Preview the same way', async () => {
  const s = await start();
  s.pv.scrollTop = 600;
  s.firePv();
  assert.equal(s.cm.calls.length, 0, 'Source must not leap on the scroll event itself');
  s.runFrame();
  assert.ok(s.cm.top > 0 && s.cm.top < 60, 'one frame moves part of the way, got ' + s.cm.top);
  s.settle();
  assert.equal(s.cm.top, 60);
  s.sync.destroy();
});

test('scroll sync DOM: scrolling the following pane mid-glide stops the glide and takes over', async () => {
  const s = await start();
  s.cm.top = 50;
  s.fireCm();
  s.runFrame();
  s.pv.scrollTop = 300;
  s.firePv();
  s.settle();
  assert.equal(s.pv.scrollTop, 300, 'the glide must not drag Preview away from the user');
  assert.deepEqual(s.cm.calls[s.cm.calls.length - 1], [null, 30]);
  s.sync.destroy();
});

test('scroll sync DOM: destroy() stops a running glide', async () => {
  const s = await start();
  s.cm.top = 50;
  s.fireCm();
  s.runFrame();
  const mid = s.pv.scrollTop;
  assert.ok(mid > 0 && mid < 500, 'expected a glide in progress, got ' + mid);
  s.sync.destroy();
  s.settle();
  assert.equal(s.pv.scrollTop, mid);
});
