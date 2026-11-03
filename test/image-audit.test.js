import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditImages } from '../js/image-audit.js';

// Image audit (tools/image-audit.mjs): which pictures no note uses, which
// links point at a missing picture, which pictures are byte-identical.
// Link rules are the reference rewriter's (Architecture rules 3 and 7).
// Any doubt (unread note, wiki image link, html image ref) makes the report
// invalid with an EMPTY unused list: nothing may be offered for deletion.
const f = (path, sha = 'sha:' + path) => ({ path, sha });
const run = (files, texts) => auditImages({ files, texts: new Map(Object.entries(texts)) });

test('audit: a relative image link from a note marks that image used', () => {
  const r = run([f('A/n.md'), f('Asset/a.png'), f('Asset/b.png')], { 'A/n.md': '![x](../Asset/a.png)\n' });
  assert.equal(r.valid, true);
  assert.equal(r.used.get('Asset/a.png'), 1);
  assert.deepEqual(r.unused, ['Asset/b.png']);
});

test('audit: %20 in the link finds the file with a space', () => {
  const r = run([f('A/n.md'), f('Asset/a b.png')], { 'A/n.md': '![x](../Asset/a%20b.png)\n' });
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.broken, []);
  assert.equal(r.used.get('Asset/a b.png'), 1);
});

test('audit: a link starting with / is taken from the repository root', () => {
  const r = run([f('A/B/n.md'), f('Asset/a.png')], { 'A/B/n.md': '![x](/Asset/a.png)\n' });
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.broken, []);
});

test('audit: links inside a code block or a code span do not count', () => {
  const text = '\x60\x60\x60\n![x](../Asset/a.png)\n\x60\x60\x60\nsee \x60![y](../Asset/b.png)\x60\n';
  const r = run([f('A/n.md'), f('Asset/a.png'), f('Asset/b.png')], { 'A/n.md': text });
  assert.equal(r.valid, true);
  assert.deepEqual(r.unused, ['Asset/a.png', 'Asset/b.png']);
  assert.deepEqual(r.broken, []);
});

test('audit: case must match exactly; a missing picture is broken, with a hint when only the case differs', () => {
  const r = run([f('A/n.md'), f('Asset/A.png')], { 'A/n.md': '![x](../Asset/a.png)\n![y](../Asset/gone.png)\n' });
  assert.deepEqual(r.broken, [
    { from: 'A/n.md', target: 'Asset/a.png', caseHint: 'Asset/A.png' },
    { from: 'A/n.md', target: 'Asset/gone.png', caseHint: null },
  ]);
  assert.deepEqual(r.unused, ['Asset/A.png']);
});

test('audit: external image URLs are neither used nor broken', () => {
  const r = run([f('A/n.md'), f('Asset/a.png')], { 'A/n.md': '![x](https://x.example/a.png)\n' });
  assert.deepEqual(r.broken, []);
  assert.deepEqual(r.unused, ['Asset/a.png']);
});

test('audit: a plain [link](...) and an <img src> also mark a picture used', () => {
  const r = run([f('A/n.md'), f('Asset/a.png'), f('Asset/b.png')], { 'A/n.md': '[t](../Asset/a.png) <img src="../Asset/b.png">\n' });
  assert.deepEqual(r.unused, []);
  assert.equal(r.used.get('Asset/a.png'), 1);
  assert.equal(r.used.get('Asset/b.png'), 1);
});

test('audit: pictures with the same blob sha form a duplicate group with its used count', () => {
  const files = [f('A/n.md'), f('Asset/a.png', 's1'), f('Asset/copy.png', 's1'), f('Asset/c.png', 's2')];
  const r = run(files, { 'A/n.md': '![x](../Asset/a.png)\n' });
  assert.deepEqual(r.duplicates, [{ sha: 's1', paths: ['Asset/a.png', 'Asset/copy.png'], usedCount: 1 }]);
  assert.deepEqual(r.unused, ['Asset/c.png', 'Asset/copy.png']);
});

test('audit failure: a note that could not be read makes the report invalid with no unused pictures', () => {
  const r = run([f('A/n.md'), f('A/m.md'), f('Asset/a.png'), f('Asset/b.png')], { 'A/n.md': '![x](../Asset/a.png)\n', 'A/m.md': null });
  assert.equal(r.valid, false);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.reasons, ['unread: A/m.md']);
});

test('audit failure: an ![[embed]] is a link form the audit does not resolve, so the report is invalid', () => {
  const r = run([f('A/n.md'), f('Asset/a.png')], { 'A/n.md': '![[a.png]]\n' });
  assert.equal(r.valid, false);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.reasons, ['wiki image link: A/n.md']);
});

test('audit failure: an HTML file that points at a picture makes the report invalid (data: is ignored)', () => {
  const files = [f('HTML/p.html'), f('HTML/q.html'), f('Asset/a.png')];
  const r = run(files, { 'HTML/p.html': '<img src="x.png">', 'HTML/q.html': '<img src="data:image/png;base64,AA">' });
  assert.equal(r.valid, false);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.reasons, ['html image ref: HTML/p.html']);
});
