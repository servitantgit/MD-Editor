import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, utf8ToB64 } from '../js/github-client.js';

async function withGitData(fn) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let blobs = 0;
  const ok = (body) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null }
  });
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/git/ref/heads/main')) {
      return ok({ object: { sha: 'parent-sha' } });
    }
    if (method === 'GET' && path.endsWith('/git/commits/parent-sha')) {
      return ok({ tree: { sha: 'base-tree' } });
    }
    if (method === 'POST' && path.endsWith('/git/blobs')) {
      return ok({ sha: 'blob-' + (++blobs) });
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      return ok({ sha: 'new-tree' });
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      return ok({ sha: 'new-commit' });
    }
    if (method === 'PATCH' && path.endsWith('/git/refs/heads/main')) {
      return ok({ object: { sha: 'new-commit' } });
    }
    throw new Error('unexpected API call: ' + method + ' ' + path);
  };
  try {
    const client = new GitHubClient({ token: 'fake', owner: 'o', repo: 'r' });
    await fn(client, calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('Commit API (guard): result maps each path to its created blob SHA, including empty text', async () => {
  await withGitData(async (client, calls) => {
    const unicodeText = '\u041d\u043e\u0442\u0430\u0442\u043a\u0430\n';
    const result = await client.commitFiles('main', 'Two snapshots', [
      { path: 'Notes/a.md', contentB64: utf8ToB64(unicodeText) },
      { path: 'Notes/empty.md', contentB64: utf8ToB64('') }
    ]);
    assert.deepEqual(result.files, [
      { path: 'Notes/a.md', sha: 'blob-1' },
      { path: 'Notes/empty.md', sha: 'blob-2' }
    ]);
    assert.equal(result.commit.sha, 'new-commit');
    const blobCalls = calls.filter((c) =>
      c.method === 'POST' && c.path.endsWith('/git/blobs'));
    assert.deepEqual(blobCalls.map((c) => c.body), [
      { content: utf8ToB64(unicodeText), encoding: 'base64' },
      { content: '', encoding: 'base64' }
    ]);
    const treeCalls = calls.filter((c) =>
      c.method === 'POST' && c.path.endsWith('/git/trees'));
    assert.equal(treeCalls.length, 1);
    assert.deepEqual(treeCalls[0].body.tree, [
      { path: 'Notes/a.md', mode: '100644', type: 'blob', sha: 'blob-1' },
      { path: 'Notes/empty.md', mode: '100644', type: 'blob', sha: 'blob-2' }
    ]);
  });
});

test('Commit API (guard): one commit updates ref with force false and no Contents writes', async () => {
  await withGitData(async (client, calls) => {
    await client.commitFiles('main', 'Two snapshots', [
      { path: 'a.md', contentB64: utf8ToB64('A') },
      { path: 'b.md', contentB64: utf8ToB64('B') }
    ]);
    const commits = calls.filter((c) =>
      c.method === 'POST' && c.path.endsWith('/git/commits'));
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].body, {
      message: 'Two snapshots', tree: 'new-tree', parents: ['parent-sha']
    });
    const refs = calls.filter((c) => c.method === 'PATCH');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, '/repos/o/r/git/refs/heads/main');
    assert.deepEqual(refs[0].body, { sha: 'new-commit', force: false });
    assert.equal(calls.filter((c) => c.path.includes('/contents/')).length, 0);
    assert.equal(calls.filter((c) =>
      c.method === 'POST' && c.path.endsWith('/git/trees')).length, 1);
  });
});
