// commit-history-ui.js
// Commit panel, History drawer, pre-commit diff overlay, and restore-from-history.
// Pure extraction from app.js — same behaviour, deps injected for app state.
//
// Existing DOM helpers live in commit-ui.js (bindCommitPanel / bindHistoryPanel)
// and diff-util.js; this module owns the *orchestration* (when to open, what to
// load, how a commit updates workingTree / tabs / tree).

import { utf8ToB64, b64ToUtf8 } from './github-client.js';
import { encodePathForApi } from './paths.js';
import { bindCommitPanel, bindHistoryPanel } from './commit-ui.js';
import { unifiedDiff, renderDiffLines } from './diff-util.js';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} deps
 * @param {object} deps.els - commit/history/diff DOM refs (same ids as app.js)
 * @param {() => import('./working-tree.js').WorkingTree} deps.getWorkingTree
 * @param {() => { client: any, branch: string, currentPath: string|null, currentSha: string|null, allFiles: any[], demo?: boolean }} deps.getState
 * @param {() => any} deps.getEditorHandle
 * @param {() => { paths: string[] }} deps.getTabs
 * @param {() => Map<string, any>} deps.getTabDocs
 * @param {() => any} deps.getFileTree
 * @param {(msg: string, isError: boolean) => void} deps.setSaveStatus
 * @param {(path: string) => Promise<void>} deps.openFile
 * @param {(text: string) => void} deps.setEditorValue
 * @param {() => any} deps.ensureAutosave
 * @param {(v: boolean) => void} deps.setActiveFileUnsaved
 * @param {() => boolean} deps.getActiveFileUnsaved
 * @param {(path: string, sha: string|null) => void} deps.noteCommit
 * @param {() => void} deps.renderTabs
 * @param {() => Promise<void>} deps.loadTree
 * @param {() => any} deps.getDraftStore
 * @param {(path: string, sha: string) => void} [deps.onAfterCommitSha]
 */
export function createCommitHistoryUI(deps) {
  const els = deps.els;
  let commitPanel = null;
  let historyPanel = null;
  /** @type {{ path: string, text: string, mode: string, commitSha?: string }|null} */
  let diffOverlayState = null;

  function refreshCommitBadge() {
    const workingTree = deps.getWorkingTree();
    const n = workingTree.getChangeCount();
    if (!els.commitBadge || !els.btnCommit) return;
    if (n > 0) {
      els.commitBadge.textContent = String(n);
      els.commitBadge.classList.remove('hidden');
      els.btnCommit.disabled = false;
    } else {
      els.commitBadge.classList.add('hidden');
      els.btnCommit.disabled = true;
    }
  }

  function hideDiffOverlay() {
    diffOverlayState = null;
    if (els.diffOverlay) els.diffOverlay.classList.add('hidden');
    if (els.btnDiffRestore) els.btnDiffRestore.classList.add('hidden');
    if (els.diffOverlayBody) els.diffOverlayBody.innerHTML = '';
  }

  function formatCommitDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = (now - d.getTime()) / 1000;
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
      if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
      if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' d ago';
      return d.toLocaleDateString();
    } catch (_) {
      return iso;
    }
  }

  async function loadCommitDetail(sha) {
    if (!historyPanel) return;
    historyPanel.setLoading('Loading ' + String(sha).slice(0, 7) + '…');
    try {
      const state = deps.getState();
      const detail = typeof state.client.getCommitDetail === 'function'
        ? await state.client.getCommitDetail(sha)
        : await state.client.getCommit(sha);
      if (!historyPanel.isOpen()) return;
      historyPanel.renderDetail(detail);
    } catch (e) {
      if (historyPanel.isOpen()) historyPanel.setLoading('Error: ' + e.message);
    }
  }

  async function doCommit(message, andPush) {
    const workingTree = deps.getWorkingTree();
    const state = deps.getState();
    const changes = workingTree.listChanges();
    if (!changes.length) return;
    commitPanel.setBusy(true);
    deps.setSaveStatus(andPush ? 'Committing & pushing…' : 'Committing…', false);
    try {
      const editorHandle = deps.getEditorHandle();
      if (state.currentPath && editorHandle) {
        workingTree.setDirty(
          state.currentPath,
          editorHandle.easyMDE.value(),
          state.currentSha || null
        );
      }
      const latest = workingTree.listChanges();
      const files = latest.map((c) => ({
        path: c.path,
        contentB64: utf8ToB64(c.text),
      }));
      const result = await state.client.commitFiles(state.branch, message, files);

      for (const c of latest) workingTree.clear(c.path);
      refreshCommitBadge();
      const fileTree = deps.getFileTree();
      if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());

      if (state.currentPath && latest.some((c) => c.path === state.currentPath)) {
        try {
          const tree = await state.client.getTree(state.branch);
          state.allFiles = tree;
          const hit = tree.find((f) => f.path === state.currentPath);
          if (hit) state.currentSha = hit.sha;
          if (fileTree) {
            fileTree.setFiles(tree);
            fileTree.setDirtyMap(workingTree.statusMap());
          }
        } catch (_) {
          await deps.loadTree();
        }
      } else {
        await deps.loadTree();
      }

      const tabDocs = deps.getTabDocs();
      for (const c of latest) {
        const entry = tabDocs.get(c.path);
        if (entry) entry.unsaved = false;
        if (c.path === state.currentPath) deps.setActiveFileUnsaved(false);
      }
      deps.renderTabs();

      commitPanel.clearMessage();
      commitPanel.close();
      if (els.btnCommit) els.btnCommit.classList.remove('active-panel');
      hideDiffOverlay();

      const draftStore = deps.getDraftStore();
      for (const c of latest) {
        deps.noteCommit(c.path, null);
        if (draftStore && state.client) {
          draftStore.delete({
            owner: state.client.owner,
            repo: state.client.repo,
            branch: state.branch,
            path: c.path,
          }).catch(() => {});
        }
      }
      const short = result.commit.sha.slice(0, 7);
      deps.setSaveStatus(
        (andPush ? 'Committed & pushed ' : 'Committed ') + short + ' · ' + latest.length + ' file(s)',
        false
      );
    } catch (e) {
      deps.setSaveStatus('Commit failed: ' + e.message, true);
    } finally {
      commitPanel.setBusy(false);
    }
  }

  async function showPreCommitDiff(path) {
    const workingTree = deps.getWorkingTree();
    const state = deps.getState();
    const change = workingTree.get(path);
    if (!change) {
      deps.setSaveStatus('No local changes for ' + path, true);
      return;
    }
    if (els.diffOverlayBody) {
      els.diffOverlayBody.innerHTML = '<div class="hist-empty">Computing diff…</div>';
    }
    if (els.diffOverlay) els.diffOverlay.classList.remove('hidden');
    if (els.diffOverlayTitle) els.diffOverlayTitle.textContent = path + ' (local vs HEAD)';
    if (els.btnDiffRestore) els.btnDiffRestore.classList.add('hidden');

    let oldText = '';
    try {
      if (change.baseSha) {
        try {
          const blob = await state.client.getBlobB64(change.baseSha);
          oldText = b64ToUtf8(blob.b64);
        } catch (_) {
          const file = await state.client.getFileB64(path);
          oldText = b64ToUtf8(file.b64);
        }
      }
    } catch (e) {
      oldText = '';
    }

    const diff = unifiedDiff(oldText, change.text, path);
    if (els.diffOverlayBody) {
      els.diffOverlayBody.innerHTML = '';
      const meta = document.createElement('div');
      meta.className = 'diff-file-h';
      meta.innerHTML =
        '<span class="' + (change.baseSha ? 'badge-m' : 'badge-a') + '">' + (change.baseSha ? 'M' : 'A') + '</span> ' +
        '<span>' + escapeHtml(path) + '</span>' +
        '<span class="diff-stats"><span class="s-add">+' + diff.stats.additions + '</span> ' +
        '<span class="s-del">−' + diff.stats.deletions + '</span></span>';
      els.diffOverlayBody.appendChild(meta);
      renderDiffLines(els.diffOverlayBody, diff);
    }
    diffOverlayState = { path, text: change.text, mode: 'precommit' };
  }

  async function restoreFileFromHistory(file, commitSha) {
    const path = file.filename || file.path;
    if (!path) return;

    const confirmed = confirm(
      'Restore "' + path + '" from commit ' + String(commitSha).slice(0, 7) + '?\n\n' +
      'This loads that version into the editor as local changes. ' +
      'It will not commit until you do.'
    );
    if (!confirmed) return;

    const state = deps.getState();
    const workingTree = deps.getWorkingTree();
    deps.setSaveStatus('Restoring ' + path + '…', false);
    try {
      let text = '';
      const res = await state.client.request(
        '/repos/' + state.client.owner + '/' + state.client.repo +
        '/contents/' + encodePathForApi(path) + '?ref=' + encodeURIComponent(commitSha)
      );
      if (res.ok) {
        const data = await res.json();
        if (data.content) {
          text = b64ToUtf8(String(data.content).replace(/\n/g, ''));
        } else if (data.sha) {
          const blob = await state.client.getBlobB64(data.sha);
          text = b64ToUtf8(blob.b64);
        }
      } else if (file.sha) {
        const blob = await state.client.getBlobB64(file.sha);
        text = b64ToUtf8(blob.b64);
      } else {
        throw new Error('Could not fetch file content at that commit');
      }

      let baseSha = null;
      const head = (state.allFiles || []).find((f) => f.path === path);
      if (head) baseSha = head.sha;

      await deps.openFile(path);
      deps.setEditorValue(text);
      state.currentPath = path;
      if (head) state.currentSha = head.sha;

      workingTree.setDirty(path, text, baseSha);
      deps.setActiveFileUnsaved(true);
      const tab = deps.getTabDocs().get(path);
      if (tab) {
        tab.unsaved = true;
        try {
          if (tab.doc && typeof tab.doc.setValue === 'function') tab.doc.setValue(text);
        } catch (_) {}
      }
      deps.ensureAutosave().onChange(text);
      refreshCommitBadge();
      const fileTree = deps.getFileTree();
      if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());
      deps.renderTabs();

      if (historyPanel) historyPanel.close();
      hideDiffOverlay();
      deps.setSaveStatus(
        'Restored ' + path + ' from ' + String(commitSha).slice(0, 7) + ' — review and Commit when ready',
        false
      );
    } catch (e) {
      deps.setSaveStatus('Restore failed: ' + e.message, true);
    }
  }

  function setup() {
    if (!els.commitPanel) return;

    if (!commitPanel) {
      commitPanel = bindCommitPanel({
        panelEl: els.commitPanel,
        messageEl: els.commitMessage,
        filesEl: els.commitFiles,
        btnCommit: els.btnCommitOnly,
        btnCommitPush: els.btnCommitPush,
        btnClose: els.btnCommitClose,
        onCommit: doCommit,
        onClose: () => {
          commitPanel.close();
          hideDiffOverlay();
        },
        onFileClick: (path) => showPreCommitDiff(path),
      });
    }
    if (!historyPanel) {
      historyPanel = bindHistoryPanel({
        panelEl: els.historyPanel,
        listEl: els.historyList,
        detailEl: els.historyDetail,
        btnClose: els.btnHistoryClose,
        onClose: () => {
          historyPanel.close();
          if (els.btnHistory) els.btnHistory.classList.remove('active-panel');
          hideDiffOverlay();
        },
        onSelect: loadCommitDetail,
        onRestore: restoreFileFromHistory,
      });
    }

    if (els.btnDiffBack && !els.btnDiffBack.dataset.bound) {
      els.btnDiffBack.dataset.bound = '1';
      els.btnDiffBack.addEventListener('click', () => hideDiffOverlay());
    }

    if (els.btnCommit && !els.btnCommit.dataset.bound) {
      els.btnCommit.dataset.bound = '1';
      els.btnCommit.addEventListener('click', () => {
        if (commitPanel && typeof commitPanel.isOpen === 'function' && commitPanel.isOpen()) {
          commitPanel.close();
          els.btnCommit.classList.remove('active-panel');
          hideDiffOverlay();
          return;
        }
        const state = deps.getState();
        const workingTree = deps.getWorkingTree();
        const editorHandle = deps.getEditorHandle();
        if (state.currentPath && editorHandle) {
          workingTree.setDirty(
            state.currentPath,
            editorHandle.easyMDE.value(),
            state.currentSha || null
          );
        }
        const tabs = deps.getTabs();
        const tabDocs = deps.getTabDocs();
        for (const path of tabs.paths) {
          if (path === state.currentPath) continue;
          const entry = tabDocs.get(path);
          if (entry && entry.unsaved) {
            let text = null;
            try {
              if (entry.doc && typeof entry.doc.getValue === 'function') text = entry.doc.getValue();
            } catch (_) {}
            if (text != null) workingTree.setDirty(path, text, entry.sha || null);
          }
        }
        refreshCommitBadge();
        const fileTree = deps.getFileTree();
        if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());
        if (historyPanel) {
          historyPanel.close();
          if (els.btnHistory) els.btnHistory.classList.remove('active-panel');
        }
        hideDiffOverlay();
        commitPanel.open(workingTree.listChanges());
        els.btnCommit.classList.add('active-panel');
      });
    }

    if (els.btnHistory && !els.btnHistory.dataset.bound) {
      els.btnHistory.dataset.bound = '1';
      els.btnHistory.addEventListener('click', async () => {
        if (historyPanel && typeof historyPanel.isOpen === 'function' && historyPanel.isOpen()) {
          historyPanel.close();
          els.btnHistory.classList.remove('active-panel');
          return;
        }
        if (commitPanel) {
          commitPanel.close();
          if (els.btnCommit) els.btnCommit.classList.remove('active-panel');
        }
        hideDiffOverlay();
        historyPanel.open();
        els.btnHistory.classList.add('active-panel');
        historyPanel.setLoading('Select a commit');
        try {
          const state = deps.getState();
          const list = await state.client.listCommits({ branch: state.branch, perPage: 40 });
          const items = list.map((c) => ({
            sha: c.sha,
            message: (c.commit && c.commit.message) || '',
            author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || 'unknown',
            date: formatCommitDate(c.commit && c.commit.author && c.commit.author.date),
            stats: c.stats ? `+${c.stats.additions || 0} −${c.stats.deletions || 0}` : '',
          }));
          historyPanel.renderList(items);
          if (!historyPanel.isOpen()) return;
          historyPanel.setLoading('Select a commit');
        } catch (e) {
          if (historyPanel.isOpen()) historyPanel.setLoading('Error: ' + e.message);
        }
      });
    }
  }

  return {
    setup,
    refreshBadge: refreshCommitBadge,
    hideDiffOverlay,
  };
}
