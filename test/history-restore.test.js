import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCommitHistoryUI } from '../js/commit-history-ui.js';
import { Autosave } from '../js/autosave.js';
import { DraftStore } from '../js/draft-store.js';
import { WorkingTree } from '../js/working-tree.js';
import { utf8ToB64 } from '../js/github-client.js';

const SCOPE = { owner: 'probe', repo: 'notes', branch: 'main' };
const PATH = 'Notes/a.md';
const COMMIT = 'abc1234abcdef';
const CURRENT = 'Heading\nCURRENT VERSION\n';
const HISTORICAL = 'Heading\nHISTORICAL VERSION\n';

async function settle() {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function fixture() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previousDocument = globalThis.document;
  const previousConfirm = globalThis.confirm;
  globalThis.document = dom.window.document;
  let allowed = false;
  const prompts = [];
  globalThis.confirm = (message) => {
    prompts.push(message);
    return allowed;
  };
  const store = new DraftStore({ indexedDB: null });
  const wt = new WorkingTree();
  const reads = [];
  const writes = [];
  const opens = [];
  const statuses = [];
  let editorText = CURRENT;
  let activeUnsaved = false;
  const client = {
    owner: SCOPE.owner, repo: SCOPE.repo,
    async listCommits(options) {
      reads.push({ operation: 'listCommits', options });
      return [{
        sha: COMMIT,
        commit: {
          message: 'Historical edit',
          author: { name: 'Tester', date: '2026-11-01T12:00:00Z' }
        }
      }];
    },
    async getCommitDetail(sha) {
      reads.push({ operation: 'getCommitDetail', sha });
      assert.equal(sha, COMMIT);
      return {
        sha, commit: { message: 'Historical edit' },
        files: [{
          filename: PATH, sha: 'historical-blob', status: 'modified',
          additions: 1, deletions: 1,
          patch: '@@ -1,2 +1,2 @@\n Heading\n-CURRENT VERSION\n+HISTORICAL VERSION'
        }]
      };
    },
    async request(url) {
      reads.push({ operation: 'request', url });
      assert.equal(url,
        '/repos/probe/notes/contents/Notes/a.md?ref=' + COMMIT);
      return {
        ok: true,
        json: async () => ({
          content: utf8ToB64(HISTORICAL), sha: 'historical-blob'
        })
      };
    },
    async getBlobB64(sha) {
      reads.push({ operation: 'getBlobB64', sha });
      assert.equal(sha, 'current-blob');
      return { b64: utf8ToB64(CURRENT), sha };
    },
    async putFile(...args) { writes.push({ operation: 'putFile', args }); },
    async commitFiles(...args) { writes.push({ operation: 'commitFiles', args }); }
  };
  const state = {
    client, branch: 'main', currentPath: PATH, currentSha: 'current-blob',
    allFiles: [{ path: PATH, sha: 'current-blob' }]
  };
  const tab = {
    sha: 'current-blob', unsaved: false,
    doc: {
      getValue: () => editorText,
      setValue: (value) => { editorText = value; }
    }
  };
  const tabDocs = new Map([[PATH, tab]]);
  const autosave = new Autosave({
    ...SCOPE, client, store, getText: () => editorText,
    onStatus: (status) => {
      activeUnsaved = !!status && status.variant !== 'ok';
    }
  });
  await autosave.onOpen(PATH, CURRENT, 'current-blob');
  const els = {};
  for (const key of [
    'btnCommit', 'commitBadge', 'commitPanel', 'commitMessage', 'commitFiles',
    'btnCommitClose', 'btnCommitOnly', 'btnCommitPush',
    'btnHistory', 'historyPanel', 'historyList', 'historyDetail',
    'btnHistoryClose', 'diffOverlay', 'diffOverlayTitle',
    'diffOverlayBody', 'btnDiffBack', 'btnDiffRestore'
  ]) {
    const el = document.createElement(key === 'commitMessage'
      ? 'textarea' : key.startsWith('btn') ? 'button' : 'div');
    if (['commitPanel', 'historyPanel', 'diffOverlay'].includes(key)) {
      el.classList.add('hidden');
    }
    document.body.appendChild(el);
    els[key] = el;
  }
  const ui = createCommitHistoryUI({
    els, getState: () => state, getWorkingTree: () => wt,
    getEditorHandle: () => ({ easyMDE: { value: () => editorText } }),
    getTabs: () => ({ paths: [PATH] }),
    getTabDocs: () => tabDocs,
    getFileTree: () => ({ setDirtyMap() {} }),
    getSessionGeneration: () => 1,
    getDraftStore: () => store,
    ensureAutosave: () => autosave,
    setSaveStatus: (message, error) => statuses.push({ message, error }),
    setActiveFileUnsaved: (value) => { activeUnsaved = value; },
    getActiveFileUnsaved: () => activeUnsaved,
    renderTabs() {},
    // This harness covers an already open file. Tab switching is an E2E guard.
    openFile: async (target) => {
      opens.push(target);
      assert.equal(target, state.currentPath);
    },
    setEditorValue: (value) => { editorText = value; }
  });
  ui.setup();
  return {
    els, store, wt, tab, state, reads, writes, opens, statuses, prompts, autosave,
    text: () => editorText,
    unsaved: () => activeUnsaved,
    allowRestore: () => { allowed = true; },
    async selectHistory() {
      els.btnHistory.click();
      await settle();
      els.historyList.querySelector('.hist-item').click();
      await settle();
    },
    async close() {
      await settle();
      autosave.destroy();
      store.close();
      dom.window.close();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousConfirm === undefined) delete globalThis.confirm;
      else globalThis.confirm = previousConfirm;
    }
  };
}

test('History (guard): branch list and selected commit show exact filename and patch', async () => {
  const f = await fixture();
  try {
    await f.selectHistory();
    assert.deepEqual(f.reads, [
      { operation: 'listCommits', options: { branch: 'main', perPage: 40 } },
      { operation: 'getCommitDetail', sha: COMMIT }
    ]);
    const row = f.els.historyList.querySelector('.hist-item');
    assert.equal(row.dataset.sha, COMMIT);
    assert.equal(row.querySelector('.hist-msg').textContent, 'Historical edit');
    assert.equal(f.els.historyDetail.querySelector('.diff-fname').textContent, PATH);
    assert.equal(f.els.historyDetail.querySelector('.diff-del').textContent,
      '-CURRENT VERSION');
    assert.equal(f.els.historyDetail.querySelector('.diff-add').textContent,
      '+HISTORICAL VERSION');
    assert.equal(f.els.historyDetail.querySelectorAll('.btn-restore').length, 1);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Restore (guard): Cancel makes no request and preserves editor and draft state', async () => {
  const f = await fixture();
  try {
    await f.selectHistory();
    const beforeReads = [...f.reads];
    f.els.historyDetail.querySelector('.btn-restore').click();
    await settle();
    assert.equal(f.prompts.length, 1);
    assert.ok(f.prompts[0].includes(PATH) && f.prompts[0].includes('abc1234'));
    assert.deepEqual(f.reads, beforeReads);
    assert.equal(f.text(), CURRENT);
    assert.equal(f.wt.getChangeCount(), 0);
    assert.equal(f.unsaved(), false);
    assert.equal(await f.store.get({ ...SCOPE, path: PATH }), null);
    assert.deepEqual(f.opens, []);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Restore (guard): exact historical text stays local and has the correct pre-commit diff', async () => {
  const f = await fixture();
  try {
    await f.selectHistory();
    f.allowRestore();
    f.els.historyDetail.querySelector('.btn-restore').click();
    await settle();
    assert.equal(f.text(), HISTORICAL);
    assert.deepEqual(f.opens, [PATH]);
    assert.deepEqual(f.wt.get(PATH), {
      text: HISTORICAL, baseSha: 'current-blob'
    });
    assert.equal(f.tab.unsaved, true);
    assert.equal(f.unsaved(), true);
    assert.equal(f.state.currentSha, 'current-blob');
    assert.equal(f.els.commitBadge.textContent, '1');
    assert.equal(f.els.commitBadge.classList.contains('hidden'), false);
    await f.autosave.flushCurrentFile();
    const saved = await f.store.get({ ...SCOPE, path: PATH });
    assert.equal(saved.text, HISTORICAL);
    assert.equal(saved.baseSha, 'current-blob');

    f.els.btnCommit.click();
    f.els.commitFiles.querySelector('.cp-file').click();
    await settle();
    assert.deepEqual(
      [...f.els.diffOverlayBody.querySelectorAll('.diff-add')].map((el) => el.textContent),
      ['+HISTORICAL VERSION']
    );
    assert.deepEqual(
      [...f.els.diffOverlayBody.querySelectorAll('.diff-del')].map((el) => el.textContent),
      ['-CURRENT VERSION']
    );
    assert.deepEqual(f.writes, []);
    assert.equal(f.statuses.filter((s) => s.error).length, 0);
  } finally { await f.close(); }
});
