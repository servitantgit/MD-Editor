import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMinimap } from '../js/minimap.js';

function fixture(lineCount = 100) {
  const dom = new JSDOM('<div><canvas></canvas></div><div id="preview"></div>');
  const keys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = new Map(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const frames = new Map();
  let sequence = 0;
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++sequence;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const canvas = document.querySelector('canvas');
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 200 });
  const preview = document.getElementById('preview');
  preview.scrollTop = 123;
  const calls = [];
  const ctx = {
    fillStyle: '', globalAlpha: 1,
    setTransform() {},
    fillRect(x, y, width, height) {
      calls.push({ color: this.fillStyle, x, y, width, height });
    },
    strokeRect() {}
  };
  canvas.getContext = () => ctx;
  const scrollCalls = [];
  const cm = {
    on() {}, off() {},
    lineCount: () => lineCount,
    getLine: () => 'ordinary text',
    getCursor: () => ({ line: 0, ch: 0 }),
    getScrollInfo: () => ({ top: 0, clientHeight: 100, height: 2000 }),
    lineAtHeight: (height) => Math.floor(height / 20),
    scrollTo: (...args) => scrollCalls.push(args)
  };
  let searchState = { lines: [10, 10, 40], currentLine: 40 };
  const map = createMinimap(cm, canvas, {
    colors: { search: '#ffd54f', searchCurrent: '#ff8c42' },
    getSearchState: () => searchState,
    getPreviewEl: () => preview,
    isPreviewActive: () => false
  });
  return {
    calls, scrollCalls, preview, canvas, map,
    setState(value) { searchState = value; },
    paint() {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((fn) => fn());
    },
    searchCalls: () => calls.filter((c) =>
      c.color === '#ffd54f' || c.color === '#ff8c42'),
    close() {
      try { map.destroy(); } finally {
        dom.window.close();
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    }
  };
}

test('minimap search: unique matching lines and current line have distinct ticks', () => {
  const f = fixture();
  try {
    f.paint();
    const ticks = f.searchCalls();
    assert.equal(ticks.length, 2, 'two unique matching lines must be painted');
    const normal = ticks.find((c) => c.color === '#ffd54f');
    const current = ticks.find((c) => c.color === '#ff8c42');
    assert.ok(normal, 'ordinary search tick missing');
    assert.ok(current, 'current search tick missing');
    assert.equal(normal.y + normal.height / 2, 21);
    assert.equal(current.y + current.height / 2, 81);
    assert.ok(normal.width > 0 && current.width > 0);
  } finally { f.close(); }
});

test('minimap search: refresh reads updated state and clearing removes ticks', () => {
  const f = fixture();
  try {
    f.paint();
    f.calls.length = 0;
    f.setState({ lines: [70], currentLine: 70 });
    f.map.refresh();
    f.paint();
    const ticks = f.searchCalls();
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].color, '#ff8c42');
    assert.equal(ticks[0].y + ticks[0].height / 2, 141);

    f.calls.length = 0;
    f.setState({ lines: [], currentLine: null });
    f.map.refresh();
    f.paint();
    assert.deepEqual(f.searchCalls(), []);
  } finally { f.close(); }
});

test('minimap search (guard): painting search state never scrolls either pane', () => {
  const f = fixture();
  try {
    f.paint();
    f.setState({ lines: [20, 80], currentLine: 80 });
    f.map.refresh();
    f.paint();
    assert.deepEqual(f.scrollCalls, []);
    assert.equal(f.preview.scrollTop, 123);
  } finally { f.close(); }
});

test('minimap search: current tick is painted last on densely packed matching rows', () => {
  const f = fixture(1000);
  try {
    f.setState({ lines: [10, 11], currentLine: 10 });
    f.paint();
    const ticks = f.searchCalls();
    assert.equal(ticks.length, 2);
    assert.equal(ticks.at(-1).color, '#ff8c42',
      'current tick must be painted over neighboring normal ticks');
    const current = ticks.at(-1);
    assert.equal(current.y + current.height / 2, 2.1);
  } finally { f.close(); }
});
