import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindController } from '../js/find-controller.js';

function fixture(initialText = 'cat CAT cat') {
  let text = initialText;
  const marks = [];
  const scrolls = [];
  const selections = [];
  const unfolds = [];
  const actions = [];
  let operations = 0;
  const cm = {
    getValue: () => text,
    operation(fn) { operations++; return fn(); },
    posFromIndex(index) {
      const parts = text.slice(0, index).split('\n');
      return { line: parts.length - 1, ch: parts.at(-1).length };
    },
    indexFromPos(pos) {
      const lines = text.split('\n');
      return lines.slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.ch;
    },
    markText(from, to, options) {
      const mark = {
        from: { ...from }, to: { ...to }, options, dead: false,
        clear() { this.dead = true; },
        find() { return this.dead ? undefined : { from: this.from, to: this.to }; }
      };
      marks.push(mark);
      return mark;
    },
    setSelection(from, to) {
      selections.push({ from, to });
      actions.push('select');
    },
    scrollIntoView(range, margin) {
      scrolls.push({ range, margin });
      actions.push('scroll');
    }
  };
  const controller = createFindController(cm, {
    unfoldAtLine(line) { unfolds.push(line); actions.push('unfold'); }
  });
  return {
    cm, controller, marks, scrolls, selections, unfolds, actions,
    setText(value) { text = value; },
    text: () => text,
    operations: () => operations,
    alive: () => marks.filter((m) => !m.dead)
  };
}

test('find controller: query marks all case-insensitive phrase matches without scrolling', () => {
  const f = fixture();
  try {
    f.controller.setQuery('cat');
    assert.equal(f.controller.getState().total, 3);
    assert.equal(f.controller.getState().current, 0);
    assert.equal(f.alive().length, 3);
    assert.deepEqual(f.alive().map((m) => [m.from.ch, m.to.ch]),
      [[0, 3], [4, 7], [8, 11]]);
    assert.ok(f.alive().every((m) =>
      m.options.atomic !== true && m.options.addToHistory === false));
    assert.ok(f.operations() > 0);
    assert.equal(f.scrolls.length, 0);
    assert.equal(f.text(), 'cat CAT cat');
  } finally { f.controller.destroy(); }
});

test('find controller: next and previous wrap through every match', () => {
  const f = fixture();
  try {
    f.controller.setQuery('cat');
    f.controller.next();
    assert.equal(f.controller.getState().current, 1);
    f.controller.next();
    assert.equal(f.controller.getState().current, 2);
    f.controller.next();
    f.controller.next();
    assert.equal(f.controller.getState().current, 1);
    f.controller.next({ backwards: true });
    assert.equal(f.controller.getState().current, 3);
    assert.equal(f.selections.at(-1).from.ch, 8);
  } finally { f.controller.destroy(); }
});

test('find controller: navigation reads shifted positions from mark.find before refresh', () => {
  const f = fixture();
  try {
    f.controller.setQuery('cat');
    const originalMarks = [...f.alive()];
    f.controller.next();
    f.setText('xx cat CAT cat');
    for (const mark of originalMarks) {
      mark.from.ch += 3;
      mark.to.ch += 3;
    }
    f.controller.next();
    assert.equal(f.selections.at(-1).from.ch, 7);
    assert.equal(f.selections.at(-1).to.ch, 10);
  } finally { f.controller.destroy(); }
});

test('find controller: deleted marks are skipped by navigation', () => {
  const f = fixture();
  try {
    f.controller.setQuery('cat');
    const originalMarks = [...f.alive()];
    f.controller.next();
    originalMarks[1].clear();
    f.controller.next();
    assert.equal(f.selections.at(-1).from.ch, 8);
  } finally { f.controller.destroy(); }
});

test('find controller: refreshing edited text recalculates matches without navigation', () => {
  const f = fixture();
  try {
    f.controller.setQuery('cat');
    f.controller.next();
    const before = f.scrolls.length;
    f.setText('cat dog');
    f.controller.refresh();
    assert.equal(f.controller.getState().total, 1);
    assert.equal(f.scrolls.length, before);
    assert.equal(f.text(), 'cat dog');
  } finally { f.controller.destroy(); }
});

test('find controller: clear removes only owned marks and resets state', () => {
  const f = fixture();
  const unrelated = f.cm.markText({ line: 0, ch: 0 }, { line: 0, ch: 1 }, {});
  try {
    f.controller.setQuery('cat');
    f.controller.clear();
    assert.equal(unrelated.dead, false);
    assert.equal(f.controller.getState().total, 0);
    assert.equal(f.controller.getState().current, 0);
    assert.equal(f.alive().length, 1);
    const before = f.scrolls.length;
    f.controller.next();
    assert.equal(f.scrolls.length, before);
  } finally { f.controller.destroy(); }
});

test('find controller: explicit navigation unfolds the target before scrolling', () => {
  const f = fixture('first\ncat');
  try {
    f.controller.setQuery('cat');
    assert.deepEqual(f.unfolds, []);
    f.controller.next();
    assert.deepEqual(f.unfolds, [1]);
    assert.ok(f.actions.indexOf('unfold') < f.actions.indexOf('scroll'));
    assert.equal(f.selections.at(-1).from.line, 1);
  } finally { f.controller.destroy(); }
});

test('find controller: supplied Search ranges honor chosen initial match without eager scrolling', () => {
  const f = fixture('cat printing');
  try {
    f.controller.setRanges([
      { from: 0, to: 3, text: 'cat', term: 'cat' },
      { from: 4, to: 12, text: 'printing', term: 'printing' }
    ], { initial: 1 });
    assert.equal(f.controller.getState().mode, 'search');
    assert.equal(f.controller.getState().total, 2);
    assert.equal(f.scrolls.length, 0);
    f.controller.next();
    assert.equal(f.selections.at(-1).from.ch, 4);
    assert.equal(f.controller.getState().current, 2);
    f.controller.next();
    assert.equal(f.selections.at(-1).from.ch, 0);
  } finally { f.controller.destroy(); }
});

test('find controller: phrase search handles Unicode offsets, empty query and repeated destroy', () => {
  const f = fixture('\uD83D\uDE00 \u0421\u0422\u0410\u041D\u041E\u041A');
  f.controller.setQuery('\u0441\u0442\u0430\u043D\u043E\u043A');
  assert.equal(f.controller.getState().total, 1);
  f.controller.next();
  assert.equal(f.selections.at(-1).from.ch, 3);
  assert.equal(f.selections.at(-1).to.ch, 9);
  f.controller.setQuery('');
  assert.equal(f.controller.getState().total, 0);
  f.controller.destroy();
  f.controller.destroy();
  assert.equal(f.alive().length, 0);
});
