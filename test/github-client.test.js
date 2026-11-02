import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../js/github-client.js';

/**
 * GitHub's CORS policy allows only a fixed set of request headers. Anything outside the
 * CORS-safelisted set (plus the ones GitHub explicitly allows) turns a simple GET into a
 * preflight that GitHub rejects — sending `Cache-Control: no-cache` broke the whole app
 * with "Request header field cache-control is not allowed by Access-Control-Allow-Headers".
 */
const CORS_SAFE_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'range']);
const GITHUB_ALLOWED_HEADERS = new Set(['authorization', 'x-github-api-version']);

function mockFetch(treeResponse = { tree: [{ path: 'a.md', type: 'blob', sha: 'sha-a' }] }) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    return { ok: true, status: 200, json: async () => treeResponse };
  };
  return calls;
}

test('getTree sends no headers that would break the CORS preflight', async () => {
  const calls = mockFetch();
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await client.getTree('main');

  const bad = Object.keys(calls[0].headers).filter(
    (h) => !CORS_SAFE_HEADERS.has(h.toLowerCase()) && !GITHUB_ALLOWED_HEADERS.has(h.toLowerCase())
  );
  assert.deepEqual(bad, [], `getTree must not send these headers: ${bad.join(', ')}`);
});

test('getTree busts the cache with a query parameter, not with a header', async () => {
  const calls = mockFetch();
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });

  await client.getTree('main');
  await client.getTree('main');

  const first = new URL(calls[0].url);
  const second = new URL(calls[1].url);
  assert.equal(first.searchParams.get('recursive'), '1');
  assert.notEqual(first.searchParams.get('cb'), null, 'the tree request must carry a cache-buster');
  assert.notEqual(
    first.searchParams.get('cb'),
    second.searchParams.get('cb'),
    'two consecutive tree loads must not share a cache key'
  );
});

test('getTree keeps only blobs and maps them to {path, sha}', async () => {
  mockFetch({
    tree: [
      { path: 'a.md', type: 'blob', sha: 'sha-a' },
      { path: 'dir', type: 'tree', sha: 'sha-dir' },
    ],
  });
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });

  const files = await client.getTree('main');
  assert.deepEqual(files, [{ path: 'a.md', sha: 'sha-a' }]);
});

function mockContentsFetch(contents, blob) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('/git/blobs/') ? blob : contents;
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test('getFileB64 returns empty content for a 0-byte file without a blob request', async () => {
  const calls = mockContentsFetch(
    { content: '', size: 0, sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' },
    { content: '' }
  );
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  const out = await client.getFileB64('Docs/.gitkeep');
  assert.deepEqual(out, { b64: '', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' });
  assert.equal(calls.length, 1, `expected 1 request, got: ${calls.join(', ')}`);
});

test('getFileB64 still falls back to the blob API for a large file', async () => {
  const calls = mockContentsFetch(
    { content: '', size: 2000000, sha: 'sha-big' },
    { content: 'aGVs\nbG8=', sha: 'sha-big' }
  );
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  const out = await client.getFileB64('big.md');
  assert.deepEqual(out, { b64: 'aGVsbG8=', sha: 'sha-big' });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/git\/blobs\/sha-big$/);
});

test('getFileB64 still throws when content is missing and size is unknown', async () => {
  mockContentsFetch({ content: '', sha: 'sha-x' }, { content: '' });
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await assert.rejects(client.getFileB64('x.md'), /Empty contents/);
});

test('getBlobB64 returns empty content for a 0-byte blob without throwing', async () => {
  // An empty file version in history (e.g. a .gitkeep) comes back as content '' and size 0.
  const calls = mockContentsFetch(
    { content: '' },
    { content: '', size: 0, sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', encoding: 'base64' }
  );
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  const out = await client.getBlobB64('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.deepEqual(out, { b64: '', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', encoding: 'base64' });
  assert.equal(calls.length, 1, `expected 1 request, got: ${calls.join(', ')}`);
});

test('getBlobB64 still throws when content is missing and size is unknown', async () => {
  mockContentsFetch({ content: '' }, { content: '', sha: 'sha-x' });
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await assert.rejects(client.getBlobB64('sha-x'), /Empty blob/);
});

// ---- commitTreeChanges: one atomic commit through the Git Data API ----
// A folder rename/delete used to be N separate commits; one failure halfway
// left the repository half-changed.
function mockGitData({ failTree = false } = {}) {
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const bad = () => ({ ok: false, status: 422, json: async () => ({ message: 'tree failed (mock)' }), text: async () => 'tree failed (mock)', headers: { get: () => null } });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    calls.push({ url: u, method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && u.includes('/git/ref/heads/')) return ok({ object: { sha: 'parent-sha' } });
    if (method === 'GET' && u.includes('/git/commits/')) return ok({ sha: 'parent-sha', tree: { sha: 'base-tree' } });
    if (method === 'POST' && u.includes('/git/blobs')) return ok({ sha: 'blob-' + calls.length });
    if (method === 'POST' && u.includes('/git/trees')) return failTree ? bad() : ok({ sha: 'new-tree' });
    if (method === 'POST' && u.includes('/git/commits')) return ok({ sha: 'new-commit' });
    if (method === 'PATCH' && u.includes('/git/refs/heads/')) return ok({ object: { sha: 'new-commit' } });
    return { ok: false, status: 404, json: async () => ({ message: 'unexpected ' + method + ' ' + u }), text: async () => 'unexpected', headers: { get: () => null } };
  };
  return calls;
}

test('commitTreeChanges moves a file by reusing its blob sha, in one commit', async () => {
  const calls = mockGitData();
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await client.commitTreeChanges('main', 'Rename folder Notes to Docs', [
    { path: 'Docs/a.md', sha: 'sha-a' },
    { path: 'Notes/a.md', sha: null },
  ]);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/git/blobs')).length, 0, 'no blob for a move');
  const tree = calls.find((c) => c.method === 'POST' && c.url.includes('/git/trees'));
  assert.equal(tree.body.base_tree, 'base-tree');
  assert.deepEqual(tree.body.tree.map((e) => [e.path, e.sha]), [['Docs/a.md', 'sha-a'], ['Notes/a.md', null]]);
  const commit = calls.find((c) => c.method === 'POST' && c.url.includes('/git/commits'));
  assert.equal(commit.body.tree, 'new-tree');
  assert.deepEqual(commit.body.parents, ['parent-sha']);
  const ref = calls.find((c) => c.method === 'PATCH');
  assert.ok(ref, 'the branch must be updated');
  assert.equal(ref.body.sha, 'new-commit');
});

test('commitTreeChanges creates a blob only for new content', async () => {
  const calls = mockGitData();
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await client.commitTreeChanges('main', 'Update links', [{ path: 'Other/w.md', contentB64: 'eA==' }]);
  const blobs = calls.filter((c) => c.method === 'POST' && c.url.includes('/git/blobs'));
  assert.equal(blobs.length, 1);
  const tree = calls.find((c) => c.method === 'POST' && c.url.includes('/git/trees'));
  assert.equal(tree.body.tree.length, 1);
  assert.match(String(tree.body.tree[0].sha), /^blob-/);
});

test('commitTreeChanges is atomic: a failed tree means no commit and no branch update', async () => {
  const calls = mockGitData({ failTree: true });
  const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
  await assert.rejects(client.commitTreeChanges('main', 'Delete folder Docs', [{ path: 'Docs/a.md', sha: null }]));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/git/commits')).length, 0);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});