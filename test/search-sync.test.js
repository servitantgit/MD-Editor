import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { IDBFactory } from 'fake-indexeddb';
import { SearchSync } from '../js/search-sync.js';
import { SearchStore } from '../js/search-store.js';
import { SearchIndex, createSearchIndex, diffTree, isMarkdownPath } from '../js/search-index.js';

/** A fake GitHub client that returns controlled responses. */
class FakeGitHubClient {
  constructor({ tree = [], files = {}, shouldFail = new Set() } = {}) {
    this.tree = tree;
    this.files = files;
    this.shouldFail = shouldFail;
    this.getTreeCalls = 0;
    this.getFileCalls = [];
  }

  async getTree() {
    this.getTreeCalls++;
    return this.tree.map(f => ({ path: f.path, sha: f.sha }));
  }

  async getFileB64(path) {
    this.getFileCalls.push(path);
    if (this.shouldFail.has(path)) {
      const err = new Error('Network error');
      err.status = 500;
      throw err;
    }
    const file = this.files[path];
    if (!file) {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    }
    const b64 = Buffer.from(file.body, 'utf-8').toString('base64');
    return { b64, sha: file.sha };
  }
}

/** A SearchStore on a private fake database. */
function newStore({ now = () => 1_000_000 } = {}) {
  return new SearchStore({ indexedDB: new IDBFactory(), now });
}

/** A fresh SearchSync instance with fake dependencies. */
function newSync({ client, store, owner = 'owner', repo = 'repo', branch = 'main', onProgress, onDone } = {}) {
  return new SearchSync({
    client,
    store,
    owner,
    repo,
    branch,
    MiniSearchCtor: MiniSearch,
    onProgress,
    onDone,
  });
}

const SAMPLE_TREE = [
  { path: 'Notes/a.md', sha: 'sha-a' },
  { path: 'Notes/b.md', sha: 'sha-b' },
  { path: 'Asset/pic.jpg', sha: 'sha-pic' }, // non-markdown
  { path: 'README.md', sha: 'sha-readme' },
];

const SAMPLE_FILES = {
  'Notes/a.md': { sha: 'sha-a', body: '# Note A\n\nContent about pancakes.' },
  'Notes/b.md': { sha: 'sha-b', body: '# Note B\n\nContent about waffles.' },
  'README.md': { sha: 'sha-readme', body: '# Readme\n\nProject overview.' },
};

test('search-sync: first sync indexes all .md files, ignores non-.md', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  const result = await sync.run(SAMPLE_TREE);

  assert.equal(result.indexed, 3, 'should index 3 markdown files');
  assert.equal(result.removed, 0);
  assert.equal(sync.index.size, 3);

  const results = sync.index.query('pancakes');
  assert.deepEqual(results.map(r => r.path).sort(), ['Notes/a.md']);
  // Non-markdown files should not be indexed
  assert.equal(isMarkdownPath('Asset/pic.jpg'), false);
  assert.ok(!sync.index.query('pic').length, 'non-md file should not be indexed');
});

test('search-sync: repeat sync with same tree does not fetch but updates lastSyncedAt', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);
  const firstSyncedAt = sync.lastSyncedAt;
  assert.ok(firstSyncedAt > 0, 'lastSyncedAt should be set');

  // Same sync instance, same tree - no fetches
  client.getFileCalls = [];
  await sync.run(SAMPLE_TREE);

  assert.ok(sync.lastSyncedAt >= firstSyncedAt, 'lastSyncedAt should be updated or same');
  assert.equal(client.getFileCalls.length, 0, 'no file fetches on unchanged tree');
});

test('search-sync: changed sha triggers re-fetch of only that file', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);
  assert.equal(client.getFileCalls.length, 3, 'first sync fetches all 3');

  // Change one file's sha
  const changedTree = [
    { path: 'Notes/a.md', sha: 'sha-a-new' },
    { path: 'Notes/b.md', sha: 'sha-b' },
    { path: 'README.md', sha: 'sha-readme' },
  ];
  const changedFiles = {
    ...SAMPLE_FILES,
    'Notes/a.md': { sha: 'sha-a-new', body: '# Note A\n\nUpdated content about pancakes.' },
  };
  client.tree = changedTree;
  client.files = changedFiles;
  client.getFileCalls = [];

  await sync.run(changedTree);

  assert.equal(client.getFileCalls.length, 1, 'should only fetch changed file');
  assert.equal(client.getFileCalls[0], 'Notes/a.md');
});

test('search-sync: deleted file is removed from index via discard', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);
  assert.equal(sync.index.size, 3);

  // Delete one file (Notes/b.md which has 'waffles' content)
  const deletedTree = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'README.md', sha: 'sha-readme' },
  ];
  client.tree = deletedTree;
  client.files = { 'Notes/a.md': SAMPLE_FILES['Notes/a.md'], 'README.md': SAMPLE_FILES['README.md'] };

  await sync.run(deletedTree);

  assert.equal(sync.index.size, 2, 'index should have 2 files after deletion');
  // The deleted file had 'waffles' content - it should no longer be searchable
  const results = sync.index.query('waffles');
  assert.equal(results.length, 0, 'deleted file should not appear in results');
  // But the remaining file with 'pancakes' should still be searchable
  assert.ok(sync.index.query('pancakes').length > 0);
});

test('search-sync: empty tree after last file deleted still syncs', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);
  assert.equal(sync.index.size, 3);

  // Empty tree (all files deleted)
  client.tree = [];
  client.files = {};

  const result = await sync.run([]);

  assert.equal(result.removed, 3, 'should report 3 removed');
  assert.equal(sync.index.size, 0, 'index should be empty');
  assert.ok(sync.lastSyncedAt > 0, 'lastSyncedAt should be updated');
});

test('search-sync: force reindex (force: true) re-fetches all files', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);
  assert.equal(client.getFileCalls.length, 3);

  client.getFileCalls = [];
  await sync.run(SAMPLE_TREE, { force: true });

  assert.equal(client.getFileCalls.length, 3, 'force should re-fetch all files');
});

test('search-sync: file fetch error does not abort entire sync', async () => {
  const client = new FakeGitHubClient({
    tree: SAMPLE_TREE,
    files: SAMPLE_FILES,
    shouldFail: new Set(['Notes/b.md']),
  });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  const result = await sync.run(SAMPLE_TREE);

  // Notes/b.md failed, but a.md and README.md should still be indexed
  assert.equal(result.indexed, 2, 'should index 2 of 3 files');
  assert.equal(sync.index.size, 2);
  assert.ok(sync.index.query('pancakes').length > 0);
  assert.ok(sync.index.query('waffles').length === 0); // b.md failed
  assert.ok(sync.index.query('overview').length > 0);
});

test('search-sync: destroy() during sync stops further writes to store', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  // Start sync but destroy before it completes
  const runPromise = sync.run(SAMPLE_TREE);
  sync.destroy();
  await runPromise; // should not throw

  // The sync should have been cut short
  assert.equal(sync.destroyed, true);
});

test('search-sync: progress callback reports done/total', async () => {
  const client = new FakeGitHubClient({ tree: SAMPLE_TREE, files: SAMPLE_FILES });
  const store = newStore();
  const progress = [];
  const sync = newSync({ client, store, onProgress: (done, total) => progress.push({ done, total }) });

  await sync.hydrate();
  await sync.run(SAMPLE_TREE);

  assert.ok(progress.length > 0, 'progress callback should be called');
  const last = progress[progress.length - 1];
  assert.equal(last.done, 3, 'final progress should be 3/3');
  assert.equal(last.total, 3);
  // Progress should be monotonically increasing
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].done >= progress[i - 1].done);
  }
});

test('search-sync: diffTree reports every file as REMOVED for emptied repository', () => {
  const manifest = { 'Notes/a.md': 'sha-a', 'Notes/b.md': 'sha-b' };
  const emptyTree = [];
  const { added, removed, changed } = diffTree(emptyTree, manifest);
  assert.equal(added.length, 0);
  assert.equal(changed.length, 0);
  assert.deepEqual(removed.sort(), ['Notes/a.md', 'Notes/b.md'].sort());
});

test('search-sync: hydrate loads persisted index and manifest', async () => {
  const store = newStore();
  const serialized = JSON.stringify({
    invertedIndex: {},
    documents: {},
    documentCount: 0,
  });
  await store.put({
    key: 'owner/repo@main',
    serializedIndex: serialized,
    manifest: { 'Existing.md': 'sha-existing' },
  });

  const client = new FakeGitHubClient({ tree: [], files: {} });
  const sync = newSync({ client, store });

  const size = await sync.hydrate();
  assert.equal(size, 0, 'empty index has size 0');
  assert.deepEqual(sync.manifest, { 'Existing.md': 'sha-existing' });
});

test('search-sync: removed and changed paths are removed from index before new versions added', async () => {
  const client = new FakeGitHubClient({
    tree: [
      { path: 'Notes/a.md', sha: 'sha-a' },
    ],
    files: {
      'Notes/a.md': { sha: 'sha-a', body: '# A\n\nOriginal content.' },
    },
  });
  const store = newStore();
  const sync = newSync({ client, store });

  await sync.hydrate();
  await sync.run(client.tree);
  assert.equal(sync.index.size, 1);
  assert.ok(sync.index.query('Original').length > 0);

  // Change the file
  client.tree = [{ path: 'Notes/a.md', sha: 'sha-a-new' }];
  client.files = { 'Notes/a.md': { sha: 'sha-a-new', body: '# A\n\nNew content.' } };
  client.getFileCalls = [];

  await sync.run(client.tree);

  // The old version should be removed, new version added
  assert.equal(sync.index.size, 1);
  assert.equal(sync.index.query('Original').length, 0, 'old content should be gone');
  assert.ok(sync.index.query('New').length > 0, 'new content should be indexed');
});