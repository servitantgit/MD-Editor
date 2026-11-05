import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { findSearchMatches, chooseInitialMatch } from '../js/search-matches.js';

const tokenize = MiniSearch.getDefault('tokenize');
const processTerm = MiniSearch.getDefault('processTerm');
function matches(text, terms, path = 'note.md') {
  return findSearchMatches(text, { path, terms, tokenize, processTerm });
}
function positions(ranges) {
  return ranges.map(({ from, to }) => [from, to]);
}

test('search matches: whole tokens keep exact original offsets and deduplicate terms', () => {
  const result = matches('printer printing printer', ['printer', 'printer']);
  assert.deepEqual(result, [
    { from: 0, to: 7, text: 'printer', term: 'printer' },
    { from: 17, to: 24, text: 'printer', term: 'printer' }
  ]);
});

test('search matches: Markdown code, images and link destinations are excluded', () => {
  const text = 'printer \x60printer\x60 [printer](Notes/printer.md) ![printer](Asset/printer.png)';
  assert.deepEqual(positions(matches(text, ['printer'])), [[0, 7], [19, 26]]);
  const fenced = 'before\n~~~\nprinter\n~~~\nafter printer';
  assert.deepEqual(positions(matches(fenced, ['printer'])), [[29, 36]]);
});

test('search matches: plain text is found but inline code and joined formatting are not', () => {
  assert.deepEqual(positions(matches('A printer here.', ['printer'])), [[2, 9]]);
  assert.deepEqual(matches('A \x60printer\x60 here.', ['printer']), []);
  assert.deepEqual(matches('A **print**er here.', ['printer']), []);
});

test('search matches: angle destinations and image titles are excluded, link labels remain', () => {
  const text = '[printer](<Notes/printer file.md>) ![printer](Asset/a.png "printer")';
  assert.deepEqual(positions(matches(text, ['printer'])), [[1, 8]]);
});

test('search matches: Polish and Cyrillic case preserve source positions', () => {
  const text = '\u005A\u006D\u0069\u0065\u006E\u0069\u0107 \u0421\u0422\u0410\u041D\u041E\u041A';
  const result = matches(text, [
    'zmieni\u0107', '\u0441\u0442\u0430\u043D\u043E\u043A'
  ]);
  assert.deepEqual(positions(result), [[0, 7], [8, 14]]);
  assert.equal(result[0].text, 'Zmieni\u0107');
  assert.equal(result[1].text, '\u0421\u0422\u0410\u041D\u041E\u041A');
});

test('search matches: length-changing normalization and emoji retain UTF16 offsets', () => {
  const text = '\uD83D\uDE00 \u0130 I';
  const result = matches(text, ['i\u0307']);
  assert.deepEqual(result, [
    { from: 3, to: 4, text: '\u0130', term: 'i\u0307' }
  ]);
});

test('search matches: JavaScript and HTML do not apply Markdown exclusions', () => {
  const text = '~~~\nprinter\n~~~\n[printer](printer)';
  for (const path of ['file.js', 'file.html']) {
    assert.deepEqual(positions(matches(text, ['printer'], path)),
      [[4, 11], [17, 24], [26, 33]]);
    // Backticks are symbols: the tokenizer retains them in the token.
    const inline = '\x60printer\x60 [printer](printer)';
    assert.deepEqual(positions(matches(inline, ['printer'], path)),
      [[11, 18], [20, 27]]);
    assert.deepEqual(positions(matches(inline, ['\x60printer\x60'], path)),
      [[0, 9]]);
  }
});

test('search matches: empty text, empty terms and absent token produce no ranges', () => {
  assert.deepEqual(matches('', ['printer']), []);
  assert.deepEqual(matches('printer', []), []);
  assert.deepEqual(matches('printing', ['printer']), []);
});

test('search matches: initial choice uses original code points, not UTF16 or normalized length', () => {
  const result = [
    { from: 0, to: 4, text: '\uD83D\uDE00\uD83D\uDE00', term: 'emoji' },
    { from: 5, to: 8, text: 'abc', term: 'abc' }
  ];
  assert.equal(chooseInitialMatch(result), 1);
});

test('search matches: equal-length initial choice uses earliest offset; empty list gives minus one', () => {
  const result = [
    { from: 20, to: 23, text: 'cat', term: 'cat' },
    { from: 5, to: 8, text: 'dog', term: 'dog' }
  ];
  assert.equal(chooseInitialMatch(result), 1);
  assert.equal(chooseInitialMatch([]), -1);
});
