import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameFolder } from '../js/folder-manager.js';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';

/** Minimal fake client with the same interface as GitHubClient, backed by an in-memory Map. */
class FakeClient {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: 'sha-' + p }]));
    this.warns = [];
  }
  async getFileB64(path) {
    const f = this.files.get(path);
    if (!f) { const e = new Error(`Not Found (${path})`); e.status = 404; throw e; }
    return { b64: utf8ToB64(f.text), sha: f.sha };
  }
  async putFile(path, b64, message, sha) {
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