import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsBadgePublicUrl, ImageResolver } from '../js/image-resolver.js';
import { resolveRelativePath, dirnameOf } from '../js/paths.js';

test('actions badge relative path from README root resolves to public GitHub URL', () => {
  const path = resolveRelativePath(dirnameOf('README.md'), '../../actions/workflows/test.yml/badge.svg');
  assert.equal(path, 'actions/workflows/test.yml/badge.svg');
  assert.equal(
    actionsBadgePublicUrl(path, 'servitantgit', 'MD-Editor'),
    'https://github.com/servitantgit/MD-Editor/actions/workflows/test.yml/badge.svg'
  );
});

test('ImageResolver returns virtual URL without calling getFileAsDataUrl', async () => {
  let called = false;
  const client = {
    owner: 'o',
    repo: 'r',
    async getFileAsDataUrl() { called = true; return 'data:x'; },
  };
  const r = new ImageResolver(client);
  const url = await r.resolve('../../actions/workflows/ci.yml/badge.svg', 'README.md');
  assert.equal(url, 'https://github.com/o/r/actions/workflows/ci.yml/badge.svg');
  assert.equal(called, false);
});

test('external https left as-is', async () => {
  const client = { owner: 'o', repo: 'r', async getFileAsDataUrl() { throw new Error('no'); } };
  const r = new ImageResolver(client);
  const u = 'https://img.shields.io/badge/build-none-brightgreen';
  assert.equal(await r.resolve(u, 'README.md'), u);
});

// Preview re-renders on every keystroke; a synchronous cache read keeps already
// loaded images in place instead of collapsing them to a 1x1 placeholder.
test('cachedUrl: null before resolve, the resolved URL after, with the same path rules', async () => {
  let calls = 0;
  const client = { owner: 'o', repo: 'r', async getFileAsDataUrl(p) { calls++; return 'data:image/png;base64,' + p; } };
  const r = new ImageResolver(client);
  assert.equal(r.cachedUrl('../img/a.png', 'notes/x.md'), null);
  const url = await r.resolve('../img/a.png', 'notes/x.md');
  assert.equal(r.cachedUrl('../img/a.png', 'notes/x.md'), url);
  assert.equal(r.cachedUrl('/img/a.png', 'other/y.md'), url);
  assert.equal(calls, 1, 'cachedUrl never goes to the network');
});

test('cachedUrl: external and protocol-relative URLs give what resolve gives', async () => {
  const r = new ImageResolver({ owner: 'o', repo: 'r', async getFileAsDataUrl() { throw new Error('no'); } });
  for (const src of ['https://e.com/a.png', '//cdn.example.com/a.png']) {
    assert.equal(r.cachedUrl(src, 'n.md'), await r.resolve(src, 'n.md'));
  }
});
