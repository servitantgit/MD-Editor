import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByFences, replaceOutsideFences } from '../js/md-fences.js';
import * as fences from '../js/md-fences.js';

const parts = (text) => splitByFences(text).map((s) => [s.code, s.text]);

test('splitByFences: joining segments gives the input back byte-for-byte', () => {
  const samples = [
    '',
    'plain text',
    'a\n```\ncode\n```\nb\n',
    'a\r\n```js\r\ncode\r\n```\r\nb\r\n',
    '```\nunclosed [x](y.md)',
    '~~~\nx\n~~~',
  ];
  for (const s of samples) {
    assert.equal(splitByFences(s).map((seg) => seg.text).join(''), s);
  }
});

test('splitByFences marks a backtick fence as code and the text around it as non-code', () => {
  assert.deepEqual(parts('before\n```\n[a](b.md)\n```\nafter\n'), [
    [false, 'before\n'],
    [true, '```\n[a](b.md)\n```\n'],
    [false, 'after\n'],
  ]);
});

test('splitByFences recognizes tilde fences', () => {
  assert.deepEqual(parts('x\n~~~\n![i](p.png)\n~~~\ny'), [
    [false, 'x\n'],
    [true, '~~~\n![i](p.png)\n~~~\n'],
    [false, 'y'],
  ]);
});

test('splitByFences: a fence line with an info string does not close an open block', () => {
  assert.deepEqual(parts('```\n```js\n[a](b.md)\n```\nout\n'), [
    [true, '```\n```js\n[a](b.md)\n```\n'],
    [false, 'out\n'],
  ]);
});

test('splitByFences: a tilde fence does not close a backtick block', () => {
  assert.deepEqual(parts('```\n~~~\n[a](b.md)\n```\nout'), [
    [true, '```\n~~~\n[a](b.md)\n```\n'],
    [false, 'out'],
  ]);
});

test('splitByFences: a longer fence is closed only by a fence at least as long', () => {
  assert.deepEqual(parts('````\n```\n[a](b.md)\n````\nout'), [
    [true, '````\n```\n[a](b.md)\n````\n'],
    [false, 'out'],
  ]);
});

test('splitByFences: inline triple-backtick code does not open a block', () => {
  const text = '```inline``` [a](b.md)\nnext [c](d.md)\n';
  assert.deepEqual(parts(text), [[false, text]]);
});

test('splitByFences: an unclosed fence runs to the end of the text', () => {
  assert.deepEqual(parts('a\n```\n[x](y.md)\nmore'), [
    [false, 'a\n'],
    [true, '```\n[x](y.md)\nmore'],
  ]);
});

test('splitByFences recognizes an indented fence inside a list', () => {
  assert.deepEqual(parts('- step\n    ```\n    [a](b.md)\n    ```\n- next\n'), [
    [false, '- step\n'],
    [true, '    ```\n    [a](b.md)\n    ```\n'],
    [false, '- next\n'],
  ]);
});

test('splitByFences recognizes fences in CRLF text', () => {
  assert.deepEqual(parts('a\r\n```\r\n[x](y.md)\r\n```\r\nb\r\n'), [
    [false, 'a\r\n'],
    [true, '```\r\n[x](y.md)\r\n```\r\n'],
    [false, 'b\r\n'],
  ]);
});

test('splitByFences reports the start offset of every segment', () => {
  const text = 'ab\n```\nc\n```\nde';
  const segs = splitByFences(text);
  assert.deepEqual(segs.map((s) => s.start), [0, 3, 13]);
  for (const s of segs) {
    assert.equal(text.slice(s.start, s.start + s.text.length), s.text);
  }
});

test('replaceOutsideFences applies the replacement only outside fenced code', () => {
  const text = 'x1\n```\nx2\n```\nx3\n';
  assert.equal(replaceOutsideFences(text, /x\d/g, (m) => m.toUpperCase()), 'X1\n```\nx2\n```\nX3\n');
});

test('findCodeSpans finds single and double backtick code spans', () => {
  const text = 'a `x` b ``y`z`` c';
  assert.deepEqual(fences.findCodeSpans(text).map(([s, e]) => text.slice(s, e)), ['`x`', '``y`z``']);
});

test('findCodeSpans ignores an unmatched backtick and backticks in different paragraphs', () => {
  assert.deepEqual(fences.findCodeSpans('a ` b'), []);
  assert.deepEqual(fences.findCodeSpans('a `\n\nb `'), []);
});

test('replaceOutsideFences skips matches that start inside inline code', () => {
  assert.equal(fences.replaceOutsideFences('`x1` x2 ``x3`` x4', /x\d/g, (m) => m.toUpperCase()), '`x1` X2 ``x3`` X4');
});
