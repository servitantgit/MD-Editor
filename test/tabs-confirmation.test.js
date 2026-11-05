import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabsSession } from '../js/tabs-session.js';
import { WorkingTree } from '../js/working-tree.js';

function fixture(currentPath = 'a.md') {
  const wt = new WorkingTree();
  const state = { currentPath, currentSha: 'old-a' };
  let badgeRefreshes = 0;
  let dirtyMap = null;
  const session = createTabsSession({
    els: {},
    getState: () => state,
    getWorkingTree: () => wt,
    refreshCommitBadge: () => { badgeRefreshes++; },
    getFileTree: () => ({ setDirtyMap: (map) => { dirtyMap = map; } })
  });
  assert.equal(typeof session.confirmSnapshot, 'function',
    'tabs confirmSnapshot must exist');
  return {
    wt, state, session,
    addTab(path, text, sha = 'old-a') {
      session.getTabs().open(path);
      session.getTabDocs().set(path, {
        doc: { getValue: () => text },
        sha, unsaved: true, stale: false, commitSeen: false
      });
    },
    badgeRefreshes: () => badgeRefreshes,
    dirtyMap: () => dirtyMap
  };
}

test('tabs confirmation: matching active snapshot updates sha and clears only its dirty state', () => {
  const f = fixture();
  f.addTab('a.md', 'SNAPSHOT');
  f.wt.setDirty('a.md', 'SNAPSHOT', 'old-a');
  f.wt.setDirty('b.md', 'B NEW', 'old-b');
  f.session.setActiveFileUnsaved(true);

  assert.equal(f.session.confirmSnapshot({
    path: 'a.md', text: 'SNAPSHOT', sha: 'new-a'
  }), true);
  const tab = f.session.getTabDocs().get('a.md');
  assert.equal(tab.sha, 'new-a');
  assert.equal(tab.unsaved, false);
  assert.equal(f.state.currentSha, 'new-a');
  assert.equal(f.session.getActiveFileUnsaved(), false);
  assert.equal(f.wt.get('a.md'), null);
  assert.deepEqual(f.wt.get('b.md'), { text: 'B NEW', baseSha: 'old-b' });
  assert.deepEqual(f.dirtyMap(), { 'b.md': 'M' });
  assert.ok(f.badgeRefreshes() > 0);
});

test('tabs confirmation: newer background document stays dirty on the committed base', () => {
  const f = fixture('b.md');
  f.state.currentSha = 'old-b';
  f.addTab('a.md', 'SECOND');
  f.wt.setDirty('a.md', 'SECOND', 'old-a');
  f.session.setActiveFileUnsaved(true);

  assert.equal(f.session.confirmSnapshot({
    path: 'a.md', text: 'FIRST', sha: 'new-a'
  }), false);
  const tab = f.session.getTabDocs().get('a.md');
  assert.equal(tab.sha, 'new-a');
  assert.equal(tab.unsaved, true);
  assert.equal(tab.commitSeen, false);
  assert.deepEqual(f.wt.get('a.md'), { text: 'SECOND', baseSha: 'new-a' });
  assert.equal(f.state.currentPath, 'b.md');
  assert.equal(f.state.currentSha, 'old-b');
  assert.equal(f.session.getActiveFileUnsaved(), true);
  assert.deepEqual(f.dirtyMap(), { 'a.md': 'M' });
});

test('tabs confirmation: closed file snapshot clears working tree without recreating its tab', () => {
  const f = fixture('b.md');
  f.state.currentSha = 'old-b';
  f.wt.setDirty('a.md', 'SNAPSHOT', 'old-a');

  assert.equal(f.session.confirmSnapshot({
    path: 'a.md', text: 'SNAPSHOT', sha: 'new-a'
  }), true);
  assert.equal(f.wt.get('a.md'), null);
  assert.equal(f.session.getTabs().has('a.md'), false);
  assert.equal(f.session.getTabDocs().has('a.md'), false);
  assert.equal(f.state.currentPath, 'b.md');
  assert.equal(f.state.currentSha, 'old-b');
});

test('tabs confirmation: empty active document is a valid confirmed snapshot', () => {
  const f = fixture();
  f.addTab('a.md', '');
  f.wt.setDirty('a.md', '', 'old-a');
  f.session.setActiveFileUnsaved(true);

  assert.equal(f.session.confirmSnapshot({
    path: 'a.md', text: '', sha: 'empty-sha'
  }), true);
  assert.equal(f.wt.getChangeCount(), 0);
  assert.equal(f.session.getTabDocs().get('a.md').sha, 'empty-sha');
  assert.equal(f.session.getTabDocs().get('a.md').unsaved, false);
  assert.equal(f.session.getActiveFileUnsaved(), false);
  assert.equal(f.state.currentSha, 'empty-sha');
});
