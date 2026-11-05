import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCommitHistoryUI } from '../js/commit-history-ui.js';
import { createTabsSession } from '../js/tabs-session.js';
import { WorkingTree } from '../js/working-tree.js';
import { Autosave, STATE } from '../js/autosave.js';
import { DraftStore } from '../js/draft-store.js';

const SCOPE = { owner: 'o', repo: 'r', branch: 'main' };
const ref = (path) => ({ ...SCOPE, path });
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture({ empty = false, failCommit = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const els = {};
  for (const key of [
    'btnCommit', 'commitBadge', 'commitPanel', 'commitMessage', 'commitFiles',
    'btnCommitClose', 'btnCommitOnly', 'btnCommitPush', 'btnHistory',
    'historyPanel', 'historyList', 'historyDetail', 'btnHistoryClose',
    'diffOverlay', 'diffOverlayTitle', 'diffOverlayBody', 'btnDiffBack',
    'btnDiffRestore'
  ]) {
    const element = document.createElement(key === 'commitMessage'
      ? 'textarea' : key.startsWith('btn') ? 'button' : 'div');
    if (['commitPanel', 'historyPanel', 'diffOverlay'].includes(key)) {
      element.classList.add('hidden');
    }
    document.body.appendChild(element);
    els[key] = element;
  }

  const wt = new WorkingTree();
  const store = new DraftStore({ indexedDB: null });
  const docs = new Map([['a.md', empty ? '' : 'A FIRST'], ['b.md', 'B FIRST']]);
  const remote = new Map([['a.md', 'A OLD'], ['b.md', 'B OLD']]);
  const requests = [];
  const statuses = [];
  let sessionGeneration = 1;
  let finish;
  const parked = new Promise((resolve) => { finish = resolve; });
  const client = {
    owner: SCOPE.owner, repo: SCOPE.repo,
    async commitFiles(branch, message, files) {
      const sent = files.map((f) => ({
        path: f.path,
        text: Buffer.from(f.contentB64, 'base64').toString('utf8')
      }));
      requests.push({ branch, message, files: sent });
      await parked;
      if (failCommit) throw new Error('controlled failure');
      for (const file of sent) remote.set(file.path, file.text);
      return {
        commit: { sha: 'commit-confirmed' },
        files: sent.map((f) => ({ path: f.path, sha: 'new-' + f.path }))
      };
    },
    async getTree() {
      // Deliberately lagging response: confirmed blob SHAs must win.
      return [{ path: 'a.md', sha: 'old-a' }, { path: 'b.md', sha: 'old-b' }];
    }
  };
  const state = {
    client, branch: 'main', currentPath: 'a.md', currentSha: 'old-a',
    allFiles: await client.getTree()
  };
  const ft = { setFiles() {}, setDirtyMap() {} };
  let ui;
  const session = createTabsSession({
    els: {}, getState: () => state, getWorkingTree: () => wt,
    getFileTree: () => ft,
    refreshCommitBadge: () => { if (ui) ui.refreshBadge(); }
  });
  for (const [path, value] of docs) {
    session.getTabs().open(path);
    session.getTabDocs().set(path, {
      doc: { getValue: () => docs.get(path) },
      sha: path === 'a.md' ? 'old-a' : 'old-b',
      unsaved: true, stale: false, commitSeen: false
    });
    wt.setDirty(path, value, path === 'a.md' ? 'old-a' : 'old-b');
  }
  const autosave = new Autosave({
    ...SCOPE, client, store, getText: () => docs.get(state.currentPath),
    onStatus: (s) => session.setActiveFileUnsaved(!!s && s.variant !== 'ok')
  });
  await autosave.onOpen('a.md', 'A OLD', 'old-a');
  autosave.onChange(docs.get('a.md'));
  await autosave.flushCurrentFile();
  await store.put({ ...ref('b.md'), text: 'B FIRST', baseSha: 'old-b' });

  ui = createCommitHistoryUI({
    els, getState: () => state, getWorkingTree: () => wt,
    getEditorHandle: () => ({ easyMDE: { value: () => docs.get(state.currentPath) } }),
    getTabs: () => session.getTabs(),
    getTabDocs: () => session.getTabDocs(),
    getFileTree: () => ft,
    getDraftStore: () => store,
    ensureAutosave: () => autosave,
    getSessionGeneration: () => sessionGeneration,
    confirmSnapshot: (snapshot) => session.confirmSnapshot(snapshot),
    noteCommit: (path, sha) => session.noteCommit(path, sha),
    setActiveFileUnsaved: (v) => session.setActiveFileUnsaved(v),
    getActiveFileUnsaved: () => session.getActiveFileUnsaved(),
    renderTabs: () => session.renderTabs(),
    setSaveStatus: (message, error) => statuses.push({ message, error }),
    loadTree: async () => {},
    openFile: async () => {},
    setEditorValue: (value) => docs.set(state.currentPath, value)
  });
  ui.setup();
  ui.refreshBadge();

  return {
    els, wt, store, docs, remote, requests, statuses, state, session, autosave,
    invalidateSession() { sessionGeneration++; },
    repeatCommitEvent() {
      els.btnCommitPush.dispatchEvent(new dom.window.Event('click'));
    },
    start() {
      els.btnCommit.click();
      els.commitMessage.value = 'Commit both notes';
      els.btnCommitPush.click();
    },
    async complete() {
      finish();
      for (let i = 0; i < 100; i++) {
        await turn();
        if (!els.commitMessage.disabled) return;
      }
      throw new Error('Commit did not finish');
    },
    async close() {
      finish();
      for (let i = 0; i < 4; i++) await turn();
      autosave.destroy();
      store.close();
      dom.window.close();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
}

test('Commit UI: two snapshots update blob SHAs and leave Autosave clean', async () => {
  const f = await fixture();
  try {
    f.start();
    assert.deepEqual(f.requests, [{
      branch: 'main', message: 'Commit both notes',
      files: [{ path: 'a.md', text: 'A FIRST' }, { path: 'b.md', text: 'B FIRST' }]
    }]);
    await f.complete();
    assert.equal(f.autosave.state, STATE.CLEAN);
    assert.equal(f.autosave.baseSha, 'new-a.md');
    assert.equal(f.state.currentSha, 'new-a.md');
    assert.equal(f.session.getTabDocs().get('a.md').sha, 'new-a.md');
    assert.equal(f.session.getTabDocs().get('b.md').sha, 'new-b.md');
    assert.equal(f.wt.getChangeCount(), 0);
    await f.autosave.flushCurrentFile();
    assert.equal(await f.store.get(ref('a.md')), null);
    assert.equal(await f.store.get(ref('b.md')), null);
  } finally { await f.close(); }
});

test('Commit UI: typing during request preserves newer text, dot, badge and recovery draft', async () => {
  const f = await fixture();
  try {
    f.start();
    f.docs.set('a.md', 'A SECOND');
    f.autosave.onChange('A SECOND');
    f.wt.setDirty('a.md', 'A SECOND', 'old-a');
    await f.autosave.flushCurrentFile();
    await f.complete();
    assert.equal(f.remote.get('a.md'), 'A FIRST');
    assert.deepEqual(f.wt.get('a.md'), { text: 'A SECOND', baseSha: 'new-a.md' });
    assert.equal(f.session.getActiveFileUnsaved(), true);
    assert.equal(f.session.getTabDocs().get('a.md').unsaved, true);
    assert.equal(f.els.commitBadge.classList.contains('hidden'), false);
    assert.equal(f.els.commitBadge.textContent, '1');
    const saved = await f.store.get(ref('a.md'));
    assert.equal(saved.text, 'A SECOND');
    assert.equal(saved.baseSha, 'new-a.md');
    assert.equal(await f.store.get(ref('b.md')), null);
  } finally { await f.close(); }
});

test('Commit UI: empty snapshot is committed and confirmed without a phantom draft', async () => {
  const f = await fixture({ empty: true });
  try {
    f.start();
    assert.equal(f.requests[0].files[0].text, '');
    await f.complete();
    assert.equal(f.remote.get('a.md'), '');
    assert.equal(f.autosave.state, STATE.CLEAN);
    assert.equal(f.autosave.hasUnsavedDraft(), false);
    assert.equal(f.wt.getChangeCount(), 0);
    assert.equal(await f.store.get(ref('a.md')), null);
  } finally { await f.close(); }
});

test('Commit UI (guard): remote failure keeps local text, drafts and commit message', async () => {
  const f = await fixture({ failCommit: true });
  try {
    f.start();
    await f.complete();
    assert.equal(f.remote.get('a.md'), 'A OLD');
    assert.equal(f.wt.getChangeCount(), 2);
    assert.equal(f.session.getActiveFileUnsaved(), true);
    assert.equal((await f.store.get(ref('a.md'))).text, 'A FIRST');
    assert.equal((await f.store.get(ref('b.md'))).text, 'B FIRST');
    assert.equal(f.els.commitMessage.value, 'Commit both notes');
    assert.equal(f.els.commitPanel.classList.contains('hidden'), false);
    assert.equal(f.statuses.at(-1).error, true);
  } finally { await f.close(); }
});

test('Commit UI: repeated click event cannot start a second pending commit', async () => {
  const f = await fixture();
  try {
    f.start();
    assert.equal(f.requests.length, 1);
    f.repeatCommitEvent();
    assert.equal(f.requests.length, 1, 'handler must reject a duplicate operation');
    await f.complete();
  } finally { await f.close(); }
});

test('Commit UI: changed session generation protects new local state with the same client', async () => {
  const f = await fixture();
  try {
    f.start();
    f.invalidateSession();
    f.docs.set('a.md', 'NEW SESSION TEXT');
    f.autosave.destroy();
    f.wt.setDirty('a.md', 'NEW SESSION TEXT', 'new-session-base');
    await f.store.put({
      ...ref('a.md'), text: 'NEW SESSION TEXT', baseSha: 'new-session-base'
    });
    f.session.setActiveFileUnsaved(true);
    const beforeDraft = await f.store.get(ref('a.md'));
    const beforeTab = { ...f.session.getTabDocs().get('a.md') };
    const statusCount = f.statuses.length;

    await f.complete();

    assert.deepEqual(f.wt.get('a.md'), {
      text: 'NEW SESSION TEXT', baseSha: 'new-session-base'
    }, 'old result must not clear the new session working tree');
    assert.deepEqual(await f.store.get(ref('a.md')), beforeDraft);
    assert.deepEqual(f.session.getTabDocs().get('a.md'), beforeTab);
    assert.equal(f.session.getActiveFileUnsaved(), true);
    assert.equal(f.statuses.length, statusCount,
      'old result must not publish status into the new session');
  } finally { await f.close(); }
});

async function backgroundConfirmationCase(closed) {
  const f = await fixture();
  try {
    f.start();
    f.docs.set('b.md', 'B SECOND');
    f.wt.setDirty('b.md', 'B SECOND', 'old-b');
    await f.store.put({
      ...ref('b.md'), text: 'B SECOND', baseSha: 'old-b'
    });
    if (closed) {
      f.session.getTabs().close('b.md');
      f.session.getTabDocs().delete('b.md');
    }

    await f.complete();

    assert.equal(f.remote.get('b.md'), 'B FIRST');
    assert.deepEqual(f.wt.get('b.md'), {
      text: 'B SECOND', baseSha: 'new-b.md'
    });
    const saved = await f.store.get(ref('b.md'));
    assert.equal(saved.text, 'B SECOND');
    assert.equal(saved.baseSha, 'new-b.md',
      'newer recovery draft must use the committed blob SHA');
    assert.equal(f.session.getTabs().has('b.md'), !closed);
    if (!closed) {
      const tab = f.session.getTabDocs().get('b.md');
      assert.equal(tab.sha, 'new-b.md');
      assert.equal(tab.unsaved, true);
    }
  } finally { await f.close(); }
}

test('Commit UI: newer background draft adopts the committed base without losing text', async () => {
  await backgroundConfirmationCase(false);
});

test('Commit UI: newer closed-file draft adopts the committed base without reopening a tab', async () => {
  await backgroundConfirmationCase(true);
});

test('Commit UI (guard): closed matching file clears its draft without recreating a tab', async () => {
  const f = await fixture();
  try {
    f.start();
    f.session.getTabs().close('b.md');
    f.session.getTabDocs().delete('b.md');
    await f.complete();
    assert.equal(f.remote.get('b.md'), 'B FIRST');
    assert.equal(f.wt.get('b.md'), null);
    assert.equal(await f.store.get(ref('b.md')), null);
    assert.equal(f.session.getTabs().has('b.md'), false);
    assert.equal(f.session.getTabDocs().has('b.md'), false);
    assert.equal(f.state.currentPath, 'a.md');
  } finally { await f.close(); }
});
