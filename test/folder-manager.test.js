import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameFolder } from '../js/folder-manager.js';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';

/** Minimal fake client with the same interface as GitHubClient, backed by an in-memory Map. */
class FakeClient {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: 'sha-' + p }]));
    this.warns = [];
    this.gets = [];
    this.puts = [];
  }
  async getFileB64(path) {
    this.gets.push(path);
    const f = this.files.get(path);
    if (!f) { const e = new Error(`Not Found (${path})`); e.status = 404; throw e; }
    return { b64: utf8ToB64(f.text), sha: f.sha };
  }
  async putFile(path, b64, message, sha) {
    this.puts.push({ path, message, sha });
    if (this.files.has(path) && !sha) {
      const e = new Error('Invalid request. "sha" wasn\'t supplied.');
      e.status = 422;
      throw e;
    }
    this.files.set(path, { text: b64ToUtf8(b64), sha: 'sha-' + path });
  }
  async deleteFile(path) {
    this.files.delete(path);
  }
}

test('renameFolder rewrites root-absolute links between files that the folder move already relocated', async () => {
  // `a.md` links to its neighbour with a root-absolute link. Both files travel
  // from Notes/ to Docs/ together, so that link must be retargeted to /Docs/b.md.
  // Relative links would survive on their own (same relative position), but an
  // absolute one names the folder explicitly and goes stale the moment the
  // folder is renamed.
  const client = new FakeClient({
    'Notes/a.md': '[b](/Notes/b.md)\n',
    'Notes/b.md': '# b\n',
    'Outside/watcher.md': '[b](/Notes/b.md)\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' },
    { path: 'Notes/b.md' },
    { path: 'Outside/watcher.md' },
  ];

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs');

  assert.deepEqual(result.moved.sort(), ['Docs/a.md', 'Docs/b.md']);
  assert.equal(client.files.get('Docs/a.md').text, '[b](/Docs/b.md)\n');
  assert.equal(client.files.get('Outside/watcher.md').text, '[b](/Docs/b.md)\n');
  // The files the stale snapshot still named under Notes/ must not linger as
  // "files that could not be updated" — they are gone from the repo entirely.
  assert.ok(result.updatedFiles.includes('Docs/a.md'), `a.md was never updated: ${result.updatedFiles}`);
// The snapshot belongs to the caller, which reuses it for the tree refresh;
  // keeping the moved paths in sync must happen on a private copy.
  assert.deepEqual(allFiles.map((f) => f.path), ['Notes/a.md', 'Notes/b.md', 'Outside/watcher.md']);
});

test('renameFolder reads each .md at most once in the reference pass (request count)', async () => {
  // N = 3 moved files, M = 8 total .md files in the repo.
  // Phase 1: N getFileB64 (one per move). Phase 2: M getFileB64 (one per .md).
  // Total <= N + M = 11. The old code does N + N×M = 27.
  const client = new FakeClient({
    'Notes/a.md': '# a\n',
    'Notes/b.md': '# b\n',
    'Notes/c.md': '# c\n',
    'Other/x.md': '# x\n',
    'Other/y.md': '# y\n',
    'Other/z.md': '# z\n',
    'Other/w.md': '# w\n',
    'Other/v.md': '# v\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' }, { path: 'Notes/b.md' }, { path: 'Notes/c.md' },
    { path: 'Other/x.md' }, { path: 'Other/y.md' }, { path: 'Other/z.md' },
    { path: 'Other/w.md' }, { path: 'Other/v.md' },
  ];
  const totalMd = allFiles.filter((f) => f.path.endsWith('.md')).length;

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs');

  assert.deepEqual(result.moved.sort(), ['Docs/a.md', 'Docs/b.md', 'Docs/c.md']);
  assert.ok(
    client.gets.length <= 3 + totalMd,
    `expected getFileB64 called <= ${3 + totalMd} times (N moves + M repo scan), got ${client.gets.length}`,
  );
});

test('renameFolder rewrites links to two moved files in a single PUT', async () => {
  const client = new FakeClient({
    'Notes/a.md': '# a\n',
    'Notes/b.md': '# b\n',
    'Outside/watcher.md': '[a](/Notes/a.md) and [b](/Notes/b.md)\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' }, { path: 'Notes/b.md' }, { path: 'Outside/watcher.md' },
  ];

  await renameFolder(client, allFiles, 'Notes', 'Docs');

  assert.equal(client.files.get('Outside/watcher.md').text, '[a](/Docs/a.md) and [b](/Docs/b.md)\n');
  // The watcher file links to TWO moved files but must be written back exactly once.
  const watcherPuts = client.puts.filter((p) => p.path === 'Outside/watcher.md');
  assert.equal(watcherPuts.length, 1, `watcher.md should be PUT exactly once, got ${watcherPuts.length}`);
});

test('renameFolder keeps relative links between files inside the moved folder correct', async () => {
  const client = new FakeClient({
    'Notes/a.md': '[b](b.md)\n',   // relative link to a sibling in the same folder
    'Notes/b.md': '# b\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' }, { path: 'Notes/b.md' },
  ];

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs');

  assert.deepEqual(result.moved.sort(), ['Docs/a.md', 'Docs/b.md']);
  // The relative link b.md from Docs/a.md still resolves to Docs/b.md.
  assert.equal(client.files.get('Docs/a.md').text, '[b](b.md)\n');
});