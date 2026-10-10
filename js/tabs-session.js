// tabs-session.js
// Session of open files: tab list + per-tab CodeMirror docs, open/close/switch,
// sessionStorage restore, empty-state chrome. Pure extraction from app.js —
// same behaviour; editor / autosave / tree via injected deps.
//
// Boundary notes:
// 1. openFile owns the race (openSeq), hybrid cache rules, and draft banner
//    hand-off. Callers that need a fresh remote copy pass { reload: true }.
// 2. dropTabs / closeTab never flush to a path that was just deleted.
// 3. markStale / moveTabDoc are the only ways file-ops touch tabDocs.
// 4. noteCommit is called from autosave / commit UI after a successful push.

import { TabsModel, tabLabels, tabsStorageKey } from './tabs.js';
import { createTabBar } from './tabs-ui.js';
import { b64ToUtf8 } from './github-client.js';
import { kindFromPath } from './file-kind.js';

/**
 * @param {object} deps
 * @param {object} deps.els
 * @param {() => object} deps.getState
 * @param {() => any} deps.getFileTree
 * @param {() => any} deps.getEditorHandle
 * @param {() => any} deps.getAutosave
 * @param {() => any} deps.ensureAutosave
 * @param {() => any} deps.getDraftStore
 * @param {Promise} [deps.draftStoreReady]
 * @param {(msg: string, isError?: boolean, kind?: string) => void} deps.setSaveStatus
 * @param {(msg: string|null) => void} [deps.setAutosaveStatus]
 * @param {() => void} deps.hideDraftBanner
 * @param {(msg: string, kind: string) => void} deps.showDraftBanner
 * @param {(v: any) => void} deps.setPendingDraft
 * @param {(path: string) => Promise<void>} [deps.resurfaceDraftBanner]
 * @param {() => boolean} [deps.isMobileShell]
 * @param {(open: boolean) => void} [deps.setMobileSidebarOpen]
 * @param {(kind: any) => void} [deps.updateLangBadge]
 * @param {() => void} [deps.renderDocOutline]
 * @param {() => void} [deps.ensureMinimap]
 * @param {() => void} [deps.refreshCommitBadge]
 * @param {() => any} [deps.getWorkingTree]
 * @param {(flag: boolean) => void} [deps.setSuppressEditorChange]
 * @param {(ms: number) => string} [deps.formatAge]
 */
export function createTabsSession(deps) {
  const els = deps.els;

  let tabs = new TabsModel();
  let tabBar = null;
  const tabDocs = new Map();
  let activeFileUnsaved = false;
  let openSeq = 0;
  let tabsRestored = false;

  function tabsKey() {
    const state = deps.getState();
    if (!state.client) return 'tabs:none';
    return tabsStorageKey(state.client.owner, state.client.repo, state.branch);
  }

  function persistTabs() {
    const state = deps.getState();
    if (!state.client) return;
    try {
      sessionStorage.setItem(tabsKey(), JSON.stringify(tabs.toJSON()));
    } catch (_) { /* storage disabled or full */ }
  }

  function renderTabs() {
    if (!tabBar) return;
    const state = deps.getState();
    const dirty = new Set();
    for (const path of tabs.paths) {
      const isActive = path === state.currentPath;
      if (isActive ? activeFileUnsaved : (tabDocs.get(path) || {}).unsaved) dirty.add(path);
    }
    tabBar.render({
      paths: tabs.paths,
      active: tabs.active,
      labels: tabLabels(tabs.paths),
      dirty,
    });
    document.body.classList.toggle('mobile-single-tab', (tabs.paths || []).length <= 1);
  }

  function noteCommit(path, sha) {
    const tab = tabDocs.get(path);
    if (tab) {
      if (sha) tab.sha = sha;
      tab.commitSeen = true;
      const state = deps.getState();
      if (state.currentPath !== path && tab.unsaved) {
        tab.unsaved = false;
        renderTabs();
      }
    }
    const wt = deps.getWorkingTree && deps.getWorkingTree();
    if (path && wt) {
      wt.clear(path);
      if (deps.refreshCommitBadge) deps.refreshCommitBadge();
      const ft = deps.getFileTree && deps.getFileTree();
      if (ft) ft.setDirtyMap(wt.statusMap());
    }
  }

  function restoreChrome() {
    const state = deps.getState();
    const path = state.currentPath;
    if (els.currentFileLabel) els.currentFileLabel.textContent = path || 'No file selected';
    if (els.btnSave) els.btnSave.disabled = !path;
    if (els.btnExportPdf) els.btnExportPdf.disabled = !path;
    if (els.btnDelete) els.btnDelete.disabled = !path;
    const ft = deps.getFileTree();
    if (path) ft.setActive(path);
    else ft.clearActive();
  }

  function renderEmptyState() {
    if (!els.emptyState) return;
    const hasFile = !!deps.getState().currentPath;
    els.emptyState.classList.toggle('hidden', hasFile);
    for (const sel of ['.editor-toolbar', '.editor-body']) {
      const node = document.querySelector(sel);
      if (node) node.classList.toggle('hidden', !hasFile);
    }
    if (!hasFile) {
      for (const id of ['find-bar', 'draft-banner']) {
        const node = document.getElementById(id);
        if (node) node.classList.add('hidden');
      }
    }
  }

  function showDocInEditor(doc) {
    if (deps.setSuppressEditorChange) deps.setSuppressEditorChange(true);
    try {
      deps.getEditorHandle().showDoc(doc);
    } finally {
      if (deps.setSuppressEditorChange) deps.setSuppressEditorChange(false);
    }
  }

  function restoreTabsOnce(files) {
    if (tabsRestored) return;
    tabsRestored = true;
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(tabsKey()) || 'null');
    } catch (_) { /* corrupt */ }
    const known = new Set(files.map((f) => f.path));
    const restored = TabsModel.fromJSON(saved, (path) => known.has(path));
    if (restored.size === 0) return;
    for (const path of restored.paths) tabs.open(path);
    persistTabs();
    renderTabs();
    const toOpen = restored.active || restored.paths[0];
    if (!deps.getState().currentPath && toOpen) openFile(toOpen);
  }

  async function openFile(path, { reload = false } = {}) {
    const state = deps.getState();
    const editorHandle = deps.getEditorHandle();
    const fileTree = deps.getFileTree();
    let autosave = deps.getAutosave && deps.getAutosave();

    if (!reload && state.currentPath === path && tabDocs.has(path)) {
      editorHandle.easyMDE.codemirror.focus();
      if (deps.resurfaceDraftBanner) void deps.resurfaceDraftBanner(path);
      if (deps.isMobileShell && deps.isMobileShell() && deps.setMobileSidebarOpen) {
        deps.setMobileSidebarOpen(false);
      }
      return;
    }

    const seq = ++openSeq;
    const leaving = state.currentPath;
    const switching = !!leaving && leaving !== path;
    const leavingTab = switching ? tabDocs.get(leaving) : null;

    if (switching && autosave) {
      if (leavingTab) leavingTab.commitSeen = false;
      await autosave.flushCurrentFile();
      if (seq !== openSeq) return;
    }

    const cached = tabDocs.get(path);
    const useCache = !reload && !!cached && !!cached.doc && !cached.stale;

    if (els.btnSave) els.btnSave.disabled = true;
    if (els.btnExportPdf) els.btnExportPdf.disabled = true;
    if (els.btnDelete) els.btnDelete.disabled = true;
    if (els.currentFileLabel) els.currentFileLabel.textContent = path;
    fileTree.setActive(path);
    if (!useCache) deps.setSaveStatus('Loading...', false);

    try {
      let remoteText;
      let sha;
      if (useCache) {
        remoteText = cached.doc.getValue();
        sha = cached.sha;
      } else {
        const fetched = await state.client.getFileB64(path);
        if (seq !== openSeq) return;
        sha = fetched.sha;
        try {
          remoteText = b64ToUtf8(fetched.b64);
        } catch (_) {
          deps.setSaveStatus(`Cannot open ${path}: the file is not valid UTF-8`, true);
          restoreChrome();
          return;
        }
      }

      if (switching) {
        const leavingUnsaved = activeFileUnsaved || (autosave ? autosave.hasUnsavedDraft() : false);
        if (autosave && autosave.hasUnsavedDraft()) {
          if (leavingTab) leavingTab.commitSeen = false;
          await autosave.flushCurrentFile();
          if (seq !== openSeq) return;
        }
        if (leavingTab) leavingTab.unsaved = leavingUnsaved && !leavingTab.commitSeen;
      }

      deps.hideDraftBanner();
      if (deps.setAutosaveStatus) deps.setAutosaveStatus(null);
      state.currentPath = path;
      if (deps.isMobileShell && deps.isMobileShell() && deps.setMobileSidebarOpen) {
        deps.setMobileSidebarOpen(false);
      }
      state.currentSha = sha;
      renderEmptyState();
      autosave = deps.ensureAutosave();
      try {
        if (deps.draftStoreReady) await deps.draftStoreReady;
      } catch (_) { /* degraded */ }
      const opened = await deps.ensureAutosave().onOpen(path, remoteText, sha);
      if (seq !== openSeq) return;

      if (useCache && cached && cached.unsaved && autosave && !opened.hasDraft) {
        autosave.onChange(remoteText);
      }

      let doc;
      if (useCache) {
        doc = cached.doc;
        cached.sha = sha;
        cached.commitSeen = false;
      } else {
        doc = editorHandle.createDoc(opened.text);
        const previous = cached && cached.doc;
        if (previous) {
          doc.setCursor(previous.getCursor());
          doc.scrollTop = previous.scrollTop;
          doc.scrollLeft = previous.scrollLeft;
        }
        tabDocs.set(path, { doc, sha, unsaved: false, stale: false, commitSeen: false });
      }
      showDocInEditor(doc);

      tabs.open(path);
      tabs.activate(path);
      persistTabs();
      renderTabs();

      if (els.btnSave) els.btnSave.disabled = false;
      const kind = kindFromPath(path);
      if (els.btnExportPdf) {
        els.btnExportPdf.disabled = !(kind.kind === 'markdown' || kind.kind === 'html');
      }
      if (els.btnDelete) els.btnDelete.disabled = false;
      if (deps.updateLangBadge) deps.updateLangBadge(kind);
      if (editorHandle && typeof editorHandle.setLanguage === 'function') {
        editorHandle.setLanguage(kind.mode);
      }
      if (editorHandle && typeof editorHandle.setToolbarForKind === 'function') {
        editorHandle.setToolbarForKind(kind);
      }
      if (editorHandle && typeof editorHandle.renderActivePreview === 'function') {
        editorHandle.renderActivePreview();
      }
      if (els.docOutline && !els.docOutline.classList.contains('hidden') && deps.renderDocOutline) {
        deps.renderDocOutline();
      }
      if (els.minimapWrap && !els.minimapWrap.classList.contains('hidden') && deps.ensureMinimap) {
        deps.ensureMinimap();
      }
      deps.setSaveStatus('Ready', false);

      if (opened.hasDraft) {
        deps.setPendingDraft(opened.draftText);
        const age = deps.formatAge
          ? deps.formatAge(Date.now() - opened.draftSavedAt)
          : '';
        deps.showDraftBanner(
          age
            ? `You have unsaved local changes from ${age}.`
            : 'You have unsaved local changes.',
          'draft'
        );
      }
    } catch (e) {
      deps.setSaveStatus('Error: ' + e.message, true);
      restoreChrome();
    }
  }

  async function closeTab(path) {
    if (!tabs.has(path)) return;
    const state = deps.getState();
    const wasActive = state.currentPath === path;
    const autosave = deps.getAutosave && deps.getAutosave();
    if (wasActive && autosave) await autosave.flushCurrentFile();

    const { next } = tabs.close(path);
    tabDocs.delete(path);
    persistTabs();
    renderTabs();
    if (!wasActive) return;

    if (next) await openFile(next);
    else if (deps.closeCurrentFile) await deps.closeCurrentFile({ flush: false });
  }

  async function dropTabs(paths) {
    const state = deps.getState();
    const activeGone = state.currentPath !== null && paths.includes(state.currentPath);
    for (const path of paths) {
      tabs.close(path);
      tabDocs.delete(path);
    }
    persistTabs();
    renderTabs();
    if (!activeGone) {
      renderEmptyState();
      return;
    }
    if (deps.closeCurrentFile) await deps.closeCurrentFile({ flush: false });
    if (tabs.active) await openFile(tabs.active);
    renderEmptyState();
  }

  function markStale(paths) {
    for (const path of paths) {
      const tab = tabDocs.get(path);
      if (tab) tab.stale = true;
    }
  }

  function moveTabDoc(oldPath, newPath) {
    const tab = tabDocs.get(oldPath);
    tabDocs.delete(oldPath);
    if (tab) {
      tab.stale = true;
      tabDocs.set(newPath, tab);
    } else {
      tabDocs.delete(newPath);
    }
  }

  function setupTabBar() {
    if (tabBar) {
      tabBar.destroy();
      tabBar = null;
    }
    if (!els.tabBar) return;
    tabBar = createTabBar(els.tabBar, {
      onActivate: (path) => openFile(path),
      onClose: (path) => closeTab(path),
    });
    renderTabs();
  }

  function resetForNewSession() {
    if (tabBar) {
      tabBar.destroy();
      tabBar = null;
    }
    tabs = new TabsModel();
    tabDocs.clear();
    activeFileUnsaved = false;
    tabsRestored = false;
    openSeq++;
  }

  return {
    openFile,
    closeTab,
    dropTabs,
    markStale,
    moveTabDoc,
    persistTabs,
    renderTabs,
    noteCommit,
    restoreTabsOnce,
    renderEmptyState,
    restoreChrome,
    setupTabBar,
    resetForNewSession,
    getTabs: () => tabs,
    getTabDocs: () => tabDocs,
    getActiveFileUnsaved: () => activeFileUnsaved,
    setActiveFileUnsaved: (v) => { activeFileUnsaved = !!v; },
  };
}
