// app.js
// App assembly point. Holds minimal state and wires modules together.
// All business logic lives in separate modules (paths/markdown-tokens/reference-rewriter/
// file-mover/image-resolver) — only "wiring" and DOM event handlers here.

import { DemoClient, isDemoSession } from './demo-client.js';
import { GitHubClient, b64ToUtf8 } from './github-client.js';
import { ImageResolver } from './image-resolver.js';
import { createEditor } from './editor.js';
import { FileTree } from './file-tree.js';
import { setupImageDropzone, pickImageFiles, uploadImage } from './upload.js';
import { setupFolderDropzone } from './folder-upload.js';
import { exportCurrentPageToPdf } from './pdf-export.js';
import { createFileOps } from './file-ops.js';
import { createLoginUI } from './login-ui.js';
import { SearchStore } from './search-store.js';
import { SearchSync } from './search-sync.js';
import { createSearchUI, formatAge } from './search-ui.js';
import { DraftStore } from './draft-store.js';
import { Autosave } from './autosave.js';
import { TabsModel, tabLabels, tabsStorageKey } from './tabs.js';
import { createTabBar } from './tabs-ui.js';
import { WorkingTree } from './working-tree.js';
import { createCommitHistoryUI } from './commit-history-ui.js';
import { kindFromPath, isHtmlPath, isMarkdownPath } from './file-kind.js';
import { parseHeadingOutline } from './doc-outline.js';
import { createBacklinkIndex } from './backlinks.js';
import { buildHtmlSrcdoc } from './html-preview.js';
import { createMinimap } from './minimap.js';

const els = {
  loginScreen: document.getElementById('login-screen'),
  loginStatus: document.getElementById('login-status'),
  inputOwner: document.getElementById('input-owner'),
  inputRepo: document.getElementById('input-repo'),
  btnLogin: document.getElementById('btn-login'),
  btnDemo: document.getElementById('btn-demo'),
  demoBanner: document.getElementById('demo-banner'),
  loginCta: document.getElementById('login-cta'),
  loginTrust: document.getElementById('login-trust'),
  repoPicker: document.getElementById('repo-picker'),
  repoPickerUser: document.getElementById('repo-picker-user'),
  repoList: document.getElementById('repo-list'),
  repoSearch: document.getElementById('repo-search'),
  btnOpenRepo: document.getElementById('btn-open-repo'),

  appHeader: document.getElementById('app-header'),
  appMain: document.getElementById('app-main'),
  repoLabel: document.getElementById('repo-label'),
  btnSwitchRepo: document.getElementById('btn-switch-repo'),
  repoSwitchOverlay: document.getElementById('repo-switch-overlay'),
  repoSwitchList: document.getElementById('repo-switch-list'),
  repoSwitchSearch: document.getElementById('repo-switch-search'),
  btnRepoSwitchClose: document.getElementById('btn-repo-switch-close'),
  switchInputOwner: document.getElementById('switch-input-owner'),
  switchInputRepo: document.getElementById('switch-input-repo'),
  btnSwitchOpenPath: document.getElementById('btn-switch-open-path'),
  repoSwitchStatus: document.getElementById('repo-switch-status'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnLogout: document.getElementById('btn-logout'),
  branchLabel: document.getElementById('branch-label'),
  branchPill: document.getElementById('branch-pill'),
  layoutToggle: document.getElementById('layout-toggle'),
  btnHistory: document.getElementById('btn-history'),
  btnCommit: document.getElementById('btn-commit'),
  commitBadge: document.getElementById('commit-badge'),
  commitPanel: document.getElementById('commit-panel'),
  commitMessage: document.getElementById('commit-message'),
  commitFiles: document.getElementById('commit-files'),
  btnCommitClose: document.getElementById('btn-commit-close'),
  btnCommitOnly: document.getElementById('btn-commit-only'),
  btnCommitPush: document.getElementById('btn-commit-push'),
  historyPanel: document.getElementById('history-panel'),
  historyList: document.getElementById('history-list'),
  historyDetail: document.getElementById('history-detail'),
  btnHistoryClose: document.getElementById('btn-history-close'),
  editorArea: document.querySelector('.editor-area'),
  diffOverlay: document.getElementById('diff-overlay'),
  diffOverlayTitle: document.getElementById('diff-overlay-title'),
  diffOverlayBody: document.getElementById('diff-overlay-body'),
  btnDiffBack: document.getElementById('btn-diff-back'),
  btnDiffRestore: document.getElementById('btn-diff-restore'),

  fileTreeEl: document.getElementById('file-tree'),
  searchInput: document.getElementById('search-input'),
  searchStatus: document.getElementById('search-status'),
  searchResults: document.getElementById('search-results'),
  btnReindex: document.getElementById('btn-reindex'),
  folderDropzone: document.getElementById('folder-dropzone'),
  folderDropOverlay: document.getElementById('folder-dropzone-overlay'),
  btnNewFolder: document.getElementById('btn-new-folder'),
  btnNewFile: document.getElementById('btn-new-file'),
  btnAddMenu: document.getElementById('btn-add-menu'),
  addMenu: document.getElementById('add-menu'),
  activeFolderPath: document.getElementById('active-folder-path'),

  tabBar: document.getElementById('tab-bar'),
  currentFileLabel: document.getElementById('current-file'),
  langBadge: document.getElementById('lang-badge'),
  btnFind: document.getElementById('btn-find'),
  findBar: document.getElementById('find-bar'),
  findInput: document.getElementById('find-input'),
  replaceInput: document.getElementById('replace-input'),
  findCount: document.getElementById('find-count'),
  findPrev: document.getElementById('find-prev'),
  findNext: document.getElementById('find-next'),
  findReplace: document.getElementById('find-replace'),
  findReplaceAll: document.getElementById('find-replace-all'),
  findClose: document.getElementById('find-close'),
  btnWrap: document.getElementById('btn-wrap'),
  btnFold: document.getElementById('btn-fold'),
  btnOutline: document.getElementById('btn-outline'),
  docOutline: document.getElementById('doc-outline'),
  btnBacklinks: document.getElementById('btn-backlinks'),
  backlinksPanel: document.getElementById('backlinks-panel'),
  btnMinimap: document.getElementById('btn-minimap'),
  minimapWrap: document.getElementById('minimap-wrap'),
  minimapCanvas: document.getElementById('minimap'),
  btnSave: document.getElementById('btn-save'),
  btnMoreFile: document.getElementById('btn-more-file'),
  moreFileMenu: document.getElementById('more-file-menu'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
  btnDelete: document.getElementById('btn-delete'),
  saveStatus: document.getElementById('save-status'),
  autosaveStatus: document.getElementById('autosave-status'),
  draftBanner: document.getElementById('draft-banner'),
  draftBannerText: document.getElementById('draft-banner-text'),
  draftKeep: document.getElementById('draft-keep'),
  draftDiscard: document.getElementById('draft-discard'),
  draftReload: document.getElementById('draft-reload'),
  draftOverwrite: document.getElementById('draft-overwrite'),

  btnMobileFiles: document.getElementById('btn-mobile-files'),
  btnMobileFmt: document.getElementById('btn-mobile-fmt'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  appSidebar: document.getElementById('app-sidebar'),
  editorContainer: document.getElementById('editor-container'),
  editorTextarea: document.getElementById('editor'),
  dropOverlay: document.getElementById('editor-dropzone-overlay'),
  imageFileInput: document.getElementById('image-file-input'),

  emptyState: document.getElementById('editor-empty-state'),
  emptyStateNewFile: document.getElementById('empty-state-new-file'),
};

const state = {
  client: null,
  branch: '',
  currentPath: null,
  currentSha: null,
  demo: false,
  allFiles: [], // [{path, sha}]
  // False until the first getTree() succeeds. Distinguishes "not loaded yet"
  // (skip the sync) from "loaded and genuinely empty" (must still sync).
  treeLoaded: false,
};

let imageResolver = null;
let fileTree = null;
/** @type {ReturnType<typeof createFileOps>|null} */
let fileOps = null;
let editorHandle = null;
let searchSync = null;
/** @type {ReturnType<typeof createBacklinkIndex>} */
let backlinkIndex = createBacklinkIndex();
let backlinksRefreshTimer = 0;
let searchUI = null;
let draftStore = null;
let autosave = null;
// Set while the editor is being loaded programmatically. EasyMDE fires
// CodeMirror's 'change' SYNCHRONOUSLY from .value(), so without this a plain
// file open would look exactly like the user typing: autosave would arm its
// timers and the freshly loaded file would immediately claim "● Unsaved".
let suppressEditorChange = false;
// The draft text behind a visible recovery banner. It is kept here because
// "Keep local" is a click that happens long after onOpen() returned — autosave
// only knows there IS a draft, the text to load lives with the banner.
let pendingDraft = null;
// Set while a background reindex is running, so a second one is not started.
let syncing = false;

// ---- Tabs ----
// `tabs` is only the ordered list + which one is active (js/tabs.js). The heavy
// per-tab state lives here, keyed by path:
//   doc        the tab's own CodeMirror document, so undo history, cursor and
//              scroll position survive switching away and back
//   sha        the last blob sha we know GitHub has for this file
//   unsaved    we left the tab with something GitHub does not have yet (hybrid
//              model: local draft / working tree). The cached CodeMirror doc is
//              still trusted on return — do NOT refetch, or the in-memory edits
//              and undo history are wiped. Draft banner is for cold reload only.
//   stale      the file was renamed/moved or its links were rewritten, so the cached
//              document no longer matches GitHub
//   commitSeen a commit for this path landed since we started leaving it
// A path with no entry here is a tab that was restored but never opened yet.
let tabs = new TabsModel();
let tabBar = null;
let workingTree = new WorkingTree();
/** @type {ReturnType<typeof createCommitHistoryUI>|null} */
let commitHistoryUI = null;
let layoutMode = localStorage.getItem('md_layout') || 'source';
const tabDocs = new Map();
// Whether the ACTIVE file differs from GitHub, derived from the autosave label.
let activeFileUnsaved = false;
// Bumped by every openFile(); a slower, older open compares against it and gives
// up instead of overwriting the editor with a file the user has moved on from.
let openSeq = 0;
// The persisted tab list is read once per session, on the first tree load.
let tabsRestored = false;

// ====================== LOGIN ======================
const loginUI = createLoginUI({
  // DOM — sign-in screen
  btnLogin: els.btnLogin,
  btnLogout: els.btnLogout,
  inputOwner: els.inputOwner,
  inputRepo: els.inputRepo,
  loginStatus: els.loginStatus,
  loginScreen: els.loginScreen,
  loginCta: els.loginCta,
  loginTrust: els.loginTrust,

  // DOM — picker
  repoPicker: els.repoPicker,
  repoPickerUser: els.repoPickerUser,
  repoList: els.repoList,
  repoSearch: els.repoSearch,
  btnOpenRepo: els.btnOpenRepo,

  // DOM — switcher
  btnSwitchRepo: els.btnSwitchRepo,
  repoSwitchOverlay: els.repoSwitchOverlay,
  repoSwitchList: els.repoSwitchList,
  repoSwitchSearch: els.repoSwitchSearch,
  btnRepoSwitchClose: els.btnRepoSwitchClose,
  switchInputOwner: els.switchInputOwner,
  switchInputRepo: els.switchInputRepo,
  btnSwitchOpenPath: els.btnSwitchOpenPath,
  repoSwitchStatus: els.repoSwitchStatus,

  // DOM — misc
  branchLabel: els.branchLabel,

  // Callbacks for the shell
  onSignedIn: (owner, repo, token, branch) => {
    state.client = new GitHubClient({ token, owner, repo });
    state.branch = branch;
    showApp(owner, repo);
    loadTree();
  },
  onSignOut: () => {
    if (autosave) autosave.destroy();
    sessionStorage.clear();
    location.reload();
  },
  onSessionRestoreFailed: () => {
    state.demo = false;
    if (els.demoBanner) els.demoBanner.classList.add('hidden');
  },

  // Demo bridge (login-ui doesn't own demo, it just delegates)
  isDemoSession: () => isDemoSession(),
  startDemo: () => startDemo(),

  // Status reporting
  setSaveStatus: (msg, isError) => setSaveStatus(msg, isError),

  // Autosave bridge (narrow)
  hasUnsavedDraft: () => !!(autosave && autosave.hasUnsavedDraft()),
  flushBeforeSwitch: async () => {
    if (autosave && typeof autosave.saveNow === 'function') {
      await autosave.saveNow();
    }
  },
});

init();

async function init() {
  // Non-login chrome controls get wired here; the Sign in / Sign out buttons and
  // the repo switcher are wired inside loginUI.bootstrap() below (which runs
  // before any showApp/OAuth work, so a later throw still leaves a working
  // sign-in button).
  if (els.btnDemo) {
    els.btnDemo.onclick = () => { startDemo(); };
  }
  const btnDemoExit = document.getElementById('btn-demo-exit');
  if (btnDemoExit) {
    btnDemoExit.onclick = () => {
      if (autosave) try { autosave.destroy(); } catch (_) {}
      sessionStorage.clear();
      location.reload();
    };
  }
  if (els.btnRefresh) els.btnRefresh.onclick = () => loadTree();
  // Wrap in arrows: assigning the handler directly would hand it the click
  // event as `folderPath`, creating "[object PointerEvent]/name.md".
  ensureFileOps().setupToolbar();
  if (els.btnSave) els.btnSave.onclick = onSaveFile;
  if (els.btnExportPdf) els.btnExportPdf.onclick = onExportPdf;

  // Only the editor core is fatal. Optional CDNs (html2pdf, highlight, minisearch)
  // must NOT paint a red banner — they often trip ad-block while EasyMDE is fine.
  if (typeof window.EasyMDE !== 'function') {
    const miss = (window.__mdCdnMiss || ['easymde']).join(', ');
    loginUI.setStatus(
      'Editor failed to load (' + miss + '). If the console shows ERR_BLOCKED_BY_CLIENT, '
      + 'allow cdn.jsdelivr.net for this site and reload.',
      true
    );
  }

  // bootstrap() must be awaited, and must be allowed to end init() on its own:
  // onSignedIn() → showApp() is reached from inside it (fresh OAuth and session
  // restore both complete there). Reading the session while the token check is
  // still in flight would build the app TWICE when an OAuth callback lands on a
  // tab that still holds a session — two editors, two ResizeObservers, two paste
  // handlers, with the first one nobody can reach to tear down.
  //
  // `terminal` is true for fresh OAuth or demo start — the old code returned
  // early in those cases and did NOT attach the listeners below. Preserved
  // verbatim; see the matching note in js/login-ui.js bootstrap().
  const terminal = await loginUI.bootstrap();
  if (terminal) return;

  // Switching tabs is the natural checkpoint Google Docs uses too: commit a
  // dirty draft immediately instead of making the user wait out the 10s window.
  // beforeunload is NOT the place for this — a fetch started there is cancelled
  // by the browser, so all it can do is ask the user to confirm.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && autosave) autosave.onVisibilityChange(true);
  });
  // In the hybrid model, hasUnsavedDraft() is true for anything not on GitHub —
  // even for a safely-written IndexedDB draft. Prompt anyway: IndexedDB can be
  // cleared (private mode, "clear site data"), and work inside the 400ms debounce
  // window exists only in JS memory. "On GitHub or nothing" is the right prompt
  // threshold here. Do NOT narrow this to DIRTY_LOCAL — a draft is not durable
  // enough to count as "safe to close".
  window.addEventListener('beforeunload', (e) => {
    if (!autosave || !autosave.hasUnsavedDraft()) return;
    // The draft is already in IndexedDB by now; this is only the courtesy
    // prompt users expect. Nothing is fetched here — it would not survive.
    e.preventDefault();
    e.returnValue = '';
  });
}

// Informational statuses ("Moved: ...", "Saved ✓") must not stay on screen forever —
// otherwise the last message lingers until the page is reloaded. Errors are exempt:
// they need to stay visible until the next action replaces them.
const STATUS_CLEAR_MS = 4000;
let statusClearTimer = null;

function setSaveStatus(msg, isError) {
  els.saveStatus.textContent = msg;
  els.saveStatus.className = 'status ' + (isError ? 'err' : 'ok');

  clearTimeout(statusClearTimer);
  if (!isError) {
    statusClearTimer = setTimeout(() => {
      // Guard: a newer status may have arrived in the meantime — never wipe it.
      if (els.saveStatus.textContent !== msg) return;
      els.saveStatus.textContent = '';
      els.saveStatus.className = 'status';
    }, STATUS_CLEAR_MS);
  }
}

// ====================== AUTOSAVE ======================
// The label next to Save. Deliberately NOT setSaveStatus(): that one wipes
// itself after 4s for every informational message ("Moved: ..."), which is
// right for a one-off event and wrong for the live condition of the open file.
// Only "✓ Saved to GitHub" fades here, and only because autosave says so
// (`fade: true`) — see the STATUS table in js/autosave.js.
let autosaveClearTimer = null;

function setAutosaveStatus(status) {
  // Everything but "Saved to GitHub" (and no label at all) means the open file
  // has something GitHub does not — that is what the dot on its tab shows.
  const unsaved = !!status && status.variant !== 'ok';
  if (unsaved !== activeFileUnsaved) {
    activeFileUnsaved = unsaved;
    renderTabs();
  }
  clearTimeout(autosaveClearTimer);
  if (!status) {
    els.autosaveStatus.textContent = '';
    els.autosaveStatus.className = 'autosave-status';
    return;
  }
  els.autosaveStatus.textContent = status.text;
  els.autosaveStatus.className = `autosave-status ${status.variant}`;
  if (status.fade) {
    autosaveClearTimer = setTimeout(() => {
      // Guard: a newer status may have arrived in the meantime — never wipe it.
      if (els.autosaveStatus.textContent !== status.text) return;
      els.autosaveStatus.textContent = '';
      els.autosaveStatus.className = 'autosave-status';
    }, STATUS_CLEAR_MS);
  }
}

/** One banner, two questions. The user always picks a side — never a merge. */
function showDraftBanner(text, buttons) {
  els.draftBannerText.textContent = text;
  els.draftKeep.classList.toggle('hidden', buttons !== 'draft');
  els.draftDiscard.classList.toggle('hidden', buttons !== 'draft');
  els.draftReload.classList.toggle('hidden', buttons !== 'conflict');
  els.draftOverwrite.classList.toggle('hidden', buttons !== 'conflict');
  els.draftBanner.classList.remove('hidden');
}

function hideDraftBanner() {
  els.draftBanner.classList.add('hidden');
  pendingDraft = null;
}

/**
 * Builds the session's Autosave over the shared DraftStore.
 *
 * Called from showApp() and again from openFile() whenever the previous
 * instance was destroyed, because a destroyed Autosave deliberately ignores
 * everything afterwards. (Closing a tab or deleting the open file only release()s
 * the instance, so in practice this runs once per session.)
 */
let draftStoreReady = Promise.resolve();

function createAutosave(owner, repo) {
  if (draftStore) draftStore.close();
  draftStore = new DraftStore({
    onDegrade: () => {
      // Crash recovery is GONE from now on, and the user should know that
      // rather than find out by losing work.
      setSaveStatus('Local drafts unavailable (browser storage is disabled) — closing the tab will lose unsaved text', true);
    },
  });
  // Keep a promise so openFile can wait for IndexedDB before draft lookup
  draftStoreReady = draftStore.open().catch(() => { /* open() never rejects; it degrades */ });

  return new Autosave({
    client: state.client,
    store: draftStore,
    owner,
    repo,
    branch: state.branch,
    getText: () => (editorHandle ? editorHandle.easyMDE.value() : ''),
    onStatus: setAutosaveStatus,
    onRemoteCommit: (path, sha) => {
      if (sha && state.currentPath === path) state.currentSha = sha;
      noteCommit(path, sha);
    },
    onConflict: () => {
      showDraftBanner(
        'This file changed on GitHub while you were editing it. Reload to take the GitHub version, or overwrite it with yours.',
        'conflict'
      );
    },
    onReloadRemote: (path, text, sha) => {
      if (state.currentPath !== path) return;
      state.currentSha = sha;
      const tab = tabDocs.get(path);
      if (tab) tab.sha = sha;
      setEditorValue(text);
      hideDraftBanner();
      setSaveStatus(`Reloaded from GitHub: ${path}`, false);
    },
  });
}

/** The instance to use right now (rebuilt if it was ever destroyed). */
function ensureAutosave() {
  if (!autosave || autosave.destroyed) {
    autosave = createAutosave(state.client.owner, state.client.repo);
  }
  return autosave;
}

/** Loads text into CodeMirror without it looking like a user edit. */
function setEditorValue(text) {
  suppressEditorChange = true;
  try {
    editorHandle.easyMDE.value(text);
  } finally {
    suppressEditorChange = false;
  }
  editorHandle.refreshLayout();
  editorHandle.refreshInlineImages();
}

// ====================== APP SHELL ======================

/** Landing "Try demo" — no OAuth, in-memory files only. */
function startDemo() {
  try {
    sessionStorage.setItem('gh_demo', '1');
    sessionStorage.removeItem('gh_token');
  } catch (_) { /* ignore */ }
  state.token = 'demo';
  state.owner = 'demo';
  state.repo = 'sandbox';
  state.branch = 'main';
  state.client = new DemoClient();
  state.demo = true;
  showApp('demo', 'sandbox');
  loadTree();
  if (els.demoBanner) els.demoBanner.classList.remove('hidden');
  // Soft-disable GitHub-only chrome
  if (els.btnHistory) {
    els.btnHistory.disabled = true;
    els.btnHistory.title = 'History needs a real GitHub repo — exit demo and sign in';
  }
  if (els.btnCommit) {
    // Commit can still write into DemoClient — allow it, but label is fine
    els.btnCommit.title = 'Demo: commits stay in this browser only (not GitHub)';
  }
  if (els.btnSwitchRepo) {
    els.btnSwitchRepo.disabled = true;
    els.btnSwitchRepo.title = 'Repo switch needs GitHub sign-in';
  }
  if (els.repoLabel) {
    els.repoLabel.textContent = 'demo / sandbox';
    els.repoLabel.title = 'Local demo — not a GitHub repository';
  }
}

function showApp(owner, repo) {
  // A different repo means a different file list. Reset it here, not only on
  // logout, so a re-login cannot hand the new session the previous repo's tree
  // (which would make runSearchSync diff against the wrong paths).
  state.allFiles = [];
  state.treeLoaded = false;
  state.currentPath = null;
  state.currentSha = null;

  // Defensive: createEditor() owns a ResizeObserver, a paste handler and a
  // CodeMirror 'change' handler, and re-wrapping an already-wrapped textarea
  // stacks a second editor. Tear the previous one down before building again.
  if (editorHandle) {
    destroyMinimap(); editorHandle.destroy();
    editorHandle = null;
  }
  // Same reason: an in-flight sync holds a GitHubClient and an index belonging to
  // the PREVIOUS session. Without this, a re-login would leave the old indexer
  // fetching and writing into the new one — two indexers, one store.
  if (searchSync) {
    searchSync.destroy();
    searchSync = null;
  }
  if (searchUI) {
    searchUI.destroy();
    searchUI = null;
  }
  // Same reason as the editor handle: a live Autosave owns timers and an
  // in-flight PUT aimed at the PREVIOUS session's repository.
  if (autosave) {
    autosave.destroy();
    autosave = null;
  }
  syncing = false;
  if (fileTree) fileTree = null;
  // Tabs belong to one session of one repository.
  if (tabBar) {
    tabBar.destroy();
    tabBar = null;
  }
  tabs = new TabsModel();
  tabDocs.clear();
  activeFileUnsaved = false;
  tabsRestored = false;
  openSeq++; // abandon any open still in flight from the previous session

  els.loginScreen.classList.add('hidden');
  els.appHeader.classList.remove('hidden');
  els.appMain.classList.remove('hidden');
  els.repoLabel.textContent = `${owner}/${repo}`;
  if (els.demoBanner) {
    if (state.demo) els.demoBanner.classList.remove('hidden');
    else els.demoBanner.classList.add('hidden');
  }

  if (typeof window.EasyMDE !== 'function') {
    const miss = (window.__mdCdnMiss || ['easymde']).join(', ');
    const msg = 'Editor libraries failed to load (' + miss + '). '
      + 'Usually an ad-blocker (ERR_BLOCKED_BY_CLIENT) blocked cdn.jsdelivr.net. '
      + 'Disable the blocker for this site or allow jsdelivr, then reload.';
    console.error(msg);
    try {
      els.loginScreen.classList.remove('hidden');
      els.appHeader.classList.add('hidden');
      els.appMain.classList.add('hidden');
      loginUI.setStatus(msg, true);
    } catch (_) {}
    return;
  }

  imageResolver = new ImageResolver(state.client);

  const ops = ensureFileOps();
  fileTree = new FileTree(els.fileTreeEl, {
    onOpenFile: openFile,
    onPreviewImage: previewImageFile,
    getActivePath: () => state.currentPath,
    ...ops.treeHandlers(),
  });
  ops.updateActiveFolderPathLabel(fileTree.getActiveFolder());

  editorHandle = createEditor(els.editorTextarea, {
    marked: window.marked,
    imageResolver,
    getCurrentPath: () => state.currentPath,
    onOpenInternalLink: (path) => {
      if (path && typeof openFile === 'function') openFile(path).catch(() => {
        setSaveStatus('Link target not found: ' + path, true);
      });
    },
    onImageUploadRequest: () => els.imageFileInput.click(),
    // Every keystroke arms the autosave timers. `suppressEditorChange` is what
    // keeps a programmatic .value() (opening a file, reloading after a
    // conflict) from being mistaken for typing.
    onChange: (text) => {
      if (suppressEditorChange) return;
      // Autosave FIRST — draft recovery depends on every keystroke reaching IndexedDB
      ensureAutosave().onChange(text);
      // Outline is a cheap parse but an expensive DOM rebuild — debounce it,
      // and only when the panel is actually open.
      scheduleOutlineRefresh();
      scheduleBacklinksRefresh();
      // Working-tree badges are best-effort and must never interrupt draft writes
      try {
        if (state.currentPath && workingTree) {
          workingTree.setDirty(state.currentPath, text, state.currentSha || null);
          ensureCommitHistoryUI().refreshBadge();
          if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());
        }
      } catch (_) { /* ignore */ }
    },
    onImagePaste: (file) => uploadImage(file, {
      client: state.client,
      imageResolver,
      getCurrentPath: () => state.currentPath,
      getAllFiles: () => state.allFiles,
      insertText: insertMarkdownAtCursor,
      onStatus: setSaveStatus,
      onUploaded: () => loadTree(),
    }),
    onImageResolveFailures: (count) =>
      setSaveStatus(`Preview: failed to load ${count} image(s) — details shown in place of the image`, true),
  });

  tabBar = createTabBar(els.tabBar, {
    onActivate: (path) => openFile(path),
    onClose: (path) => closeTab(path),
  });
  renderTabs();

  // The empty-state "+ New file" button runs the exact same flow as the sidebar
  // "+ Add" menu (same prompt, same default folder). Wrapped in an arrow so the
  // click event is not passed as the folderPath argument.
  if (els.emptyStateNewFile) {
    els.emptyStateNewFile.onclick = () => ensureFileOps().onCreateNewFile();
  }

  // Hybrid layout + Commit / History panels (idempotent re-bind each showApp)
  try { applyLayoutMode(layoutMode); } catch (e) { console.warn(e); }
  try { setupLayoutToggle(); } catch (e) { console.warn(e); }
  try { setupFindBar(); } catch (e) { console.warn(e); }
  try { setupMoreFileMenu(); } catch (e) { console.warn(e); }
  try { setupDocOutline(); } catch (e) { console.warn(e); }
  try { setupBacklinks(); } catch (e) { console.warn(e); }
  try { setupMobileShell(); } catch (e) { console.warn(e); }
  try { setupMinimap(); } catch (e) { console.warn(e); }
  if (els.minimapWrap && !els.minimapWrap.classList.contains('hidden')) {
    ensureMinimap();
  }
  ensureCommitHistoryUI().setup();
  workingTree.clearAll();
  ensureCommitHistoryUI().refreshBadge();

  // Key fix for "doesn't scroll / not editable": force a CodeMirror layout
  // recalculation right after the container became visible and got its
  // real size (at EasyMDE construction time the container may not yet have had
  // its final height due to the flex layout used across the page).
  requestAnimationFrame(() => editorHandle.refreshLayout());

  setupImageDropzone(els.editorContainer, els.dropOverlay, {
    client: state.client,
    imageResolver,
    getCurrentPath: () => state.currentPath,
    getAllFiles: () => state.allFiles,
    insertText: insertMarkdownAtCursor,
    onStatus: setSaveStatus,
    onUploaded: () => loadTree(),
  });

  pickImageFiles(els.imageFileInput, {
    client: state.client,
    imageResolver,
    getCurrentPath: () => state.currentPath,
    getAllFiles: () => state.allFiles,
    insertText: insertMarkdownAtCursor,
    onStatus: setSaveStatus,
    onUploaded: () => loadTree(),
  });

  setupFolderDropzone(els.folderDropzone, els.folderDropOverlay, {
    client: state.client,
    getAllFiles: () => state.allFiles,
    onStatus: setSaveStatus,
    onUploaded: () => loadTree(),
  });

  setupAutosaveUI(owner, repo);
  setupSearch(owner, repo);

  // Initial chrome: no file is open yet, so show the empty-state card. If a tab
  // is restored from the previous session, loadTree() -> restoreTabsOnce() ->
  // openFile() will flip this back to the editor on its own.
  renderEmptyState();
}

/** Draft banner buttons + the two "the user is leaving" hooks. */


function ensureFileOps() {
  if (fileOps) return fileOps;
  fileOps = createFileOps({
    els: {
      btnNewFile: els.btnNewFile,
      btnNewFolder: els.btnNewFolder,
      btnDelete: els.btnDelete,
      btnSave: els.btnSave,
      btnAddMenu: els.btnAddMenu,
      addMenu: els.addMenu,
      activeFolderPath: els.activeFolderPath,
      currentFileLabel: els.currentFileLabel,
    },
    getState: () => state,
    getFileTree: () => fileTree,
    getTabs: () => tabs,
    getImageResolver: () => imageResolver,
    setSaveStatus,
    openFile,
    loadTree,
    dropTabs,
    moveTabDoc,
    markStale,
    persistTabs,
    renderTabs,
    insertMarkdownAtCursor: typeof insertMarkdownAtCursor === 'function' ? insertMarkdownAtCursor : undefined,
  });
  return fileOps;
}

function ensureCommitHistoryUI() {
  if (commitHistoryUI) return commitHistoryUI;
  commitHistoryUI = createCommitHistoryUI({
    els: {
      btnCommit: els.btnCommit,
      commitBadge: els.commitBadge,
      commitPanel: els.commitPanel,
      commitMessage: els.commitMessage,
      commitFiles: els.commitFiles,
      btnCommitClose: els.btnCommitClose,
      btnCommitOnly: els.btnCommitOnly,
      btnCommitPush: els.btnCommitPush,
      btnHistory: els.btnHistory,
      historyPanel: els.historyPanel,
      historyList: els.historyList,
      historyDetail: els.historyDetail,
      btnHistoryClose: els.btnHistoryClose,
      diffOverlay: els.diffOverlay,
      diffOverlayTitle: els.diffOverlayTitle,
      diffOverlayBody: els.diffOverlayBody,
      btnDiffBack: els.btnDiffBack,
      btnDiffRestore: els.btnDiffRestore,
    },
    getWorkingTree: () => workingTree,
    getState: () => state,
    getEditorHandle: () => editorHandle,
    getTabs: () => tabs,
    getTabDocs: () => tabDocs,
    getFileTree: () => fileTree,
    setSaveStatus,
    openFile,
    setEditorValue,
    ensureAutosave,
    setActiveFileUnsaved: (v) => { activeFileUnsaved = !!v; },
    getActiveFileUnsaved: () => activeFileUnsaved,
    noteCommit,
    renderTabs,
    loadTree,
    getDraftStore: () => draftStore,
  });
  return commitHistoryUI;
}

function setupAutosaveUI(owner, repo) {
  autosave = createAutosave(owner, repo);

  // Best-effort: persist the in-memory draft before the tab goes away so a
  // reload within the 400ms debounce window still recovers the text.
  if (!window.__mdDraftFlushBound) {
    window.__mdDraftFlushBound = true;
    window.addEventListener('pagehide', () => {
      try {
        if (autosave && typeof autosave.flushDraftSync === 'function') {
          autosave.flushDraftSync();
        }
      } catch (_) { /* ignore */ }
    });
  }

  els.draftKeep.onclick = () => {
    const path = state.currentPath;
    const text = pendingDraft;
    hideDraftBanner();
    if (text == null) return;
    setEditorValue(text);
    autosave.resumeDraft(path, text);
  };
  els.draftDiscard.onclick = async () => {
    await autosave.discardDraft(state.currentPath);
    hideDraftBanner();
    setSaveStatus('Local draft discarded', false);
  };
  els.draftReload.onclick = () => autosave.resolveConflict('reload');
  // The banner must go away once the overwrite actually landed. If it conflicts
  // again (result.ok === false) the autosave raises onConflict() once more and the
  // banner simply stays, so only a successful push may hide it.
  els.draftOverwrite.onclick = async () => {
    const result = await autosave.resolveConflict('overwrite');
    if (result && result.ok) hideDraftBanner();
  };
}

/**
 * Wires the search input and starts the background index sync.
 *
 * Everything here is deliberately AFTER the editor is built and NOT awaited:
 * the tree and the editor must be usable immediately, and on a returning login
 * the hydrated index already answers queries from memory.
 */
function setupSearch(owner, repo) {
  if (typeof window.MiniSearch !== 'function') {
    // The CDN <script> failed to load. Search is the only feature that can be
    // missing like this, so say so instead of failing on a bare type error.
    els.searchStatus.textContent = 'Search unavailable (library failed to load)';
    els.searchStatus.classList.add('degraded');
    return;
  }

  const store = new SearchStore({
    onDegrade: () => setSearchStatus(null, true),
  });

  backlinkIndex = createBacklinkIndex();
  searchSync = new SearchSync({
    client: state.client,
    store,
    owner,
    repo,
    branch: state.branch,
    MiniSearchCtor: window.MiniSearch,
    onProgress: (done, total) => {
      els.searchStatus.textContent = `Indexing… ${done}/${total}`;
      els.searchStatus.classList.remove('degraded');
    },
    onDone: ({ persistent }) => {
      setSearchStatus(null, !persistent);
      // The index may have just gained the file the results are showing.
      if (searchUI && searchUI.isActive()) searchUI.renderResults(els.searchInput.value);
      try {
        const cache = searchSync && searchSync.index && searchSync.index.bodyCache;
        if (cache && typeof cache.forEach === 'function') {
          cache.forEach((path, body) => {
            try { backlinkIndex.setFile(path, body); } catch (__) {}
          });
        }
      } catch (_) {}
      try { renderBacklinksPanel(); } catch (_) {}
    },
    onFileIndexed: (path, body) => {
      try { backlinkIndex.setFile(path, body); } catch (_) {}
    },
    onFileRemoved: (path) => {
      try {
        if (path == null) backlinkIndex.clear();
        else backlinkIndex.removeFile(path);
      } catch (_) {}
    },
  });

  searchUI = createSearchUI({
    inputEl: els.searchInput,
    statusEl: els.searchStatus,
    reindexBtn: els.btnReindex,
    treeEl: els.fileTreeEl,
    resultsEl: els.searchResults,
    getSync: () => searchSync,
    onOpenFile: openFile,
    onReindex: () => runSearchSync(state.allFiles, { force: true }),
  });

  // Hydrate from IndexedDB first (a returning login can search straight away),
  // then sync whatever the tree says is new or changed.
  searchSync
    .hydrate()
    .then(() => {
      setSearchStatus(null, !store.persistent);
      return runSearchSync(state.allFiles);
    })
    .catch((e) => {
      els.searchStatus.textContent = `Search unavailable: ${e.message}`;
      els.searchStatus.classList.add('degraded');
    });
}

/**
 * Background diff+fetch.
 *
 * Skips only while the tree has never been loaded. An EMPTY array is a real
 * state — the user just deleted the last note — and it must still sync, or the
 * index keeps returning files that no longer exist.
 */
async function runSearchSync(tree, { force = false } = {}) {
  if (!searchSync || !tree || !state.treeLoaded) return;
  if (syncing && !force) return;
  syncing = true;
  try {
    await searchSync.run(tree, { force });
  } catch (e) {
    console.warn('search sync failed', e);
  } finally {
    syncing = false;
  }
}

/** "Indexed 342 notes · last synced 12s ago", or the degraded banner. */
function setSearchStatus(indexSize, degraded) {
  if (!searchUI || !searchSync || !searchSync.index) return;
  const count = indexSize == null ? searchSync.index.size : indexSize;
  if (degraded) {
    searchUI.setStatus('Search is session-only (storage unavailable)', true);
    return;
  }
  const age = formatAge(Date.now() - searchSync.lastSyncedAt);
  searchUI.setStatus(`Indexed ${count} note${count === 1 ? '' : 's'} · last synced ${age}`);
}

function insertMarkdownAtCursor(text) {
  const cm = editorHandle.easyMDE.codemirror;
  const doc = cm.getDoc();
  const cursor = doc.getCursor();
  const line = doc.getLine(cursor.line) || '';
  const prefix = cursor.ch === 0 || line.trim() === '' ? '' : '\n';
  doc.replaceRange(prefix + text + '\n', cursor);
  cm.focus();
}

// ====================== FILE TREE ======================
/**
 * Reload the file tree from GitHub.
 * @param {{ rewritePath?: { from: string, to: string }, expandFolder?: string }} [opts]
 *   rewritePath — after a move/rename the recursive tree API often still lists
 *   `from` and not `to` for a few seconds. Apply the local rename before
 *   setFiles so the UI matches what we just wrote (create/delete don't need
 *   this: a single put/delete shows up in the tree more reliably).
 *   expandFolder — folder path to expand (and all ancestors) after render.
 */
async function loadTree(opts = {}) {
  els.fileTreeEl.innerHTML = '<div class="tree-loading">Loading...</div>';
  try {
    let files = await state.client.getTree(state.branch);

    if (opts.rewritePath && opts.rewritePath.from && opts.rewritePath.to
        && opts.rewritePath.from !== opts.rewritePath.to) {
      const { from, to } = opts.rewritePath;
      const prev = files.find((f) => f.path === from);
      files = files.filter((f) => f.path !== from && f.path !== to);
      if (prev) files.push({ ...prev, path: to });
      else files.push({ path: to, sha: 'local' });
      files = files.slice().sort((a, b) => a.path.localeCompare(b.path));
    }

    state.allFiles = files;
    state.treeLoaded = true;
    fileTree.setFiles(files);
    if (opts.expandFolder != null && typeof fileTree.expandFolderChain === 'function') {
      fileTree.expandFolderChain(opts.expandFolder || '');
    }
    restoreTabsOnce(files);
    // Every local write (save/delete/move/rename/create/upload) ends in a
    // loadTree(), so this ONE hook covers them all. The diff makes it cheap:
    // when nothing changed, the sync makes no request at all.
    runSearchSync(files);
    sweepDrafts(files);
  } catch (e) {
    els.fileTreeEl.innerHTML = `<div class="tree-error">Error: ${escapeHtml(e.message)}</div>`;
  }
}

/**
 * Drops drafts nobody can use any more: older than 30 days, or for a path that
 * no longer exists in this repository. Scoped to the CURRENT repo/branch on
 * purpose — signing into another repository must never delete the drafts of the
 * one you were working in (you may switch back).
 */
function sweepDrafts(files) {
  if (!draftStore) return;
  draftStore
    .sweepStaleDrafts(files.map((f) => f.path), Date.now(), {
      owner: state.client.owner,
      repo: state.client.repo,
      branch: state.branch,
    })
    .catch((e) => console.warn('draft sweep failed', e));
}

function previewImageFile(path) {
  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  overlay.innerHTML = `<div class="image-preview-box">
    <div class="image-preview-path">${escapeHtml(path)}</div>
    <img />
  </div>`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);

  imageResolver
    .resolve(path.startsWith('/') ? path : '/' + path, null)
    .then((url) => { overlay.querySelector('img').src = url; })
    .catch((err) => {
      overlay.querySelector('.image-preview-path').textContent = 'Failed to load: ' + err.message;
      console.warn('previewImageFile', path, err);
    });
}
// ====================== TABS ======================
function tabsKey() {
  return tabsStorageKey(state.client.owner, state.client.repo, state.branch);
}

/** The open tabs survive a page reload (sessionStorage, like the token: gone with the browser tab). */
function persistTabs() {
  if (!state.client) return;
  try {
    sessionStorage.setItem(tabsKey(), JSON.stringify(tabs.toJSON()));
  } catch (_) { /* storage disabled or full — tabs just will not survive a reload */ }
}

function renderTabs() {
  if (!tabBar) return;
  const dirty = new Set();
  for (const path of tabs.paths) {
    const isActive = path === state.currentPath;
    if (isActive ? activeFileUnsaved : (tabDocs.get(path) || {}).unsaved) dirty.add(path);
  }
  tabBar.render({ paths: tabs.paths, active: tabs.active, labels: tabLabels(tabs.paths), dirty });
  // Landscape mobile hides the tab strip when only one file is open (saves a row).
  document.body.classList.toggle('mobile-single-tab', (tabs.paths || []).length <= 1);
}

/** A commit for `path` landed (maybe in the background, for a tab the user already left). */
function noteCommit(path, sha) {
  const tab = tabDocs.get(path);
  if (tab) {
    if (sha) tab.sha = sha;
    tab.commitSeen = true;
    if (state.currentPath !== path && tab.unsaved) {
      tab.unsaved = false;
      renderTabs();
    }
  }
  // Single-file Save / autosave also clears multi-file dirty tracking for this path
  if (path && workingTree) {
    workingTree.clear(path);
    ensureCommitHistoryUI().refreshBadge();
    if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());
  }
}

/**
 * Brings the toolbar back in line with the file that is REALLY open, after an
 * open that was started but did not happen (network error, not valid UTF-8).
 */
function restoreChrome() {
  const path = state.currentPath;
  els.currentFileLabel.textContent = path || 'No file selected';
  els.btnSave.disabled = !path;
  els.btnExportPdf.disabled = !path;
  els.btnDelete.disabled = !path;
  if (path) fileTree.setActive(path);
  else fileTree.clearActive();
}

/**
 * Shows the empty-state card when no file is open and hides the editor chrome
 * (toolbar, find bar, draft banner, editor body) in one place; does the inverse
 * when a file IS open.
 *
 * The tab bar hides itself via renderTabs() when there are 0 tabs, so it is not
 * touched here. The find bar and draft banner are on-demand panels — they are
 * only ever force-HIDDEN while the empty state is up, never force-shown, so a
 * stray Find bar or a pending-draft banner cannot be resurrected next to the
 * card. openFile() shows the draft banner itself when there is a draft to offer.
 */
function renderEmptyState() {
  if (!els.emptyState) return;
  const hasFile = !!state.currentPath;
  els.emptyState.classList.toggle('hidden', hasFile);

  // Always-on chrome: visible with a file, hidden without.
  for (const sel of ['.editor-toolbar', '.editor-body']) {
    const node = document.querySelector(sel);
    if (node) node.classList.toggle('hidden', !hasFile);
  }

  // On-demand chrome: only force-hide while empty; leave their own state intact
  // when a file is open.
  if (!hasFile) {
    for (const id of ['find-bar', 'draft-banner']) {
      const node = document.getElementById(id);
      if (node) node.classList.add('hidden');
    }
  }
}

/** Shows a tab's document. swapDoc fires no 'change', but guard anyway. */
function showDocInEditor(doc) {
  suppressEditorChange = true;
  try {
    editorHandle.showDoc(doc);
  } finally {
    suppressEditorChange = false;
  }
}

/** Tabs are restored once per session, from the first tree that loads. */
function restoreTabsOnce(files) {
  if (tabsRestored) return;
  tabsRestored = true;
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(tabsKey()) || 'null');
  } catch (_) { /* corrupt entry: start with no tabs */ }
  const known = new Set(files.map((f) => f.path));
  const restored = TabsModel.fromJSON(saved, (path) => known.has(path));
  if (restored.size === 0) return;

  // Anything the user opened while the tree was still loading is kept, in front.
  for (const path of restored.paths) tabs.open(path);
  persistTabs();
  renderTabs();
  // Only one tab is fetched now; the others load when first clicked. When the file
  // that was active has since disappeared, the first remaining tab takes its place
  // rather than leaving tabs on screen next to an empty editor.
  const toOpen = restored.active || restored.paths[0];
  if (!state.currentPath && toOpen) openFile(toOpen);
}


/** If IndexedDB still has a dirty draft for path and the banner is hidden, show it. */
async function resurfaceDraftBanner(path) {
  if (!path || !draftStore || !els.draftBanner) return;
  if (!els.draftBanner.classList.contains('hidden')) return;
  try {
    await draftStoreReady;
    const draft = await draftStore.get({
      owner: state.client.owner,
      repo: state.client.repo,
      branch: state.branch,
      path,
    });
    if (!draft || draft.dirty === false) return;
    const remoteSha = state.currentSha;
    const remoteText = editorHandle ? editorHandle.easyMDE.value() : '';
    const stillDiffers = draft.baseSha !== remoteSha || draft.text !== remoteText;
    if (!stillDiffers) return;
    pendingDraft = draft.text;
    showDraftBanner(
      `You have unsaved local changes from ${formatAge(Date.now() - (draft.savedAt || Date.now()))}.`,
      'draft'
    );
  } catch (_) { /* ignore */ }
}

// ====================== OPEN / SAVE ======================
/**
 * Opens a file in its tab (creating the tab if needed) and makes it active.
 *
 * Switching away commits what is pending in the old tab exactly as it always did
 * (draft written at once, commit in the background). A tab that was clean when
 * left comes back instantly from its cached document; one that was not is reloaded
 * from GitHub and the draft banner offers the local text, because only GitHub plus
 * the draft store know what the truth is after a background commit.
 *
 * `reload: true` is for callers that know the cached copy is wrong (rename, move,
 * links rewritten) and for the active file, which is otherwise not re-opened.
 */
async function openFile(path, { reload = false } = {}) {
  // Clicking the file or tab that is already on screen must not throw away its
  // undo history and cursor by re-fetching it.
  if (!reload && state.currentPath === path && tabDocs.has(path)) {
    editorHandle.easyMDE.codemirror.focus();
    // Tabs restore / second click must still surface a pending local draft
    void resurfaceDraftBanner(path);
    if (isMobileShell()) setMobileSidebarOpen(false);
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
  // Unsaved tabs MUST use the cached doc (hybrid autosave). Refetching would
  // replace in-memory edits with the remote blob and look like data loss.
  const useCache = !reload && !!cached && !!cached.doc && !cached.stale;

  els.btnSave.disabled = true;
  els.btnExportPdf.disabled = true;
  els.btnDelete.disabled = true;
  els.currentFileLabel.textContent = path;
  fileTree.setActive(path);
  if (!useCache) setSaveStatus('Loading...', false);

  try {
    let remoteText;
    let sha;
    if (useCache) {
      remoteText = cached.doc.getValue();
      sha = cached.sha;
    } else {
      const fetched = await state.client.getFileB64(path);
      if (seq !== openSeq) return; // a newer open won the race
      sha = fetched.sha;
      try {
        remoteText = b64ToUtf8(fetched.b64);
      } catch (_) {
        // b64ToUtf8 THROWS on content that is not valid UTF-8, by design — a
        // binary blob wearing a .md extension. Refuse it instead of opening
        // replacement characters the user might then commit back to GitHub.
        setSaveStatus(`Cannot open ${path}: the file is not valid UTF-8`, true);
        restoreChrome();
        return;
      }
    }

    // The old tab stays editable while the new file loads. Whatever was typed in
    // it in the meantime has to be committed too, and only now do we know whether
    // GitHub already has everything.
    if (switching) {
      const leavingUnsaved = activeFileUnsaved || (autosave ? autosave.hasUnsavedDraft() : false);
      if (autosave && autosave.hasUnsavedDraft()) {
        if (leavingTab) leavingTab.commitSeen = false;
        await autosave.flushCurrentFile();
        if (seq !== openSeq) return;
      }
      if (leavingTab) leavingTab.unsaved = leavingUnsaved && !leavingTab.commitSeen;
    }

    hideDraftBanner();
    setAutosaveStatus(null);
    state.currentPath = path;
    if (isMobileShell()) setMobileSidebarOpen(false);
    state.currentSha = sha;
    // A file is now open: hide the empty-state card and show the editor chrome.
    // Both success paths (opening from cache, opening fresh) converge here.
    renderEmptyState();
    ensureAutosave();
    try { await draftStoreReady; } catch (_) { /* degraded store */ }
    const opened = await ensureAutosave().onOpen(path, remoteText, sha);
    if (seq !== openSeq) return; // another open won the race

    // Returning to a dirty cached tab: onOpen treated the in-memory text as
    // "remote" and left state CLEAN. Re-arm dirty so Save / Commit still work.
    if (useCache && cached && cached.unsaved && autosave && !opened.hasDraft) {
      autosave.onChange(remoteText);
    }

    let doc;
    if (useCache) {
      doc = cached.doc;
      cached.sha = sha;
      // Keep cached.unsaved — hybrid model leaves dirty tabs dirty until Save/Commit.
      cached.commitSeen = false;
    } else {
      doc = editorHandle.createDoc(opened.text);
      // A reload keeps the reader where they were (CodeMirror clips the cursor
      // if the text got shorter).
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

    els.btnSave.disabled = false;
    const kind = kindFromPath(path);
    els.btnExportPdf.disabled = !(kind.kind === 'markdown' || kind.kind === 'html');
    els.btnDelete.disabled = false;
    updateLangBadge(kind);
    if (editorHandle && typeof editorHandle.setLanguage === 'function') {
      editorHandle.setLanguage(kind.mode);
    }
    if (editorHandle && typeof editorHandle.setToolbarForKind === 'function') {
      editorHandle.setToolbarForKind(kind);
    }
    // Do NOT call applyLayoutMode here — it would toggle away EasyMDE's toolbar
    // Preview / side-by-side that the user (or e2e) turned on. showDoc already
    // re-renders the active preview pane for the new document.
    if (editorHandle && typeof editorHandle.renderActivePreview === 'function') {
      editorHandle.renderActivePreview();
    }
    if (els.docOutline && !els.docOutline.classList.contains('hidden')) {
      renderDocOutline();
    }
    if (els.minimapWrap && !els.minimapWrap.classList.contains('hidden')) {
      ensureMinimap();
    }
    setSaveStatus('Ready', false);

    if (opened.hasDraft) {
      // No automatic merge — the user picks which version is the real one.
      pendingDraft = opened.draftText;
      showDraftBanner(
        `You have unsaved local changes from ${formatAge(Date.now() - opened.draftSavedAt)}.`,
        'draft'
      );
    }
  } catch (e) {
    setSaveStatus('Error: ' + e.message, true);
    restoreChrome();
  }
}

/** Closes a tab. The active one hands over to its neighbour, or leaves an empty editor. */
async function closeTab(path) {
  if (!tabs.has(path)) return;
  const wasActive = state.currentPath === path;
  // Same promise as switching away: the text is on disk before the tab goes, and
  // the commit continues in the background. Nothing is ever lost by closing.
  if (wasActive && autosave) await autosave.flushCurrentFile();

  const { next } = tabs.close(path);
  tabDocs.delete(path);
  persistTabs();
  renderTabs();
  if (!wasActive) return;

  if (next) await openFile(next);
  else closeCurrentFile({ flush: false });
}

/**
 * These files no longer exist (deleted here). Their tabs go too; when the active
 * one is among them the editor shows the neighbouring tab, or nothing.
 * No flush: committing to a path that was just deleted is pointless.
 */
async function dropTabs(paths) {
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
  closeCurrentFile({ flush: false });
  if (tabs.active) await openFile(tabs.active);
  renderEmptyState();
}

/** A tab's cached document no longer matches GitHub; it is re-fetched next time it is shown. */
function markStale(paths) {
  for (const path of paths) {
    const tab = tabDocs.get(path);
    if (tab) tab.stale = true;
  }
}

/** Re-keys a tab's cached state after its file was renamed or moved (it is stale by definition). */
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

async function onSaveFile() {
  // Explicit Save: commit right now, ignore the timers. Same escape hatch as
  // before for "I know I want this on GitHub now" — it is simply no longer the
  // ONLY way to save.
  if (!state.currentPath) return;
  await ensureAutosave().saveNow();
}
// After deletion (or when the last tab is closed) the editor must not keep the
// file's contents: show an empty document, drop inline images, lock actions.
// Tabs are the CALLER's business (dropTabs / closeTab) — this only resets the editor.
function closeCurrentFile({ flush = true } = {}) {
  if (autosave && state.currentPath) {
    // Any draft of this file is written and committed before we let go of it
    // (not when the file itself was just deleted — there is nothing to commit to)...
    if (flush) autosave.flushCurrentFile();
    // ...and the instance lets go of the file but is NOT destroyed: a commit that
    // is still in flight must finish and delete its own draft, which a destroyed
    // instance skips. release() cancels every timer and ignores typing until the
    // next onOpen().
    autosave.release();
  }
  hideDraftBanner();
  setAutosaveStatus(null);
  state.currentPath = null;
  state.currentSha = null;
  els.currentFileLabel.textContent = 'No file selected';
  fileTree.clearActive();
  showDocInEditor(editorHandle.createDoc(''));
  els.btnSave.disabled = true;
  els.btnExportPdf.disabled = true;
  els.btnDelete.disabled = true;
  // No file is open now: swap the (emptied) editor for the empty-state card.
  renderEmptyState();
}
async function onExportPdf() {
  els.btnExportPdf.disabled = true;
  try {
    await exportCurrentPageToPdf({
      getCurrentPath: () => state.currentPath,
      getMarkdownText: () => editorHandle.easyMDE.value(),
      marked: window.marked,
      imageResolver,
      onStatus: setSaveStatus,
    });
  } finally {
    els.btnExportPdf.disabled = false;
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}



function updateLangBadge(kind) {
  if (!els.langBadge) return;
  if (!kind) {
    els.langBadge.textContent = '—';
    els.langBadge.title = 'Language';
    return;
  }
  els.langBadge.textContent = kind.label;
  els.langBadge.title = `Language: ${kind.label} (${kind.ext || 'no ext'})`;
}

/** Escape for HTML text content */
function escapePreview(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fill Live/Preview pane according to file kind:
 *  markdown → marked (EasyMDE previewRender)
 *  html     → sandboxed iframe
 *  code     → highlighted <pre><code>
 */
function fillPreviewPane(node, plain, kind) {
  if (!node) return;
  const preview = kind && kind.preview ? kind.preview : 'markdown';
  if (preview === 'html') {
    // Single funnel: delegate to the editor's serial HTML renderer instead of
    // building a second iframe here. Parallel triggers (EasyMDE 'update' +
    // forceLayout) queue there; none wipes the pane, so no through-one blanks.
    if (editorHandle && typeof editorHandle.renderHtmlPreview === 'function') {
      editorHandle.renderHtmlPreview(node, plain);
    } else {
      // Fallback for tests / early init before the editor handle exists.
      let iframe = node.querySelector('iframe.html-preview-frame');
      if (!iframe) {
        node.innerHTML = '';
        iframe = document.createElement('iframe');
        iframe.className = 'html-preview-frame';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
        iframe.setAttribute('title', 'HTML preview');
        node.appendChild(iframe);
      }
      iframe.srcdoc = plain || '<!-- empty -->';
      // This pane had no editor handle yet — drop any stale handshake height
      // from an earlier document; the frame grows to its content on its own.
      iframe.style.removeProperty('height');
      const path = state.currentPath;
      const resolver = imageResolver;
      buildHtmlSrcdoc(plain || '', path, resolver)
        .then((srcdoc) => {
          if (iframe.isConnected) iframe.srcdoc = srcdoc;
        })
        .catch((e) => { console.error('HTML preview resolve failed:', e); });
    }
    return;
  }
  if (preview === 'code') {
    const lang = (kind && kind.ext) || 'txt';
    let body = escapePreview(plain || '');
    let html = `<pre class="code-preview"><code class="language-${escapePreview(lang)}">${body}</code></pre>`;
    node.innerHTML = html;
    try {
      if (typeof globalThis.hljs !== 'undefined') {
        const block = node.querySelector('code');
        if (block) globalThis.hljs.highlightElement(block);
      }
    } catch (_) { /* optional */ }
    return;
  }
  // markdown (default)
  // NOTE: previewRender returns null for HTML (async funnel owns the pane),
  // EasyMDE itself skips `innerHTML` on null — we must do the same here, or
  // our own wipe reintroduces the through-one blank from the other direction.
  if (editorHandle && editorHandle.easyMDE && editorHandle.easyMDE.options.previewRender) {
    const html = editorHandle.easyMDE.options.previewRender(plain, node);
    if (html === null) return;
    if (html != null) node.innerHTML = html;
  }
}


function setupMoreFileMenu() {
  if (!els.btnMoreFile || els.btnMoreFile.dataset.bound) return;
  els.btnMoreFile.dataset.bound = '1';
  const close = () => {
    if (els.moreFileMenu) els.moreFileMenu.classList.add('hidden');
    els.btnMoreFile.setAttribute('aria-expanded', 'false');
  };
  els.btnMoreFile.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!els.moreFileMenu) return;
    const willOpen = els.moreFileMenu.classList.contains('hidden');
    if (willOpen) {
      els.moreFileMenu.classList.remove('hidden');
      els.btnMoreFile.setAttribute('aria-expanded', 'true');
    } else {
      close();
    }
  });
  document.addEventListener('click', (e) => {
    if (!els.moreFileMenu || els.moreFileMenu.classList.contains('hidden')) return;
    if (els.btnMoreFile.contains(e.target) || els.moreFileMenu.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  // Close after choosing an action
  if (els.moreFileMenu) {
    els.moreFileMenu.addEventListener('click', (e) => {
      if (e.target.closest('button')) close();
    });
  }
}

function setupFindBar() {
  if (!els.findBar || els.findBar.dataset.bound) return;
  els.findBar.dataset.bound = '1';

  const runFind = (backwards) => {
    if (!editorHandle) return;
    const q = els.findInput ? els.findInput.value : '';
    const count = editorHandle.findInFile(q, { backwards: !!backwards });
    if (els.findCount) {
      els.findCount.textContent = q ? (count ? `${count} found` : 'no matches') : '';
    }
  };

  const openFind = () => {
    if (!els.findBar) return;
    els.findBar.classList.remove('hidden');
    if (els.findInput) {
      els.findInput.focus();
      els.findInput.select();
    }
  };
  const closeFind = () => {
    if (!els.findBar) return;
    els.findBar.classList.add('hidden');
    if (els.findCount) els.findCount.textContent = '';
    if (editorHandle) editorHandle.easyMDE.codemirror.focus();
  };

  if (els.btnFind) els.btnFind.addEventListener('click', openFind);
  if (els.findNext) els.findNext.addEventListener('click', () => runFind(false));
  if (els.findPrev) els.findPrev.addEventListener('click', () => runFind(true));
  if (els.findClose) els.findClose.addEventListener('click', closeFind);

  if (els.findReplace) {
    els.findReplace.addEventListener('click', () => {
      if (!editorHandle) return;
      const q = els.findInput ? els.findInput.value : '';
      const r = els.replaceInput ? els.replaceInput.value : '';
      const count = editorHandle.replaceInFile(q, r);
      if (els.findCount) {
        els.findCount.textContent = q ? (count ? `${count} left` : 'done') : '';
      }
    });
  }
  if (els.findReplaceAll) {
    els.findReplaceAll.addEventListener('click', () => {
      if (!editorHandle) return;
      const q = els.findInput ? els.findInput.value : '';
      const r = els.replaceInput ? els.replaceInput.value : '';
      const n = editorHandle.replaceAllInFile(q, r);
      if (els.findCount) {
        els.findCount.textContent = n ? `replaced ${n}` : (q ? 'no matches' : '');
      }
    });
  }

  if (els.findInput) {
    els.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFind(!!e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });
  }
  if (els.replaceInput) {
    els.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (els.findReplace) els.findReplace.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });
  }

  if (els.btnWrap) {
    els.btnWrap.addEventListener('click', () => {
      if (!editorHandle) return;
      const on = editorHandle.toggleLineWrapping();
      els.btnWrap.classList.toggle('active-panel', on);
    });
  }
  if (els.btnFold) {
    els.btnFold.addEventListener('click', () => {
      if (!editorHandle) return;
      const on = editorHandle.toggleHeadingFolds();
      els.btnFold.classList.toggle('active-panel', on);
    });
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (els.appMain && els.appMain.classList.contains('hidden')) return;
    if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind();
    }
    if (mod && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      openFind();
      if (els.replaceInput) els.replaceInput.focus();
    }
  });
}



let outlineRefreshTimer = 0;
let outlineCursorBound = false;

function getPreviewScroller() {
  const root = document.querySelector('.editor-area .EasyMDEContainer')
    || document.querySelector('.EasyMDEContainer');
  if (!root) return null;
  const pane = root.querySelector('.editor-preview-side, .editor-preview-active-side, .editor-preview-active, .editor-preview');
  return (pane && pane.isConnected) ? pane : null;
}

/** Jump to a heading: scroll the CodeMirror pane AND the preview pane (when visible). */
function jumpToOutlineHeading(line) {
  if (!editorHandle) return;
  const cm = editorHandle.easyMDE.codemirror;
  // A folded section (Fold button) hides its lines inside a collapsed mark:
  // clearOnEnter only unfolds when the CURSOR enters, and the cursor is still
  // on the old line — so unfold explicitly, or setCursor lands in hidden text.
  try {
    if (editorHandle.unfoldAtLine) editorHandle.unfoldAtLine(line);
    else if (typeof cm.foldCode === 'function') cm.foldCode({ line, ch: 0 }, { rangeFinder: null });
  } catch (_) { /* fold addon may be absent */ }
  try { cm.setCursor({ line, ch: 0 }); } catch (_) { /* ignore */ }
  // Source/Live: CodeMirror is the visible scroller.
  try { cm.scrollIntoView({ line, ch: 0 }, 80); } catch (_) { /* ignore */ }
  // Live/Preview: .editor-preview-side is scrollable too — move the Nth
  // rendered heading into view. Index lookup (not text matching) survives
  // duplicate titles; the fractional fallback covers async render races.
  try {
    const pane = getPreviewScroller();
    if (pane && pane.clientHeight > 0 && pane.scrollHeight > pane.clientHeight + 4) {
      const heads = pane.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const lineCount = Math.max(1, cm.lineCount());
      const idx = outlineHeadingIndex(line);
      if (idx >= 0 && heads && heads[idx] && typeof heads[idx].scrollIntoView === 'function') {
        heads[idx].scrollIntoView({ block: 'start' });
      } else {
        const frac = Math.min(1, Math.max(0, line / lineCount));
        pane.scrollTop = frac * Math.max(0, pane.scrollHeight - pane.clientHeight);
      }
    }
  } catch (_) { /* preview may be absent/hidden */ }
  // Preview hides CodeMirror (display:none) — focusing it steals nothing and
  // scrolls nothing; only focus when the editor is actually visible.
  try {
    const hidden = layoutMode === 'preview';
    if (!hidden) cm.focus();
  } catch (_) { /* ignore */ }
  markActiveOutlineItem(line);
}

/** Order index of the outline item covering `line` (for preview heading lookup). */
function outlineHeadingIndex(line) {
  if (!els.docOutline) return -1;
  const btns = els.docOutline.querySelectorAll('.outline-item[data-line]');
  for (let i = 0; i < btns.length; i++) {
    if (Number(btns[i].dataset.line) === line) return i;
  }
  return -1;
}

function markActiveOutlineItem(line) {
  if (!els.docOutline) return;
  const btns = els.docOutline.querySelectorAll('.outline-item');
  btns.forEach((b) => b.classList.toggle('active', Number(b.dataset.line) === line));
}

/** Highlight the outline item closest above the cursor (scroll-spy). */
function syncActiveOutlineItem() {
  if (!els.docOutline || !editorHandle) return;
  if (els.docOutline.classList.contains('hidden')) return;
  const btns = els.docOutline.querySelectorAll('.outline-item[data-line]');
  if (!btns.length) return;
  let cur = 0;
  try { cur = editorHandle.easyMDE.codemirror.getCursor().line; } catch (_) { /* ignore */ }
  let best = btns[0];
  for (const b of btns) {
    if (Number(b.dataset.line) <= cur) best = b;
    else break;
  }
  btns.forEach((b) => b.classList.toggle('active', b === best));
}

/** Debounced outline rebuild for typing (keystroke-cheap, render-expensive). */
function scheduleOutlineRefresh() {
  if (els.docOutline && !els.docOutline.classList.contains('hidden')) {
    clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = setTimeout(() => { renderDocOutline(); }, 400);
  }
  scheduleBacklinksRefresh();
}

function renderDocOutline() {
  if (!els.docOutline || !editorHandle) return;
  const text = editorHandle.easyMDE.value();
  const items = parseHeadingOutline(text);
  els.docOutline.innerHTML = '';
  if (!items.length) {
    els.docOutline.innerHTML = '<div class="outline-empty">No headings</div>';
    return;
  }
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'outline-item level-' + it.level;
    btn.textContent = it.text;
    btn.title = 'Line ' + (it.line + 1);
    btn.dataset.line = String(it.line);
    btn.addEventListener('click', () => jumpToOutlineHeading(it.line));
    els.docOutline.appendChild(btn);
  }
  syncActiveOutlineItem();
}


/** @type {{ refresh: () => void, destroy: () => void }|null} */
let minimapHandle = null;

function destroyMinimap() {
  if (minimapHandle) {
    try { minimapHandle.destroy(); } catch (_) {}
    minimapHandle = null;
  }
}

function ensureMinimap() {
  if (!editorHandle || !els.minimapCanvas) return;
  destroyMinimap();
  minimapHandle = createMinimap(editorHandle.easyMDE.codemirror, els.minimapCanvas, {
    // Visible preview pane (Source/Live keep following CodeMirror instead).
    getPreviewEl: () => document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side')
      || document.querySelector('.editor-preview-side'),
    isPreviewActive: () => layoutMode === 'preview',
  });
}

function setupMinimap() {
  if (!els.btnMinimap || els.btnMinimap.dataset.bound) return;
  els.btnMinimap.dataset.bound = '1';
  // Restore preference
  const pref = localStorage.getItem('md_minimap');
  if (pref === '1' && els.minimapWrap) {
    els.minimapWrap.classList.remove('hidden');
    els.btnMinimap.classList.add('active-panel');
  }
  els.btnMinimap.addEventListener('click', () => {
    if (!els.minimapWrap) return;
    const open = els.minimapWrap.classList.toggle('hidden') === false;
    els.btnMinimap.classList.toggle('active-panel', open);
    localStorage.setItem('md_minimap', open ? '1' : '0');
    if (open) {
      ensureMinimap();
      requestAnimationFrame(() => {
        if (minimapHandle) minimapHandle.refresh();
        if (editorHandle) editorHandle.refreshLayout();
      });
    } else {
      destroyMinimap();
      if (editorHandle) editorHandle.refreshLayout();
    }
  });
}


/** Phone shell: files drawer + close after open. Desktop unchanged. */
function isMobileShell() {
  try {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  } catch (_) {
    return false;
  }
}
function setMobileSidebarOpen(open) {
  document.body.classList.toggle('mobile-sidebar-open', !!open);
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.classList.toggle('hidden', !open);
    els.sidebarBackdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (els.btnMobileFiles) {
    els.btnMobileFiles.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

/** Read mode: tap the preview canvas (not a link) → jump to Source to edit. */
function setupMobilePreviewTap() {
  if (document.documentElement.dataset.mobilePreviewTap) return;
  document.documentElement.dataset.mobilePreviewTap = '1';
  document.addEventListener('click', (e) => {
    try {
      if (!isMobileShell()) return;
      if (layoutMode !== 'preview') return;
      // Keep real navigation / controls working.
      if (e.target.closest('a, button, input, textarea, select, label, .sidebar, header, .editor-toolbar, #find-bar, #draft-banner')) return;
      const pane = e.target.closest('.editor-preview-side, .editor-preview, .editor-preview-active-side');
      if (!pane) return;
      e.preventDefault();
      applyLayoutMode('source');
      requestAnimationFrame(() => {
        try {
          if (editorHandle && editorHandle.easyMDE) {
            editorHandle.easyMDE.codemirror.focus();
          }
        } catch (_) {}
      });
    } catch (_) { /* ignore */ }
  }, true);
}

function setupMobileShell() {
  if (els.btnMobileFiles) {
    els.btnMobileFiles.addEventListener('click', () => {
      setMobileSidebarOpen(!document.body.classList.contains('mobile-sidebar-open'));
    });
  }
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.addEventListener('click', () => setMobileSidebarOpen(false));
  }
  if (els.btnMobileFmt) {
    els.btnMobileFmt.addEventListener('click', () => {
      const open = !document.body.classList.contains('mobile-fmt-open');
      document.body.classList.toggle('mobile-fmt-open', open);
      els.btnMobileFmt.setAttribute('aria-expanded', open ? 'true' : 'false');
      els.btnMobileFmt.title = open ? 'Hide formatting tools' : 'Show formatting tools';
    });
  }
  // Escape closes the files drawer (and the fmt strip if open)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('mobile-sidebar-open')) {
      setMobileSidebarOpen(false);
    }
    if (document.body.classList.contains('mobile-fmt-open')) {
      document.body.classList.remove('mobile-fmt-open');
      if (els.btnMobileFmt) {
        els.btnMobileFmt.setAttribute('aria-expanded', 'false');
        els.btnMobileFmt.title = 'Show formatting tools';
      }
    }
  });

  // After rotate, 100vh / CodeMirror metrics are often stale → no vertical scroll.
  let viewportTimer = null;
  const syncViewport = () => {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      if (h > 0) {
        document.documentElement.style.setProperty('--app-height', h + 'px');
        document.body.style.height = h + 'px';
        document.body.style.maxHeight = h + 'px';
      }
      try {
        if (editorHandle && typeof editorHandle.refreshLayout === 'function') {
          editorHandle.refreshLayout();
        }
      } catch (_) { /* editor not ready */ }
      try {
        if (minimapHandle && typeof minimapHandle.refresh === 'function') {
          minimapHandle.refresh();
        }
      } catch (_) { /* no minimap */ }
    }, 120);
  };
  window.addEventListener('orientationchange', syncViewport);
  window.addEventListener('resize', syncViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
  }
  syncViewport();
  setupMobilePreviewTap();
  if (els.autosaveStatus && !els.autosaveStatus.dataset.forceSaveBound) {
    els.autosaveStatus.dataset.forceSaveBound = '1';
    els.autosaveStatus.title = 'Sync status — tap to save now';
    els.autosaveStatus.style.cursor = 'pointer';
    els.autosaveStatus.addEventListener('click', () => {
      try {
        if (autosave && typeof autosave.saveNow === 'function') autosave.saveNow();
        else if (els.btnSave && !els.btnSave.disabled) els.btnSave.click();
      } catch (_) {}
    });
  }
}


function scheduleBacklinksRefresh() {
  clearTimeout(backlinksRefreshTimer);
  backlinksRefreshTimer = setTimeout(() => {
    try {
      if (state.currentPath && editorHandle) {
        const text = editorHandle.easyMDE ? editorHandle.easyMDE.value() : '';
        backlinkIndex.setFile(state.currentPath, text);
      }
    } catch (_) {}
    renderBacklinksPanel();
  }, 500);
}

function renderBacklinksPanel() {
  if (!els.backlinksPanel || els.backlinksPanel.classList.contains('hidden')) return;
  const path = state.currentPath;
  els.backlinksPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'backlinks-heading';
  if (!path) {
    head.textContent = 'Backlinks';
    els.backlinksPanel.appendChild(head);
    const empty = document.createElement('div');
    empty.className = 'backlinks-empty';
    empty.textContent = 'Open a note to see what links here.';
    els.backlinksPanel.appendChild(empty);
    return;
  }
  const sources = backlinkIndex.getBacklinks(path);
  head.textContent = sources.length ? `Backlinks (${sources.length})` : 'Backlinks';
  els.backlinksPanel.appendChild(head);
  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'backlinks-empty';
    empty.textContent = 'No other notes link here yet.';
    els.backlinksPanel.appendChild(empty);
    return;
  }
  for (const src of sources) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'backlink-item';
    const base = src.split('/').pop() || src;
    btn.innerHTML = '';
    const title = document.createElement('span');
    title.textContent = base.replace(/\.md$/i, '');
    btn.appendChild(title);
    if (src.includes('/')) {
      const sub = document.createElement('span');
      sub.className = 'bl-path';
      sub.textContent = src;
      btn.appendChild(sub);
    }
    btn.title = src;
    btn.addEventListener('click', () => openFile(src));
    els.backlinksPanel.appendChild(btn);
  }
}


async function ensureBacklinksPopulated() {
  if (!backlinkIndex || backlinkIndex.size > 0) return;
  if (!searchSync || !searchSync.index) return;
  // Only use bodies already in memory (search sync / open files).
  // Never fan-out hundreds of getFileB64 calls here — that froze mobile after login.
  try {
    const cache = searchSync.index.bodyCache;
    if (cache && typeof cache.forEach === 'function') {
      cache.forEach((path, body) => {
        try { backlinkIndex.setFile(path, body); } catch (__) {}
      });
    }
  } catch (_) {}
  renderBacklinksPanel();
}

function setupBacklinks() {
  if (!els.btnBacklinks || els.btnBacklinks.dataset.bound) return;
  els.btnBacklinks.dataset.bound = '1';
  // Do not auto-open on boot — panel work must stay opt-in after login.
  els.btnBacklinks.addEventListener('click', () => {
    if (!els.backlinksPanel) return;
    const open = els.backlinksPanel.classList.toggle('hidden') === false;
    els.btnBacklinks.classList.toggle('active-panel', open);
    localStorage.setItem('md_backlinks', open ? '1' : '0');
    if (open) {
      void ensureBacklinksPopulated().then(() => renderBacklinksPanel());
      renderBacklinksPanel();
    }
    if (editorHandle) editorHandle.refreshLayout();
  });
}

function setupDocOutline() {
  if (!els.btnOutline || els.btnOutline.dataset.bound) return;
  els.btnOutline.dataset.bound = '1';
  els.btnOutline.addEventListener('click', () => {
    if (!els.docOutline) return;
    const open = els.docOutline.classList.toggle('hidden') === false;
    els.btnOutline.classList.toggle('active-panel', open);
    if (open) renderDocOutline();
  });
  // Scroll-spy: highlight the heading above the cursor. Bound once — the
  // CodeMirror instance is stable for the session (tabs swap Docs, not editors).
  if (!outlineCursorBound && editorHandle) {
    outlineCursorBound = true;
    try {
      editorHandle.easyMDE.codemirror.on('cursorActivity', () => syncActiveOutlineItem());
    } catch (_) { /* ignore */ }
  }
}


// ====================== HYBRID LAYOUT + COMMIT / HISTORY ======================

function applyLayoutMode(mode) {
  layoutMode = mode;
  localStorage.setItem('md_layout', mode);
  if (els.editorArea) {
    els.editorArea.classList.remove('mode-source', 'mode-split', 'mode-preview');
    els.editorArea.classList.add('mode-' + mode);
  }
  // EasyMDE fullscreen leaves .editor-area; body classes keep Preview/Live rules alive
  document.body.classList.remove('md-layout-source', 'md-layout-split', 'md-layout-preview');
  document.body.classList.add('md-layout-' + mode);
  if (els.layoutToggle) {
    els.layoutToggle.querySelectorAll('.layout-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }
  if (!editorHandle) return;
  const easyMDE = editorHandle.easyMDE;
  try {
    // One engine only: EasyMDE side-by-side (.editor-preview-side).
    // Live  = side-by-side on, CSS shows 50% | 50%
    // Preview = side-by-side on, CSS hides source and stretches preview to 100%
    // Source = side-by-side off
    // Never use togglePreview — that path left an empty pane.
    const sideOn = typeof easyMDE.isSideBySideActive === 'function' && easyMDE.isSideBySideActive();
    const prevOn = typeof easyMDE.isPreviewActive === 'function' && easyMDE.isPreviewActive();

    // Always leave full-preview mode if somehow active
    if (prevOn) easyMDE.togglePreview();

    if (mode === 'split' || mode === 'preview') {
      if (!sideOn) easyMDE.toggleSideBySide();
    } else {
      if (sideOn) easyMDE.toggleSideBySide();
    }
  } catch (_) { /* EasyMDE may not be ready */ }

  const forceLayout = () => {
    if (!editorHandle) return;
    try {
      editorHandle.refreshLayout();
      const cm = editorHandle.easyMDE && editorHandle.easyMDE.codemirror;
      if (cm) cm.refresh();
      // Side-by-side updates from CodeMirror 'update'; nudge a repaint by
      // re-rendering into .editor-preview-side when Live or Preview is on.
      if (layoutMode === 'split' || layoutMode === 'preview') {
          const root = document.querySelector('.editor-area .EasyMDEContainer');
          if (root && editorHandle.easyMDE) {
            const plain = editorHandle.easyMDE.value();
            const nodes = root.querySelectorAll('.editor-preview-side, .editor-preview-active-side');
            const kind = kindFromPath(state.currentPath || '');
            for (const node of nodes) {
              fillPreviewPane(node, plain, kind);
            }
          }
      }
    } catch (_) { /* ignore */ }
  };
  requestAnimationFrame(() => {
    forceLayout();
    requestAnimationFrame(forceLayout);
  });
  // The minimap follows CodeMirror in Source/Live but the visible preview pane
  // in Preview (hidden editor reads 0) — re-bind on every mode switch.
  if (minimapHandle) {
    try { minimapHandle.refresh(); } catch (_) {}
  }
}

function setupLayoutToggle() {
  if (!els.layoutToggle || els.layoutToggle.dataset.bound) return;
  els.layoutToggle.dataset.bound = '1';
  els.layoutToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.layout-btn');
    if (!btn) return;
    applyLayoutMode(btn.dataset.mode);
  });
}

