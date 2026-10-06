// app.js
// App assembly point. Holds minimal state and wires modules together.
// All business logic lives in separate modules (paths/markdown-tokens/reference-rewriter/
// file-mover/image-resolver) — only "wiring" and DOM event handlers here.

import { GitHubClient, utf8ToB64, b64ToUtf8 } from './github-client.js';
import { ImageResolver } from './image-resolver.js';
import { createEditor } from './editor.js';
import { FileTree } from './file-tree.js';
import { setupImageDropzone, pickImageFiles, uploadImage } from './upload.js';
import { setupFolderDropzone } from './folder-upload.js';
import { exportCurrentPageToPdf } from './pdf-export.js';
import { moveFile, renameFile } from './file-mover.js';
import { createFolder, renameFolder, deleteFolder, getFolders, isFolderEmpty } from './folder-manager.js';
import { basenameOf, dirnameOf } from './paths.js';
import { looksLikeGitHubUrl, parseGitHubOwnerRepo } from './github-repo-url.js';
import { SearchStore } from './search-store.js';
import { SearchSync } from './search-sync.js';
import { createSearchUI, formatAge } from './search-ui.js';
import { DraftStore } from './draft-store.js';
import { Autosave } from './autosave.js';
import { TabsModel, tabLabels, tabsStorageKey } from './tabs.js';
import { createTabBar } from './tabs-ui.js';

const els = {
  loginScreen: document.getElementById('login-screen'),
  loginStatus: document.getElementById('login-status'),
  inputOwner: document.getElementById('input-owner'),
  inputRepo: document.getElementById('input-repo'),
  btnLogin: document.getElementById('btn-login'),

  appHeader: document.getElementById('app-header'),
  appMain: document.getElementById('app-main'),
  repoLabel: document.getElementById('repo-label'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnLogout: document.getElementById('btn-logout'),

  fileTreeEl: document.getElementById('file-tree'),
  searchInput: document.getElementById('search-input'),
  searchStatus: document.getElementById('search-status'),
  searchResults: document.getElementById('search-results'),
  btnReindex: document.getElementById('btn-reindex'),
  folderDropzone: document.getElementById('folder-dropzone'),
  folderDropOverlay: document.getElementById('folder-dropzone-overlay'),
  btnNewFolder: document.getElementById('btn-new-folder'),
  btnNewFile: document.getElementById('btn-new-file'),

  tabBar: document.getElementById('tab-bar'),
  currentFileLabel: document.getElementById('current-file'),
  btnSave: document.getElementById('btn-save'),
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

  editorContainer: document.getElementById('editor-container'),
  editorTextarea: document.getElementById('editor'),
  dropOverlay: document.getElementById('editor-dropzone-overlay'),
  imageFileInput: document.getElementById('image-file-input'),
};

const state = {
  client: null,
  branch: '',
  currentPath: null,
  currentSha: null,
  allFiles: [], // [{path, sha}]
  // False until the first getTree() succeeds. Distinguishes "not loaded yet"
  // (skip the sync) from "loaded and genuinely empty" (must still sync).
  treeLoaded: false,
};

let imageResolver = null;
let fileTree = null;
let editorHandle = null;
let searchSync = null;
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
//   unsaved    we left the tab with something GitHub did not have yet. Such a tab
//              is reloaded from GitHub on return (the draft banner then offers the
//              local text) instead of trusting a cached document
//   stale      the file was renamed/moved or its links were rewritten, so the cached
//              document no longer matches GitHub
//   commitSeen a commit for this path landed since we started leaving it
// A path with no entry here is a tab that was restored but never opened yet.
let tabs = new TabsModel();
let tabBar = null;
const tabDocs = new Map();
// Whether the ACTIVE file differs from GitHub, derived from the autosave label.
let activeFileUnsaved = false;
// Bumped by every openFile(); a slower, older open compares against it and gives
// up instead of overwriting the editor with a file the user has moved on from.
let openSeq = 0;
// The persisted tab list is read once per session, on the first tree load.
let tabsRestored = false;

// ====================== LOGIN ======================
init();

async function init() {
  // Must be awaited, and must be allowed to end init() on its own: finishLogin()
  // calls showApp() itself. Reading the session while the token check is still
  // in flight would build the app TWICE when an OAuth callback lands on a tab
  // that still holds a session — two editors, two ResizeObservers, two paste
  // handlers, with the first one nobody can reach to tear down.
  if (await consumeOAuthRedirect()) return;

  const saved = readSession();
  if (saved) {
    state.client = new GitHubClient(saved);
    state.branch = saved.branch;
    showApp(saved.owner, saved.repo);
    loadTree();
  } else {
    restorePendingLoginFields();
  }

  els.btnLogin.onclick = onLoginClick;
  els.btnLogout.onclick = () => {
    // Defence in depth: logout reloads the page, which tears down every timer
    // anyway, but an autosave aimed at the old token should not outlive it.
    if (autosave) autosave.destroy();
    sessionStorage.clear();
    location.reload();
  };
  els.btnRefresh.onclick = () => loadTree();
  // Wrap in arrows: assigning the handler directly would hand it the click
  // event as `folderPath`, creating "[object PointerEvent]/name.md".
  els.btnNewFile.onclick = () => onCreateNewFile();
  els.btnNewFolder.onclick = () => onCreateNewFolder();
  els.btnSave.onclick = onSaveFile;
  els.btnExportPdf.onclick = onExportPdf;
  els.btnDelete.onclick = onDeleteFile;

  // Switching tabs is the natural checkpoint Google Docs uses too: commit a
  // dirty draft immediately instead of making the user wait out the 10s window.
  // beforeunload is NOT the place for this — a fetch started there is cancelled
  // by the browser, so all it can do is ask the user to confirm.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && autosave) autosave.onVisibilityChange(true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (!autosave || !autosave.hasUnsavedDraft()) return;
    // The draft is already in IndexedDB by now; this is only the courtesy
    // prompt users expect. Nothing is fetched here — it would not survive.
    e.preventDefault();
    e.returnValue = '';
  });
}

function readSession() {
  const token = sessionStorage.getItem('gh_token');
  const owner = sessionStorage.getItem('gh_owner');
  const repo = sessionStorage.getItem('gh_repo');
  const branch = sessionStorage.getItem('gh_branch');
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch };
}

function onLoginClick() {
  let owner = els.inputOwner.value.trim();
  let repo = els.inputRepo.value.trim();

  // Guard against pasting the full https://github.com/owner/repo link (e.g. from
  // the address bar) into either field — split it back into owner + repo, so the
  // API URL /repos/{owner}/{repo} stays valid.
  const parsed = parseGitHubOwnerRepo(owner) || parseGitHubOwnerRepo(repo);
  if (parsed) {
    owner = parsed.owner;
    repo = parsed.repo;
    els.inputOwner.value = owner; // write back so the user sees what will be used
    els.inputRepo.value = repo;
  } else if (looksLikeGitHubUrl(owner) || looksLikeGitHubUrl(repo)) {
    setLoginStatus('That looks like a GitHub link, but no repository in it. Enter just the names: owner and repository.', true);
    return;
  }

  if (!owner || !repo) {
    setLoginStatus('Fill in Owner and Repository', true);
    return;
  }

  // owner/repo don't travel through the GitHub OAuth round-trip — we store them
  // ourselves, in the same tab, and pick them back up after /auth/callback.
  sessionStorage.setItem('gh_pending_owner', owner);
  sessionStorage.setItem('gh_pending_repo', repo);

  setLoginStatus('Redirecting to GitHub...', false);
  location.href = '/auth/login';
}

/**
 * If we just returned from /auth/callback, the Worker appended the token to the
 * URL fragment (#gh_token=...). A fragment never goes to the server, so this is
 * a safe way to hand the token back to client-side JS. We pick it up,
 * immediately clean the address bar, and complete the same "login" that
 * onLoginClick used to do with a PAT.
 * @returns {Promise<boolean>} true when this callback finished the login itself
 *   (the app has been shown, so the caller must not build it a second time).
 */
async function consumeOAuthRedirect() {
  const hash = location.hash || '';
  const match = hash.match(/(?:^#|&)gh_token=([^&]+)/);
  if (!match) return false;

  const token = decodeURIComponent(match[1]);
  history.replaceState(null, '', location.pathname + location.search);

  const owner = sessionStorage.getItem('gh_pending_owner');
  const repo = sessionStorage.getItem('gh_pending_repo');
  sessionStorage.removeItem('gh_pending_owner');
  sessionStorage.removeItem('gh_pending_repo');

  if (!owner || !repo) {
    setLoginStatus('Login session lost (owner/repo). Please try again.', true);
    return false;
  }

  await finishLogin(token, owner, repo);
  return true;
}

function restorePendingLoginFields() {
  const owner = sessionStorage.getItem('gh_pending_owner');
  const repo = sessionStorage.getItem('gh_pending_repo');
  if (owner) els.inputOwner.value = owner;
  if (repo) els.inputRepo.value = repo;
}

async function finishLogin(token, owner, repo) {
  setLoginStatus('Checking access...', false);
  try {
    const client = new GitHubClient({ token, owner, repo });
    const repoInfo = await client.getRepoInfo();
    const branch = repoInfo.default_branch || 'main';

    sessionStorage.setItem('gh_token', token);
    sessionStorage.setItem('gh_owner', owner);
    sessionStorage.setItem('gh_repo', repo);
    sessionStorage.setItem('gh_branch', branch);

    state.client = client;
    state.branch = branch;
    showApp(owner, repo);
    loadTree();
  } catch (e) {
    setLoginStatus('Error: ' + e.message, true);
  }
}

function setLoginStatus(msg, isError) {
  els.loginStatus.textContent = msg;
  els.loginStatus.className = 'status ' + (isError ? 'err' : 'ok');
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
function createAutosave(owner, repo) {
  if (draftStore) draftStore.close();
  draftStore = new DraftStore({
    onDegrade: () => {
      // Crash recovery is GONE from now on, and the user should know that
      // rather than find out by losing work.
      setSaveStatus('Local drafts unavailable (browser storage is disabled) — closing the tab will lose unsaved text', true);
    },
  });
  draftStore.open().catch(() => { /* open() never rejects; it degrades */ });

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
    editorHandle.destroy();
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

  imageResolver = new ImageResolver(state.client);

  fileTree = new FileTree(els.fileTreeEl, {
    onOpenFile: openFile,
    onPreviewImage: previewImageFile,
    onMoveFile: onMoveFile,
    getActivePath: () => state.currentPath,
    onRenameFolder: onRenameFolder,
    onDeleteFolder: onDeleteFolder,
    onCreateFileIn,
    onCreateFolderIn,
    onRenameFile: onRenameFile,
    onDeleteFileAt: onDeleteFileAt,
  });

  editorHandle = createEditor(els.editorTextarea, {
    marked: window.marked,
    imageResolver,
    getCurrentPath: () => state.currentPath,
    onImageUploadRequest: () => els.imageFileInput.click(),
    // Every keystroke arms the autosave timers. `suppressEditorChange` is what
    // keeps a programmatic .value() (opening a file, reloading after a
    // conflict) from being mistaken for typing.
    onChange: (text) => {
      if (suppressEditorChange) return;
      ensureAutosave().onChange(text);
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
}

/** Draft banner buttons + the two "the user is leaving" hooks. */
function setupAutosaveUI(owner, repo) {
  autosave = createAutosave(owner, repo);

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
async function loadTree() {
  els.fileTreeEl.innerHTML = '<div class="tree-loading">Loading...</div>';
  try {
    const files = await state.client.getTree(state.branch);
    state.allFiles = files;
    state.treeLoaded = true;
    fileTree.setFiles(files);
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

async function onMoveFile(oldPath, targetFolder) {
  setSaveStatus(`Moving ${oldPath}...`, false);
  try {
    let result;
    try {
      result = await moveFile(state.client, state.allFiles, oldPath, targetFolder);
    } catch (e) {
      // A file with the same name is already in the target folder — replacing it is
      // destructive, so ask first instead of failing with a raw GitHub API error.
      if (e.code !== 'target-exists') throw e;
      const confirmed = confirm(
        `"${e.targetPath}" already exists.\n\nReplace it with "${oldPath}"? This cannot be undone.`
      );
      if (!confirmed) {
        setSaveStatus('Move cancelled', false);
        return;
      }
      result = await moveFile(state.client, state.allFiles, oldPath, targetFolder, { overwrite: true });
    }

    const { newPath, updatedFiles, skipped, overwritten } = result;
    if (skipped) {
      setSaveStatus(`${oldPath} is already in that folder`, false);
      return;
    }

    const wasCurrent = state.currentPath === oldPath;
    tabs.rename(oldPath, newPath);
    moveTabDoc(oldPath, newPath);
    markStale(updatedFiles); // links were rewritten in these files
    if (wasCurrent) {
      state.currentPath = newPath;
      els.currentFileLabel.textContent = newPath;
    }
    if (state.currentPath && (wasCurrent || updatedFiles.includes(state.currentPath))) {
      // Pull fresh contents/sha, and — for the moved file itself — rebind autosave
      // to the NEW path. Left bound to the old one, the next keystroke would try
      // to commit to a path that no longer exists.
      await openFile(state.currentPath, { reload: true });
    }
    persistTabs();
    renderTabs();

    imageResolver.invalidate(oldPath);
    await loadTree();
    setSaveStatus(
      `Moved: ${oldPath} → ${newPath}` +
        (overwritten ? ' (replaced the existing file)' : '') +
        (updatedFiles.length ? ` (updated links in ${updatedFiles.length} file(s))` : ''),
      false
    );
  } catch (e) {
    setSaveStatus('Move error: ' + e.message, true);
  }
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
}

/** A commit for `path` landed (maybe in the background, for a tab the user already left). */
function noteCommit(path, sha) {
  const tab = tabDocs.get(path);
  if (!tab) return;
  if (sha) tab.sha = sha;
  tab.commitSeen = true;
  if (state.currentPath !== path && tab.unsaved) {
    tab.unsaved = false;
    renderTabs();
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
  const useCache = !reload && !!cached && !!cached.doc && !cached.stale && !cached.unsaved;

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
    state.currentSha = sha;
    const opened = await ensureAutosave().onOpen(path, remoteText, sha);
    if (seq !== openSeq) return; // another open won the race

    let doc;
    if (useCache) {
      doc = cached.doc;
      cached.sha = sha;
      cached.unsaved = false;
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
    els.btnExportPdf.disabled = false;
    els.btnDelete.disabled = false;
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
  if (!activeGone) return;
  closeCurrentFile({ flush: false });
  if (tabs.active) await openFile(tabs.active);
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

// Deleting the active file. The GitHub API requires the sha of that same blob, so
// we take state.currentSha (it always matches the last known version of the file).
async function onDeleteFile() {
  const path = state.currentPath;
  if (!path) return;

  const confirmed = confirm(`Are you sure you want to delete this file?\n\n${path}\n\nThe file will be removed from the repository; this cannot be undone.`);
  if (!confirmed) return;

  els.btnDelete.disabled = true;
  els.btnSave.disabled = true;
  setSaveStatus('Deleting...', false);

  try {
    await state.client.deleteFile(path, state.currentSha, `Delete ${path}`);
    imageResolver.invalidate(path);
    await dropTabs([path]);
    await loadTree();
    setSaveStatus(`File deleted: ${path}`, false);
  } catch (e) {
    // The file is still in place — restore the buttons to a working state so you can
    // either retry or save the remaining edits.
    els.btnSave.disabled = false;
    els.btnDelete.disabled = false;
    setSaveStatus('Delete error: ' + e.message, true);
  }
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
}

/** Resolves a user-entered NAME into a full repo path inside folderPath ('' = root). */
function resolvePathIn(folderPath, name) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean) throw new Error('Name cannot be empty');
  if (clean === '.' || clean === '..') throw new Error(`"${clean}" is not a valid name`);
  // A name with slashes is accepted for backwards compatibility with the old
  // "type the full path" prompt, but it is always resolved from the repository root.
  const full = clean.includes('/') ? clean.replace(/^\/+|\/+$/g, '') : clean;
  return folderPath ? `${folderPath}/${full}` : full;
}

function targetFolderLabel(folderPath) {
  return folderPath ? `"${folderPath}"` : 'the repository root';
}

/** Coerces a "create here" target into a real folder path.
 *
 * The toolbar wires these handlers through `onclick`, and a click event can
 * reach here as `folderPath`. Returning '' (the repo root) for that would
 * silently drop the user's intent — the active folder is what they are looking
 * at, so fall back to it, exactly like the default parameter does for
 * `undefined`. Only an explicit empty string means the repo root. */
function toFolderPath(value) {
  if (typeof value === 'string') return value;
  return fileTree ? fileTree.getActiveFolder() : '';
}

/**
 * Creates a new .md file. folderPath defaults to the tree's active folder — the last
 * folder the user opened/expanded — so the file lands where they are looking.
 */
async function onCreateNewFile(folderPath = fileTree.getActiveFolder()) {
  folderPath = toFolderPath(folderPath);
  const name = prompt(`New file name (created in ${targetFolderLabel(folderPath)}):`, 'untitled.md');
  if (!name) return;

  let path;
  try {
    path = resolvePathIn(folderPath, name);
    if (!path.toLowerCase().endsWith('.md')) throw new Error('Path must end with .md');
    if (state.allFiles.some((f) => f.path === path)) throw new Error(`"${path}" already exists`);
  } catch (e) {
    alert(e.message);
    return;
  }

  try {
    setSaveStatus(`Creating ${path}...`, false);
    await state.client.putFile(path, utf8ToB64('# New file\n'), `Create ${path}`);
    await loadTree();
    fileTree.setActiveFolder(folderPath, { expand: true }); // reveal the new file
    await openFile(path);
    setSaveStatus(`File created: ${path}`, false);
  } catch (e) {
    setSaveStatus('Create error: ' + e.message, true);
  }
}

/** Creates a new folder (via .gitkeep) inside the active folder. */
async function onCreateNewFolder(folderPath = fileTree.getActiveFolder()) {
  folderPath = toFolderPath(folderPath);
  const name = prompt(`New folder name (created in ${targetFolderLabel(folderPath)}):`);
  if (!name) return;

  let path;
  try {
    path = resolvePathIn(folderPath, name);
    if (getFolders(state.allFiles).includes(path)) throw new Error(`Folder "${path}" already exists`);
  } catch (e) {
    alert(e.message);
    return;
  }

  try {
    setSaveStatus(`Creating folder ${path}...`, false);
    await createFolder(state.client, path);
    await loadTree();
    fileTree.setActiveFolder(path, { expand: true }); // show the folder that was just created
    setSaveStatus(`Folder created: ${path}`, false);
  } catch (e) {
    setSaveStatus('Create error: ' + e.message, true);
  }
}

// Context-menu entry points: always target the folder the user right-clicked.
function onCreateFileIn(folderPath) {
  return onCreateNewFile(folderPath);
}

function onCreateFolderIn(folderPath) {
  return onCreateNewFolder(folderPath);
}

/** Renames a file from the tree context menu; keeps it in the same folder. */
async function onRenameFile(path) {
  const newName = prompt(`New name for "${basenameOf(path)}":`, basenameOf(path));
  if (!newName) return;
  const trimmed = newName.trim();
  if (trimmed === basenameOf(path)) return;

  try {
    setSaveStatus(`Renaming ${path}...`, false);
    const { newPath, updatedFiles, skipped } = await renameFile(state.client, state.allFiles, path, trimmed);
    if (skipped) return;

    const wasCurrent = state.currentPath === path;
    tabs.rename(path, newPath);
    moveTabDoc(path, newPath);
    markStale(updatedFiles);
    if (wasCurrent) {
      state.currentPath = newPath;
      els.currentFileLabel.textContent = newPath;
    }
    if (state.currentPath && (wasCurrent || updatedFiles.includes(state.currentPath))) {
      await openFile(state.currentPath, { reload: true }); // refresh the editor + sha under the new path
    }
    persistTabs();
    renderTabs();

    imageResolver.invalidate(path);
    await loadTree();
    setSaveStatus(
      `Renamed: ${path} → ${newPath}` +
        (updatedFiles.length ? ` (updated links in ${updatedFiles.length} file(s))` : ''),
      false
    );
  } catch (e) {
    setSaveStatus('Rename error: ' + e.message, true);
  }
}

/** Deletes a file from the tree context menu (works for any file, not just the open one). */
async function onDeleteFileAt(path) {
  const confirmed = confirm(
    `Are you sure you want to delete this file?\n\n${path}\n\nThe file will be removed from the repository; this cannot be undone.`
  );
  if (!confirmed) return;

  try {
    setSaveStatus(`Deleting ${path}...`, false);
    const entry = state.allFiles.find((f) => f.path === path);
    const sha = state.currentPath === path ? state.currentSha : entry && entry.sha;
    if (!sha) throw new Error(`No sha known for ${path} — refresh the tree and try again`);

    await state.client.deleteFile(path, sha, `Delete ${path}`);
    imageResolver.invalidate(path);
    await dropTabs([path]);
    await loadTree();
    setSaveStatus(`File deleted: ${path}`, false);
  } catch (e) {
    setSaveStatus('Delete error: ' + e.message, true);
  }
}

// ====================== FOLDER OPERATIONS ======================
async function onRenameFolder(folderPath) {
  const newName = prompt(`New name for folder "${basenameOf(folderPath)}":`);
  if (!newName || newName.trim() === '') return;
  const newPath = `${dirnameOf(folderPath)}/${newName.trim()}`.replace(/^\/+/, '');
  if (newPath === folderPath) return;

  try {
    setSaveStatus(`Renaming ${folderPath}...`, false);
    const { moved, updatedFiles } = await renameFolder(state.client, state.allFiles, folderPath, newPath);
    for (const [from, to] of tabs.renameFolder(folderPath, newPath)) moveTabDoc(from, to);
    markStale(updatedFiles);
    if (state.currentPath && state.currentPath.startsWith(folderPath + '/')) {
      state.currentPath = newPath + state.currentPath.slice(folderPath.length);
      els.currentFileLabel.textContent = state.currentPath;
      await openFile(state.currentPath, { reload: true });
    }
    persistTabs();
    renderTabs();
    await loadTree();
    setSaveStatus(`Renamed: ${folderPath} → ${newPath} (files: ${moved.length})`, false);
  } catch (e) {
    setSaveStatus('Error: ' + e.message, true);
  }
}

async function onDeleteFolder(folderPath) {
  if (!isFolderEmpty(state.allFiles, folderPath)) {
    const confirmed = confirm(`Folder "${folderPath}" is not empty. Delete all files in it?\nThis cannot be undone.`);
    if (!confirmed) return;
  } else {
    const confirmed = confirm(`Delete empty folder "${folderPath}"?`);
    if (!confirmed) return;
  }

  try {
    setSaveStatus(`Deleting folder ${folderPath}...`, false);
    await deleteFolder(state.client, state.allFiles, folderPath);
    await dropTabs(tabs.paths.filter((p) => p.startsWith(folderPath + '/')));
    await loadTree();
    setSaveStatus(`Folder deleted: ${folderPath}`, false);
  } catch (e) {
    setSaveStatus('Error: ' + e.message, true);
  }
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
