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

Object.defineProperty(globalThis, 'navigator', {
  value: {
    clipboard: {
      writeText: async (text) => { lastClipboardText = text; },
    },
  },
  configurable: true,
  writable: true,
});
let lastClipboardText = null;

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
    els: { currentFileLabel: { textContent: '' } },
    getState: () => state,
    getFileTree: () => ({ setDirtyMap: () => {}, setFiles: () => {}, getActiveFolder: () => '', setActiveFolder: () => {} }),
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

test('onMoveFolder refuses to move a folder into its own descendant (zero requests)', async () => {
  const client = new FakeClient({ 'Notes/Sub/a.md': '# a' });
  const allFiles = [{ path: 'Notes/Sub/a.md', sha: 'sha-a' }];
  const { deps, status } = makeDeps({ client, allFiles, workingTree: new WorkingTree() });
  const { onMoveFolder } = createFileOps(deps);

  await onMoveFolder('Notes', 'Notes/Sub');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  const { msg, isError } = status();
  assert.match(msg, /into itself/, 'status explains a folder cannot contain itself');
  assert.equal(isError, true, 'status is an error');
});

test('onMoveFolder refuses when that name exists in the target (zero requests)', async () => {
  const client = new FakeClient({
    'Notes/a.md': '# a',
    'Docs/Notes/keep.txt': 'x',
  });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Docs/Notes/keep.txt', sha: 'sha-k' },
  ];
  const { deps, status } = makeDeps({ client, allFiles, workingTree: new WorkingTree() });
  const { onMoveFolder } = createFileOps(deps);

  await onMoveFolder('Notes', 'Docs');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  const { msg, isError } = status();
  assert.match(msg, /already exists/, 'status names the collision');
  assert.equal(isError, true, 'status is an error');
});

test('onMoveFolder is a no-op when the folder is already in the target (zero requests)', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a', 'Notes/Sub/b.md': '# b' });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Notes/Sub/b.md', sha: 'sha-b' },
  ];
  const { deps, status } = makeDeps({ client, allFiles, workingTree: new WorkingTree() });
  const { onMoveFolder } = createFileOps(deps);

  // Root strip onto a folder that is already at the root.
  await onMoveFolder('Notes', '');
  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.match(status().msg, /already in/, 'says the folder is already there');

  // Its current parent.
  await onMoveFolder('Notes/Sub', 'Notes');
  assert.equal(client.puts.length, 0, 'still zero puts');
  assert.match(status().msg, /already in/);
});

test('onMoveFolder sends nothing when the confirm is cancelled', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-a' }];
  const { deps, status } = makeDeps({ client, allFiles, workingTree: new WorkingTree() });
  const { onMoveFolder } = createFileOps(deps);

  const seen = [];
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = (msg) => { seen.push(msg); return false; };
  try {
    await onMoveFolder('Notes', 'Docs');
  } finally {
    globalThis.confirm = originalConfirm;
  }

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  assert.equal(seen.length, 1, 'exactly one confirm was shown');
  assert.match(seen[0], /Move "Notes"/, 'names the folder');
  assert.match(seen[0], /1 file/, 'shows the file count');
  assert.match(seen[0], /Docs/, 'shows the destination');
  assert.match(status().msg, /cancelled/i);
});

test('onMoveFolder to the repository root moves the folder up (Notes/Sub → Sub)', async () => {
  const client = new FakeClient({ 'Notes/Sub/a.md': '# a' });
  const allFiles = [{ path: 'Notes/Sub/a.md', sha: 'sha-a' }];
  const workingTree = new WorkingTree();
  const { deps, status } = makeDeps({ client, allFiles, workingTree });
  const { onMoveFolder } = createFileOps(deps);

  await onMoveFolder('Notes/Sub', '');

  assert.equal(client.puts.length, 1, 'one put for the moved file');
  assert.equal(client.deletes.length, 1, 'one delete for the old path');
  assert.equal(client.files.has('Notes/Sub/a.md'), false, 'old path removed');
  assert.equal(client.files.get('Sub/a.md').text, '# a', 'file lands in the root-level folder');
  assert.match(status().msg, /Moved: Notes\/Sub → Sub/, 'status reports the landing spot');
  assert.equal(status().isError, false, 'move reported as success');
});

test('onMoveFolder blocks when a file inside has unsaved edits (zero requests)', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a', 'Notes/b.md': '# b' });
  const allFiles = [
    { path: 'Notes/a.md', sha: 'sha-a' },
    { path: 'Notes/b.md', sha: 'sha-b' },
  ];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/b.md', '# local b', 'sha-b');
  const { deps, status } = makeDeps({ client, allFiles, workingTree });
  const { onMoveFolder } = createFileOps(deps);

  await onMoveFolder('Notes', 'Docs');

  assert.equal(client.puts.length, 0, 'zero puts');
  assert.equal(client.deletes.length, 0, 'zero deletes');
  const { msg, isError } = status();
  assert.match(msg, /unsaved changes/, 'status mentions unsaved changes');
  assert.match(msg, /Notes\/b\.md/, 'lists the dirty file');
  assert.equal(isError, true, 'status is an error');
});

test('a successful onMoveFolder renames tabs and working-tree entries to the new paths', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-a' }];
  const workingTree = new WorkingTree();

  // The user types into the file WHILE the async pre-check has already run:
  // the move goes through (the check saw a clean tree), and the post-move
  // steps must still carry the freshly-created entry to the new path.
  const realPut = client.putFile.bind(client);
  client.putFile = async (path, b64, message, sha) => {
    workingTree.setDirty('Notes/a.md', '# typed mid-move', sha || 'sha-a');
    return realPut(path, b64, message, sha);
  };

  const { deps, status } = makeDeps({ client, allFiles, workingTree });
  const renameFolderCalls = [];
  const tabMoves = [];
  deps.getTabs = () => ({
    rename: () => {},
    paths: [],
    renameFolder: (from, to) => {
      renameFolderCalls.push([from, to]);
      // Mirror the real tabs model: rebase the file's path under the new folder.
      return [['Notes/a.md', `${to}/a.md`]];
    },
  });
  deps.moveTabDoc = (from, to) => tabMoves.push([from, to]);
  const loadOpts = [];
  deps.loadTree = async (opts) => { loadOpts.push(opts); };

  const { onMoveFolder } = createFileOps(deps);
  await onMoveFolder('Notes', 'Docs');

  assert.equal(client.puts.length, 1, 'one put for the move');
  assert.equal(client.deletes.length, 1, 'one delete for the move');
  assert.equal(client.files.has('Notes/a.md'), false, 'old path removed');
  assert.equal(client.files.get('Docs/Notes/a.md').text, '# a', 'file lands inside the target folder');
  assert.deepEqual(renameFolderCalls, [['Notes', 'Docs/Notes']], 'tabs model told about the folder rename');
  assert.deepEqual(tabMoves, [['Notes/a.md', 'Docs/Notes/a.md']], 'tab document moved to the new path');
  assert.equal(workingTree.isDirty('Notes/a.md'), false, 'old working-tree entry gone');
  assert.equal(workingTree.isDirty('Docs/Notes/a.md'), true, 'working-tree entry followed the file');
  assert.deepEqual(
    loadOpts[0],
    { expandFolder: 'Docs/Notes', rewritePrefix: { from: 'Notes', to: 'Docs/Notes' } },
    'tree reloads with destination expanded and lag-safe prefix rewrite'
  );
  assert.equal(status().isError, false, 'move reported as success');
  assert.match(status().msg, /Moved: Notes → Docs\/Notes/);
})
test('onCopyLinkToFile produces a root-absolute link from a different folder depth', async () => {
  const client = new FakeClient({});
  const allFiles = [];
  const { deps, status } = makeDeps({ client, allFiles, currentPath: 'Notes/a.md' });
  const { onCopyLinkToFile } = createFileOps(deps);

  lastClipboardText = null;
  await onCopyLinkToFile('AI corrected/SSAM 1 - 2/Lasery Hood.md');

  assert.equal(lastClipboardText, '[Lasery Hood](</AI corrected/SSAM 1 - 2/Lasery Hood.md>)', 'root-absolute link with angle brackets');
  const { msg } = status();
  assert.match(msg, /Link copied: Lasery Hood.md/, 'status reports link copied');
});

test('onCopyLinkToFile produces a root-absolute link from the same folder', async () => {
  const client = new FakeClient({});
  const allFiles = [];
  const { deps, status } = makeDeps({ client, allFiles, currentPath: 'Notes/a.md' });
  const { onCopyLinkToFile } = createFileOps(deps);

  lastClipboardText = null;
  await onCopyLinkToFile('Notes/b.md');

  assert.equal(lastClipboardText, '[b](/Notes/b.md)', 'root-absolute link without angle brackets');
  const { msg } = status();
  assert.match(msg, /Link copied: b.md/, 'status reports link copied');
});

test('onCopyLinkToFile produces a root-absolute link with no open file', async () => {
  const client = new FakeClient({});
  const allFiles = [];
  const { deps, status } = makeDeps({ client, allFiles, currentPath: null });
  const { onCopyLinkToFile } = createFileOps(deps);

  lastClipboardText = null;
  await onCopyLinkToFile('Notes/note.md');

  assert.equal(lastClipboardText, '[note](/Notes/note.md)', 'root-absolute link regardless of open file');
  const { msg } = status();
  assert.match(msg, /Link copied: note.md/, 'status reports link copied');
});

test('onCopyLinkToFile omits angle brackets when the path has no spaces or parens', async () => {
  const client = new FakeClient({});
  const allFiles = [];
  const { deps } = makeDeps({ client, allFiles, currentPath: 'Notes/a.md' });
  const { onCopyLinkToFile } = createFileOps(deps);

  lastClipboardText = null;
  await onCopyLinkToFile('Notes/note.md');

  assert.equal(lastClipboardText, '[note](/Notes/note.md)', 'no angle brackets for simple path');
});

test('onCopyLinkToFile keeps the extension in the display name for non-.md files', async () => {
  const client = new FakeClient({});
  const allFiles = [];
  const { deps } = makeDeps({ client, allFiles, currentPath: 'Notes/a.md' });
  const { onCopyLinkToFile } = createFileOps(deps);

  lastClipboardText = null;
  await onCopyLinkToFile('Notes/image.png');

  assert.equal(lastClipboardText, '[image.png](/Notes/image.png)', 'extension kept in display name');
});
;

/** Records which draft paths were deleted; reports no stored drafts. */
function fakeDraftStore() {
  return {
    deleted: [],
    async get() { return null; },
    async delete(ref) { this.deleted.push(ref.path); },
  };
}

test('onDeleteFileAt drops the deleted file from the working tree and deletes its draft', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a', 'Notes/b.md': '# b' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }, { path: 'Notes/b.md', sha: 'sha-Notes/b.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# unsaved', 'sha-Notes/a.md');
  workingTree.setDirty('Notes/b.md', '# other', 'sha-Notes/b.md');
  const draftStore = fakeDraftStore();
  const { deps } = makeDeps({ client, allFiles, currentPath: null, currentSha: null, workingTree, draftStore });
  const ops = createFileOps(deps);
  await ops.onDeleteFileAt('Notes/a.md');
  assert.deepEqual(client.deletes, ['Notes/a.md']);
  assert.equal(workingTree.isDirty('Notes/a.md'), false);
  assert.equal(workingTree.isDirty('Notes/b.md'), true);
  assert.deepEqual(draftStore.deleted, ['Notes/a.md']);
});

test('onDeleteFile (toolbar) drops the open file from the working tree and deletes its draft', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# unsaved', 'sha-Notes/a.md');
  const draftStore = fakeDraftStore();
  const { deps } = makeDeps({ client, allFiles, workingTree, draftStore });
  deps.els.btnDelete = { disabled: false };
  deps.els.btnSave = { disabled: false };
  const ops = createFileOps(deps);
  await ops.onDeleteFile();
  assert.deepEqual(client.deletes, ['Notes/a.md']);
  assert.equal(workingTree.isDirty('Notes/a.md'), false);
  assert.deepEqual(draftStore.deleted, ['Notes/a.md']);
});

test('onDeleteFolder drops every file under the folder (incl. never-committed) and nothing outside it', async () => {
  const client = new FakeClient({ 'Docs/a.md': '# a', 'Docs/Sub/b.md': '# b', 'Other/c.md': '# c' });
  const allFiles = [
    { path: 'Docs/a.md', sha: 'sha-Docs/a.md' },
    { path: 'Docs/Sub/b.md', sha: 'sha-Docs/Sub/b.md' },
    { path: 'Other/c.md', sha: 'sha-Other/c.md' },
  ];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Docs/a.md', '# unsaved', 'sha-Docs/a.md');
  workingTree.setDirty('Docs/new.md', '# never committed', null);
  workingTree.setDirty('Other/c.md', '# keep', 'sha-Other/c.md');
  workingTree.setDirty('Docsx/d.md', '# keep, other folder', null);
  const draftStore = fakeDraftStore();
  const { deps } = makeDeps({ client, allFiles, currentPath: null, currentSha: null, workingTree, draftStore });
  const ops = createFileOps(deps);
  await ops.onDeleteFolder('Docs');
  assert.equal(workingTree.isDirty('Docs/a.md'), false);
  assert.equal(workingTree.isDirty('Docs/new.md'), false);
  assert.equal(workingTree.isDirty('Other/c.md'), true);
  assert.equal(workingTree.isDirty('Docsx/d.md'), true);
  assert.deepEqual(draftStore.deleted.slice().sort(), ['Docs/Sub/b.md', 'Docs/a.md', 'Docs/new.md']);
});

test('a failed delete keeps the unsaved edits and the draft (guard)', async () => {
  class FailingClient extends FakeClient {
    async deleteFile() { throw new Error('boom'); }
  }
  const client = new FailingClient({ 'Notes/a.md': '# a' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# unsaved', 'sha-Notes/a.md');
  const draftStore = fakeDraftStore();
  const { deps } = makeDeps({ client, allFiles, currentPath: null, currentSha: null, workingTree, draftStore });
  const ops = createFileOps(deps);
  await ops.onDeleteFileAt('Notes/a.md');
  assert.equal(workingTree.isDirty('Notes/a.md'), true);
  assert.deepEqual(draftStore.deleted, []);
});

test('the delete confirm warns only when the file has unsaved edits', async () => {
  const client = new FakeClient({ 'Notes/a.md': '# a', 'Notes/b.md': '# b' });
  const allFiles = [{ path: 'Notes/a.md', sha: 'sha-Notes/a.md' }, { path: 'Notes/b.md', sha: 'sha-Notes/b.md' }];
  const workingTree = new WorkingTree();
  workingTree.setDirty('Notes/a.md', '# unsaved', 'sha-Notes/a.md');
  const { deps } = makeDeps({ client, allFiles, currentPath: null, currentSha: null, workingTree, draftStore: fakeDraftStore() });
  const ops = createFileOps(deps);
  const messages = [];
  const original = globalThis.confirm;
  globalThis.confirm = (m) => { messages.push(m); return false; };
  try {
    await ops.onDeleteFileAt('Notes/a.md');
    await ops.onDeleteFileAt('Notes/b.md');
  } finally {
    globalThis.confirm = original;
  }
  assert.equal(messages.length, 2);
  assert.match(messages[0], /unsaved/i);
  assert.doesNotMatch(messages[1], /unsaved/i);
  assert.deepEqual(client.deletes, []);
});