import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleTaskLines, applyTaskList } from '../js/markdown-commands.js';

test('task list: plain line becomes an unchecked task', () => {
  assert.deepEqual(toggleTaskLines(['Buy milk']), ['- [ ] Buy milk']);
});

test('task list: existing bullet / numbered markers are replaced, not doubled', () => {
  assert.deepEqual(toggleTaskLines(['- one', '* two', '3. three']),
    ['- [ ] one', '- [ ] two', '- [ ] three']);
});

test('task list: indentation is kept', () => {
  assert.deepEqual(toggleTaskLines(['  sub item']), ['  - [ ] sub item']);
});

test('task list: when every line is already a task, the markers are removed', () => {
  assert.deepEqual(toggleTaskLines(['- [ ] a', '  - [x] b']), ['a', '  b']);
});

test('task list: mixed selection keeps tasks, converts the rest, skips empty lines', () => {
  assert.deepEqual(toggleTaskLines(['- [x] done', '', 'todo']),
    ['- [x] done', '', '- [ ] todo']);
});

test('task list: empty line gets a marker to type after', () => {
  assert.deepEqual(toggleTaskLines(['']), ['- [ ] ']);
});

test('task list: applyTaskList ignores a trailing line selected only at column 0', () => {
  const cm = {
    lines: ['first', 'second', 'third'],
    getCursor(which) { return which === 'from' ? { line: 0, ch: 0 } : which === 'to' ? { line: 2, ch: 0 } : { line: 2, ch: 0 }; },
    getLine(i) { return this.lines[i]; },
    operation(fn) { fn(); },
    replaceRange(text, from, to) { this.lines.splice(from.line, to.line - from.line + 1, ...text.split('\n')); },
    setCursor() {},
    setSelection() {},
    focus() {},
  };
  applyTaskList(cm);
  assert.deepEqual(cm.lines, ['- [ ] first', '- [ ] second', 'third']);
});