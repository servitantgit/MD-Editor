import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOutgoingLinks,
  linkMatchesPath,
  resolveNoteLink,
  createBacklinkIndex,
  isInternalNoteHref,
} from '../js/backlinks.js';

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
