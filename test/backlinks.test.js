import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOutgoingLinks,
  linkMatchesPath,
  resolveNoteLink,
  createBacklinkIndex,
  isInternalNoteHref,
} from '../js/backlinks.js';
import { buildFileLink } from '../js/link-suggest.js';

test('extractOutgoingLinks picks relative and root md links, skips images and external', () => {
  const body = [
    'See [a](./other.md) and [b](../shared/x.md).',
    'Root [c](/Notes/c.md) and bare [d](d.md).',
    'Image ![x](pic.png) and https [e](https://example.com/a.md).',
    'Anchor [f](#section) ignored.',
  ].join('\n');
  const links = extractOutgoingLinks('Notes/guide.md', body);
  assert.ok(links.includes('Notes/other.md'), links);
  assert.ok(links.includes('shared/x.md'), links);
  assert.ok(links.includes('Notes/c.md'), links);
  assert.ok(links.includes('Notes/d.md'), links);
  assert.ok(!links.some((l) => l.includes('pic.png')));
  assert.ok(!links.some((l) => l.includes('example.com')));
});

test('wikilinks are extracted', () => {
  const links = extractOutgoingLinks('a/b.md', 'See [[Printer jam]] and [[Notes/c|alias]].');
  assert.ok(links.some((l) => /Printer jam/i.test(l) || l.endsWith('Printer jam')));
  assert.ok(links.includes('Notes/c') || links.includes('a/Notes/c') || links.includes('Notes/c'));
});

test('linkMatchesPath handles missing extension and basename wikilinks', () => {
  assert.equal(linkMatchesPath('Notes/a.md', 'Notes/a.md'), true);
  assert.equal(linkMatchesPath('Notes/a', 'Notes/a.md'), true);
  assert.equal(linkMatchesPath('a', 'Notes/a.md'), true);
  assert.equal(linkMatchesPath('Notes/b.md', 'Notes/a.md'), false);
});

test('isInternalNoteHref filters schemes', () => {
  assert.equal(isInternalNoteHref('Notes/a.md'), true);
  assert.equal(isInternalNoteHref('https://x.com'), false);
  assert.equal(isInternalNoteHref('#top'), false);
});

test('createBacklinkIndex reverse lookup', () => {
  const idx = createBacklinkIndex();
  idx.setFile('Notes/hub.md', 'See [x](./a.md) and [y](./b.md).');
  idx.setFile('Notes/other.md', 'Also [x](a.md).');
  idx.setFile('Notes/a.md', 'Canonical page.');
  const bl = idx.getBacklinks('Notes/a.md');
  assert.deepEqual(bl, ['Notes/hub.md', 'Notes/other.md']);
  idx.removeFile('Notes/hub.md');
  assert.deepEqual(idx.getBacklinks('Notes/a.md'), ['Notes/other.md']);
});

test('resolveNoteLink joins against source directory', () => {
  assert.equal(resolveNoteLink('A/B/c.md', './d.md'), 'A/B/d.md');
  assert.equal(resolveNoteLink('A/B/c.md', '../x.md'), 'A/x.md');
});

// ---- [[wiki links]] resolve like Obsidian: a path from the repository root, a bare name by file name ----
test('backlinks: [[Path/Note]] from another folder is resolved from the repository root', () => {
  const idx = createBacklinkIndex();
  idx.setFile('Other/deep/plain.md', 'See [[Notes/Printer jam]].');
  idx.setFile('Other/deep/alias.md', 'See [[Notes/Printer jam|the jam]].');
  idx.setFile('Other/deep/heading.md', 'See [[Notes/Printer jam#Fix]].');
  idx.setFile('Other/deep/ext.md', 'See [[Notes/Printer jam.md]].');
  idx.setFile('Other/deep/slash.md', 'See [[/Notes/Printer jam]].');
  assert.deepEqual(idx.getBacklinks('Notes/Printer jam.md'), [
    'Other/deep/alias.md', 'Other/deep/ext.md', 'Other/deep/heading.md', 'Other/deep/plain.md', 'Other/deep/slash.md',
  ]);
});

test('backlinks: [[Note name]] from another folder finds the note by its file name', () => {
  const idx = createBacklinkIndex();
  idx.setFile('Other/deep/a.md', 'See [[Printer jam]] and [[Printer jam|alias]].');
  assert.deepEqual(idx.getBacklinks('Notes/Printer jam.md'), ['Other/deep/a.md']);
});

test('backlinks: [[./x]] and [[../x]] wiki links still resolve from the note folder', () => {
  const idx = createBacklinkIndex();
  idx.setFile('Other/note.md', 'See [[../Notes/Printer jam]].');
  idx.setFile('Notes/near.md', 'See [[./Printer jam]].');
  assert.deepEqual(idx.getBacklinks('Notes/Printer jam.md'), ['Notes/near.md', 'Other/note.md']);
});

test('backlinks: [[Notes/x]] is not mistaken for a note under the source folder', () => {
  const idx = createBacklinkIndex();
  idx.setFile('Other/note.md', 'See [[Notes/Printer jam]].');
  assert.deepEqual(idx.getBacklinks('Other/Notes/Printer jam.md'), [], 'no false match under Other/');
  assert.deepEqual(idx.getBacklinks('Notes/Printer jam.md'), ['Other/note.md']);
});

// Links inside code are examples, not links (Architecture rule 3: the
// reference rewriter already skips fences and code spans, backlinks must too).
test('extractOutgoingLinks skips links inside code: fenced block', () => {
  const body = '\x60\x60\x60\n[[X]]\n[x](X.md)\n\x60\x60\x60\n';
  assert.deepEqual(extractOutgoingLinks('A/n.md', body), []);
});

test('extractOutgoingLinks skips links inside code: code span', () => {
  const body = 'see \x60[[X]]\x60 and \x60[x](X.md)\x60\n';
  assert.deepEqual(extractOutgoingLinks('A/n.md', body), []);
});

test('extractOutgoingLinks skips links inside code: fence and span mixed with real links', () => {
  const body = '\x60\x60\x60\n[[InFence]]\n[x](InFence2.md)\n\x60\x60\x60\nsee \x60[[InSpan]]\x60 here\n[[Real]]\n[y](Real2.md)\n';
  assert.deepEqual(extractOutgoingLinks('A/n.md', body), ['A/Real2.md', 'Real']);
});

test('extractOutgoingLinks skips links inside code: fence inside a blockquote', () => {
  const body = '> \x60\x60\x60\n> [[X]]\n> \x60\x60\x60\n';
  assert.deepEqual(extractOutgoingLinks('A/n.md', body), []);
});

test('extractOutgoingLinks keeps a link right after a code span (guard)', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '\x60code\x60 [[Real]]\n'), ['Real']);
});

// After a reload the backlink index is filled from stored links, not from
// bodies: setLinks must give exactly what setFile gives (same "notes only" rule).
test('backlinks: setLinks with extractOutgoingLinks gives the same backlinks as setFile', () => {
  const body = 'See [b](B.md) and [[Real]], not \x60[[Code]]\x60.\n';
  const a = createBacklinkIndex();
  a.setFile('A/n.md', body);
  a.setFile('A/x.txt', '[[Real]]');
  const b = createBacklinkIndex();
  b.setLinks('A/n.md', extractOutgoingLinks('A/n.md', body));
  b.setLinks('A/x.txt', extractOutgoingLinks('A/x.txt', '[[Real]]'));
  for (const p of ['A/B.md', 'Real.md', 'Code.md', 'A/x.txt']) {
    assert.deepEqual(b.getBacklinks(p), a.getBacklinks(p), p);
  }
  assert.deepEqual(b.getBacklinks('A/B.md'), ['A/n.md']);
  assert.deepEqual(b.getBacklinks('Real.md'), ['A/n.md']);
  assert.equal(b.size, 1, 'a .txt file is not a link source');
});

// Link forms: the editor writes [x](</A/a b.md>) (buildFileLink), older notes
// hold [x](/A/a%20b.md). Backlinks read both through REF_TOKEN_RE and decode the
// target once (Architecture rules 3 and 7).
test('link forms: backlinks read a link in <...> with spaces', () => {
  assert.deepEqual(extractOutgoingLinks('AI corrected/SWAM/n.md', '[x](</AI corrected/SWAM/a b.md>)\n'), ['AI corrected/SWAM/a b.md']);
});

test('link forms: backlinks decode %20 in a root link', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '[x](/AI%20corrected/a%20b.md)\n'), ['AI corrected/a b.md']);
});

test('link forms: backlinks decode %20 in a relative Cyrillic link', () => {
  assert.deepEqual(extractOutgoingLinks('MICAM/n.md', '[x](./\u043f\u043e\u0432\u043d\u0430%20k.md)\n'), ['MICAM/\u043f\u043e\u0432\u043d\u0430 k.md']);
});

test('link forms: backlinks decode %25 once, not twice', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '[x](a%25b.md)\n'), ['A/a%b.md']);
});

test('link forms: backlinks find every link built by buildFileLink', () => {
  for (const p of ['AI corrected/SWAM/SWAM Weryfikacja temperatur.md', 'A/B.md', 'A/100% done.md']) {
    const idx = createBacklinkIndex();
    idx.setFile('Other/src.md', 'See ' + buildFileLink(p) + '.\n');
    assert.deepEqual(idx.getBacklinks(p), ['Other/src.md'], p);
  }
});

test('link forms: an invalid % sequence is kept as written (guard)', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '[x](bad%ZZ.md)\n'), ['A/bad%ZZ.md']);
});

test('link forms: an image in <...> is not a backlink (guard)', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '![p](</A/a b.png>)\n'), []);
});

test('link forms: <mailto:...> is not a backlink (guard)', () => {
  assert.deepEqual(extractOutgoingLinks('A/n.md', '[m](<mailto:x@y.com>)\n'), []);
});
