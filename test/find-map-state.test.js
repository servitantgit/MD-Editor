import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindController } from '../js/find-controller.js';

function fixture() {
  const text = 'cat cat\nother\ncat';
  const marks = [];
  const scrolls = [];
  const cm = {
    getValue: () => text,
    operation: (fn) => fn(),
    posFromIndex(index) {
      const lines = text.slice(0, index).split('\n');
      return { line: lines.length - 1, ch: lines.at(-1).length };
    },
    markText(from, to, options) {
      const mark = {
        from: { ...from }, to: { ...to }, options, dead: false,
        clear() { this.dead = true; },
        find() {
          return this.dead ? undefined : { from: this.from, to: this.to };
        }
      };
      marks.push(mark);
      return mark;
    },
    setSelection() {},
    scrollIntoView: (...args) => scrolls.push(args)
  };
  const controller = createFindController(cm);
  return {
    controller, scrolls,
    baseMarks: () => marks.filter((m) =>
      m.options.className === 'md-find-match')
  };
}

test('find map state: unique live lines and current line are reported without scrolling', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.controller.getMapState, 'function',
      'getMapState must exist');
    f.controller.setQuery('cat');
    assert.deepEqual(f.controller.getMapState(), {
      lines: [0, 2], currentLine: null
    });
    assert.equal(f.scrolls.length, 0);
    f.controller.next();
    const before = f.scrolls.length;
    assert.deepEqual(f.controller.getMapState(), {
      lines: [0, 2], currentLine: 0
    });
    assert.equal(f.scrolls.length, before);
  } finally { f.controller.destroy(); }
});

test('find map state: shifted and deleted marks update rows before debounce refresh', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.controller.getMapState, 'function',
      'getMapState must exist');
    f.controller.setQuery('cat');
    f.controller.next();
    const marks = f.baseMarks();
    for (const mark of marks) {
      mark.from.line++;
      mark.to.line++;
    }
    assert.deepEqual(f.controller.getMapState(), {
      lines: [1, 3], currentLine: 1
    });
    marks[0].clear();
    assert.deepEqual(f.controller.getMapState(), {
      lines: [1, 3], currentLine: null
    });
    marks[1].clear();
    assert.deepEqual(f.controller.getMapState(), {
      lines: [3], currentLine: null
    });
    f.controller.clear();
    assert.deepEqual(f.controller.getMapState(), {
      lines: [], currentLine: null
    });
  } finally { f.controller.destroy(); }
});
