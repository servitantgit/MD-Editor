import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeadingOutline } from '../js/doc-outline.js';

test('basic ATX headings keep line numbers and levels', () => {
  const items = parseHeadingOutline('# Title\ntext\n## Section\n### Deep\n');
  assert.deepEqual(items, [
    { line: 0, level: 1, text: 'Title' },
    { line: 2, level: 2, text: 'Section' },
    { line: 3, level: 3, text: 'Deep' },
  ]);
});

test('up to 3 leading spaces are allowed, 4+ is indented code', () => {
  const items = parseHeadingOutline('   ## Spaced\n    # Not a heading\n');
  assert.deepEqual(items, [{ line: 0, level: 2, text: 'Spaced' }]);
});

test('closing hash runs are stripped, but C# keeps its hash', () => {
  const items = parseHeadingOutline('# Title ##\n# C#\n## C# ##\n');
  assert.deepEqual(items, [
    { line: 0, level: 1, text: 'Title' },
    { line: 1, level: 1, text: 'C#' },
    { line: 2, level: 2, text: 'C#' },
  ]);
});

test('hash-looking lines inside fenced code are ignored', () => {
  const text = [
    '# Real',
    '```js',
    '# not a heading',
    '## still code',
    '```',
    '~~~',
    '# also code',
    '~~~',
    '## Real again',
    '',
  ].join('\n');
  assert.deepEqual(parseHeadingOutline(text), [
    { line: 0, level: 1, text: 'Real' },
    { line: 8, level: 2, text: 'Real again' },
  ]);
});

test('empty headings and hash-only lines are skipped', () => {
  assert.deepEqual(parseHeadingOutline('#\n##   \n# Real\n'), [
    { line: 2, level: 1, text: 'Real' },
  ]);
});
