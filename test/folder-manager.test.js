import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameFolder, deleteFolder } from '../js/folder-manager.js';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';

/** Minimal fake client with the same interface as GitHubClient, backed by an in-memory Map. */
class FakeClient {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: 'sha-' + p }]));
    this.warns = [];
    this.gets = [];
    this.puts = [];
    this.deletes = [];
    this.commits = [];
    this.failRead = null;
    this.failCommit = false;
  }
  async getFileB64(path) {
    this.gets.push(path);
    if (path === this.failRead) { const e = new Error(`Read failed (${path})`); e.status = 500; throw e; }
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
    this.deletes.push(path);
    this.files.delete(path);
  }
  // One atomic commit, like GitHubClient.commitTreeChanges: every change or none.
  async commitTreeChanges(branch, message, changes) {
    this.commits.push({ branch, message, changes });
    if (this.failCommit) throw new Error('commit failed (fake)');
    const bySha = new Map([...this.files.values()].map((f) => [f.sha, f]));
    const next = new Map(this.files);
    for (const c of changes) if (c.sha === null || c.contentB64 === null) next.delete(c.path);
    for (const c of changes) {
      if (typeof c.contentB64 === 'string') next.set(c.path, { text: b64ToUtf8(c.contentB64), sha: 'sha-' + c.path });
      else if (typeof c.sha === 'string') {
        const src = bySha.get(c.sha);
        if (!src) throw new Error('unknown blob ' + c.sha);
        next.set(c.path, { text: src.text, sha: c.sha });
      }
    }
    this.files = next;
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

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });

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

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });

  assert.deepEqual(result.moved.sort(), ['Docs/a.md', 'Docs/b.md', 'Docs/c.md']);
  assert.ok(
    client.gets.length <= 3 + totalMd,
    `expected getFileB64 called <= ${3 + totalMd} times (N moves + M repo scan), got ${client.gets.length}`,
  );
});

test('renameFolder rewrites links to two moved files with a single write inside the one commit', async () => {
  const client = new FakeClient({
    'Notes/a.md': '# a\n',
    'Notes/b.md': '# b\n',
    'Outside/watcher.md': '[a](/Notes/a.md) and [b](/Notes/b.md)\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' }, { path: 'Notes/b.md' }, { path: 'Outside/watcher.md' },
  ];

  await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });

  assert.equal(client.files.get('Outside/watcher.md').text, '[a](/Docs/a.md) and [b](/Docs/b.md)\n');
  // The watcher links to TWO moved files but is written exactly once, inside the one commit.
  assert.equal(client.commits.length, 1, 'one commit for the whole rename');
  const watcherWrites = client.commits[0].changes.filter((c) => c.path === 'Outside/watcher.md');
  assert.equal(watcherWrites.length, 1, `watcher.md should be written exactly once, got ${watcherWrites.length}`);
});

test('renameFolder keeps relative links between files inside the moved folder correct', async () => {
  const client = new FakeClient({
    'Notes/a.md': '[b](b.md)\n',   // relative link to a sibling in the same folder
    'Notes/b.md': '# b\n',
  });
  const allFiles = [
    { path: 'Notes/a.md' }, { path: 'Notes/b.md' },
  ];

  const result = await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });

  assert.deepEqual(result.moved.sort(), ['Docs/a.md', 'Docs/b.md']);
  // The relative link b.md from Docs/a.md still resolves to Docs/b.md.
  assert.equal(client.files.get('Docs/a.md').text, '[b](b.md)\n');
});

// ---- Atomic folder operations: one commit, all or nothing ----
test('renameFolder is ONE commit on the given branch: no per-file writes, a picture moves by its sha', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a\n', 'Notes/pic.png': 'PNG', 'Outside/w.md': '[a](/Notes/a.md)\n' });
  const allFiles = [...client.files.keys()].map((p) => ({ path: p, sha: 'sha-' + p }));
  await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });
  assert.equal(client.commits.length, 1, 'exactly one commit');
  assert.equal(client.commits[0].branch, 'main');
  assert.equal(client.puts.length, 0, 'no per-file PUT');
  assert.equal(client.deletes.length, 0, 'no per-file DELETE');
  assert.deepEqual([...client.files.keys()].sort(), ['Docs/a.md', 'Docs/pic.png', 'Outside/w.md']);
  assert.equal(client.files.get('Docs/pic.png').text, 'PNG');
  assert.equal(client.files.get('Outside/w.md').text, '[a](/Docs/a.md)\n');
  const pic = client.commits[0].changes.find((c) => c.path === 'Docs/pic.png');
  assert.equal(pic.sha, 'sha-Notes/pic.png', 'a non-markdown file is not re-uploaded');
  assert.ok(!client.gets.includes('Notes/pic.png'), 'a non-markdown file is not even read');
});

test('renameFolder changes nothing when a file of the folder cannot be read', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a\n', 'Notes/b.md': '# b\n' });
  client.failRead = 'Notes/b.md';
  const allFiles = [{ path: 'Notes/a.md' }, { path: 'Notes/b.md' }];
  await assert.rejects(renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' }));
  assert.deepEqual([...client.files.keys()].sort(), ['Notes/a.md', 'Notes/b.md'], 'the repository is untouched');
  assert.equal(client.commits.length, 0);
});

test('deleteFolder removes every file in ONE commit', async () => {
  const client = new FakeClient({ 'Docs/a.md': '# a\n', 'Docs/Sub/b.md': '# b\n', 'Other/c.md': '# c\n' });
  const allFiles = [...client.files.keys()].map((p) => ({ path: p, sha: 'sha-' + p }));
  const deleted = await deleteFolder(client, allFiles, 'Docs', { branch: 'main' });
  assert.deepEqual(deleted.sort(), ['Docs/Sub/b.md', 'Docs/a.md']);
  assert.equal(client.commits.length, 1);
  assert.equal(client.deletes.length, 0, 'no per-file DELETE');
  assert.deepEqual([...client.files.keys()], ['Other/c.md']);
});

test('deleteFolder leaves every file in place when the commit fails', async () => {
  const client = new FakeClient({ 'Docs/a.md': '# a\n', 'Docs/b.md': '# b\n' });
  client.failCommit = true;
  const allFiles = [...client.files.keys()].map((p) => ({ path: p, sha: 'sha-' + p }));
  await assert.rejects(deleteFolder(client, allFiles, 'Docs', { branch: 'main' }));
  assert.deepEqual([...client.files.keys()].sort(), ['Docs/a.md', 'Docs/b.md']);
});

test('renameFolder updates [[Folder/Note]] wiki links in other notes, in the same one commit', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a\n', 'Outside/w.md': 'See [[Notes/a]] and [[Notes/a.md|alias]].\n' });
  const allFiles = [...client.files.keys()].map((p) => ({ path: p, sha: 'sha-' + p }));
  await renameFolder(client, allFiles, 'Notes', 'Docs', { branch: 'main' });
  assert.equal(client.commits.length, 1, 'one commit');
  assert.equal(client.files.get('Outside/w.md').text, 'See [[Docs/a]] and [[Docs/a.md|alias]].\n');
});