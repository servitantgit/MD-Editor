import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createFileOps } from '../js/file-ops.js';
import { WorkingTree } from '../js/working-tree.js';
import { DraftStore } from '../js/draft-store.js';

// Node has none of the browser globals createFileOps talks to. On a page
// `window` IS the global object, so `window.prompt = …` here and the bare
// `prompt(...)` inside file-ops.js are one and the same binding — mirror
// that, or the prompt overrides below would never reach the handlers.
globalThis.window = globalThis;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.prompt = () => null;

/** Minimal fake client backed by an in-memory Map, recording every request. */
class FakeClient {
  constructor(files) {
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: 'sha-' + p }]));
    this.puts = [];
    this.deletes = [];
  }
  async getFileB64(path) {
    const f = this.files.get(path);
    if (!f) { const e = new Error(`Not Found (${path})`); e.status = 404; throw e; }
    return { b64: Buffer.from(f.text).toString('base64'), sha: f.sha };
  }
  async putFile(path, b64, message, sha) {
    this.files.set(path, { text: Buffer.from(b64, 'base64').toString('utf-8'), sha: 'sha-' + path });
    this.puts.push({ path, message, sha });
    return { content: { sha: 'sha-' + path } };
  }
  async deleteFile(path) {
    this.files.delete(path);
    this.deletes.push(path);
  }
}

/** Build a minimal deps object for createFileOps. */
function makeDeps({ client, allFiles, currentPath = 'Notes/a.md', workingTree, currentSha = 'sha-Notes/a.md', draftStore = null, autosave = null } = {}) {
  const state = {
    client,
    allFiles,
    currentPath,
    currentSha,
    branch: 'main',
    owner: 'o',
    repo: 'r',
  };
  let statusMsg = '';
  let statusIsError = false;
  const deps = {
    els: {},
    getState: () => state,
    getFileTree: () => ({ setDirtyMap: () => {} }),
    getTabs: () => ({ rename: () => {}, paths: [], renameFolder: () => [] }),
    getImageResolver: () => ({ invalidate: () => {} }),
    setSaveStatus: (msg, isError) => { statusMsg = msg; statusIsError = isError; },
    openFile: async () => {},
    loadTree: async () => {},
    dropTabs: async () => {},
    moveTabDoc: () => {},
    markStale: () => {},
    persistTabs: () => {},
    renderTabs: () => {},
    getWorkingTree: () => workingTree,
    getAutosave: () => autosave,
    getDraftStore: () => draftStore,
    refreshCommitBadge: () => {},
  };
  return { deps, status: () => ({ msg: statusMsg, isError: statusIsError }) };
}

test('onMoveFile blocks a dirty file with a message and makes zero GitHub requests', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# local edits', 'sha-Notes/a.md');

  const { deps, status } = makeDeps({ client, allFiles, workingTree });
  const { onMoveFile } = createFileOps(deps);

  await onMoveFile('Notes/a.md', 'Docs');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.equal(workingTree.isDirty('Notes/a.md'), true, 'working tree untouched');
  const { msg, isError } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.equal(isError, true, 'status is an error');
});

test('onMoveFile proceeds when the file is clean', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();

  const { deps } = makeDeps({ client, allFiles, workingTree });
  const { onMoveFile } = createFileOps(deps);

  await onMoveFile('Notes/a.md', 'Docs');

  assert.equal(client.puts.length, 1, 'one put for the move');
  assert.equal(client.deletes.length, 1, 'one delete for the move');
  assert.equal(client.files.has('Notes/a.md'), false, 'old path removed');
  assert.equal(client.files.get('Docs/a.md').text, '# a', 'new path has content');
  assert.equal(workingTree.isDirty('Docs/a.md'), false, 'working tree stays clean');
});

test('onRenameFile blocks a dirty file with a message and makes zero GitHub requests', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# local edits', 'sha-Notes/a.md');

  const { deps, status } = makeDeps({ client, allFiles, workingTree });
  const { onRenameFile } = createFileOps(deps);

  const originalPrompt = window.prompt;
  window.prompt = () => 'b.md';
  try {
    await onRenameFile('Notes/a.md');
  } finally {
    window.prompt = originalPrompt;
  }

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.equal(workingTree.isDirty('Notes/a.md'), true, 'working tree untouched');
  const { msg } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
});

test('onRenameFolder blocks if any file inside is dirty, listing them', async () => {
  const client = new FakeClient({
    'Notes/a.md': '# a',
    'Notes/b.md': '# b',
    'Notes/c.md': '# c',
  });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Notes/b.md', sha: 'sha-b' },
    { path: 'Notes/c.md', sha: 'sha-c' },
  ];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# local a', 'sha-a');
  workingTree.setDirty('Notes/c.md', '# local c', 'sha-c');

  const { deps, status } = makeDeps({ client, allFiles, workingTree, currentPath: 'Notes/a.md' });
  const { onRenameFolder } = createFileOps(deps);

  const originalPrompt = window.prompt;
  window.prompt = () => 'Docs';
  try {
    await onRenameFolder('Notes');
  } finally {
    window.prompt = originalPrompt;
  }

  assert.equal(client.puts.length, 0, 'zero puts — folder rename blocked');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.equal(workingTree.isDirty('Notes/a.md'), true, 'working tree untouched');
  const { msg } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.match(msg, /Notes\/a\.md/, 'lists the dirty file');
  assert.match(msg, /Notes\/c\.md/, 'lists both dirty files');
});

test('onRenameFolder proceeds when no file inside is dirty', async () => {
  const client = new FakeClient({
    'Notes/a.md': '# a',
    'Notes/b.md': '# b',
  });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Notes/b.md', sha: 'sha-b' },
  ];
  const workingTree = new WorkingTree();
  const { deps } = makeDeps({ client, allFiles, workingTree });
  const { onRenameFolder } = createFileOps(deps);

  const originalPrompt = window.prompt;
  window.prompt = () => 'Docs';
  try {
    await onRenameFolder('Notes');
  } finally {
    window.prompt = originalPrompt;
  }

  assert.equal(client.puts.length, 2, 'one put per moved file');
  assert.equal(client.deletes.length, 2, 'one delete per moved file');
  assert.equal(client.files.has('Notes/a.md'), false);
  assert.equal(client.files.get('Docs/a.md').text, '# a');
  assert.equal(client.files.get('Docs/b.md').text, '# b');
  assert.equal(workingTree.getChangeCount(), 0, 'working tree stays clean');
});

test('onMoveFile blocks when the only trace of the edits is a stored draft (working tree empty)', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  // A page reload leaves the in-memory working tree EMPTY while the draft
  // survives in IndexedDB — exactly the case the working-tree-only check missed.
  const workingTree = new WorkingTree();
  const draftStore = new DraftStore({ indexedDB: new IDBFactory() });
  await draftStore.open();
  await draftStore.put({ owner: 'o', repo: 'r', branch: 'main', path: 'Notes/a.md', text: '# local edits' });

  const { deps, status } = makeDeps({ client, allFiles, workingTree, draftStore });
  const { onMoveFile } = createFileOps(deps);

  await onMoveFile('Notes/a.md', 'Docs');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.equal(workingTree.getChangeCount(), 0, 'working tree stays empty');
  const { msg, isError } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.equal(isError, true, 'status is an error');
});

test('onRenameFolder blocks when one file inside has only a stored draft', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a', 'Notes/b.md': '# b' });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Notes/b.md', sha: 'sha-b' },
  ];
  const workingTree = new WorkingTree(); // empty — post-reload state
  const draftStore = new DraftStore({ indexedDB: new IDBFactory() });
  await draftStore.open();
  await draftStore.put({ owner: 'o', repo: 'r', branch: 'main', path: 'Notes/b.md', text: '# b, only locally' });

  const { deps, status } = makeDeps({ client, allFiles, workingTree, draftStore });
  const { onRenameFolder } = createFileOps(deps);

  const originalPrompt = window.prompt;
  window.prompt = () => 'Docs';
  try {
    await onRenameFolder('Notes');
  } finally {
    window.prompt = originalPrompt;
  }

  assert.equal(client.puts.length, 0, 'zero puts — folder rename blocked');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  const { msg, isError } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.match(msg, /Notes\/b\.md/, 'lists the file whose draft is local-only');
  assert.equal(isError, true, 'status is an error');
});

test('onMoveFile blocks when the open file has an unsaved autosave draft (working tree empty)', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  // Typed but not flushed to IndexedDB yet: only the live Autosave knows.
  const autosave = { path: 'Notes/a.md', hasUnsavedDraft: () => true };

  const { deps, status } = makeDeps({ client, allFiles, workingTree, autosave });
  const { onMoveFile } = createFileOps(deps);

  await onMoveFile('Notes/a.md', 'Docs');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  const { msg, isError } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.equal(isError, true, 'status is an error');
});

test('a draft belonging to ANOTHER repository does not block the move', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  const draftStore = new DraftStore({ indexedDB: new IDBFactory() });
  await draftStore.open();
  await draftStore.put({ owner: 'someone-else', repo: 'other-repo', branch: 'main', path: 'Notes/a.md', text: 'their work' });

  const { deps } = makeDeps({ client, allFiles, workingTree, draftStore });
  const { onMoveFile } = createFileOps(deps);

  await onMoveFile('Notes/a.md', 'Docs');

  assert.equal(client.puts.length, 1, 'move proceeds — another repo\'s draft is not ours to protect');
  assert.equal(client.deletes.length, 1, 'one delete for the move');
});