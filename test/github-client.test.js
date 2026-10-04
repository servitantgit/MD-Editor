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