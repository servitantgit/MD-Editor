import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTaskLines } from '../js/markdown-commands.js';

test('task toggle: finds tasks with line, column of the mark and state', () => {
  assert.deepEqual(findTaskLines('- [ ] a\n- [x] b'), [
    { line: 0, ch: 3, checked: false },
    { line: 1, ch: 3, checked: true },
  ]);
});

test('task toggle: tasks inside a ``` fence are not counted', () => {
  assert.deepEqual(findTaskLines('```\n- [ ] not a task\n```\n- [ ] real'), [
    { line: 3, ch: 3, checked: false },
  ]);
});

test('task toggle: a ``` line does not close a ~~~ fence', () => {
  assert.deepEqual(findTaskLines('~~~\n```\n- [ ] x\n~~~\n- [X] y'), [
    { line: 4, ch: 3, checked: true },
  ]);
});

test('task toggle: nested, ordered and blockquoted tasks', () => {
  assert.deepEqual(findTaskLines('  - [ ] sub\n1. [ ] num\n> - [ ] quoted'), [
    { line: 0, ch: 5, checked: false },
    { line: 1, ch: 4, checked: false },
    { line: 2, ch: 5, checked: false },
  ]);
});

test('task toggle: look-alikes are not tasks', () => {
  assert.deepEqual(findTaskLines('- [] no\n- [ ]no\ntext [ ] mid\n- [y] no'), []);
});

test('task toggle: CRLF text gives the same positions', () => {
  assert.deepEqual(findTaskLines('- [ ] a\r\n- [x] b\r\n'), [
    { line: 0, ch: 3, checked: false },
    { line: 1, ch: 3, checked: true },
  ]);
});

test('task toggle: ch always points at the mark character itself', () => {
  const text = '- [ ] a\n  * [x] b\n3) [X] c\n> > - [ ] d';
  const lines = text.split('\n');
  const found = findTaskLines(text);
  assert.equal(found.length, 4);
  for (const t of found) {
    const mark = lines[t.line][t.ch];
    assert.equal(lines[t.line][t.ch - 1], '[');
    assert.equal(lines[t.line][t.ch + 1], ']');
    assert.equal(mark === ' ' ? false : true, t.checked);
  }
});

test('task toggle: a ```js line does not close an open fence', () => {
  assert.deepEqual(findTaskLines('```\n```js\n- [ ] inside\n```\n- [ ] after'), [
    { line: 4, ch: 3, checked: false },
  ]);
});

test('task toggle: an inline ```x``` line does not open a fence', () => {
  assert.deepEqual(findTaskLines('```x``` inline\n- [ ] real'), [
    { line: 1, ch: 3, checked: false },
  ]);
});