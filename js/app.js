// app.js
// App assembly point. Holds minimal state and wires modules together.
// All business logic lives in separate modules (paths/markdown-tokens/reference-rewriter/
// file-mover/image-resolver) — only "wiring" and DOM event handlers here.

import { DemoClient, isDemoSession } from './demo-client.js';
import { GitHubClient, utf8ToB64, b64ToUtf8 } from './github-client.js';
import { ImageResolver } from './image-resolver.js';
import { createEditor } from './editor.js';
import { FileTree } from './file-tree.js';
import { setupImageDropzone, pickImageFiles, uploadImage } from './upload.js';
import { setupFolderDropzone } from './folder-upload.js';
import { exportCurrentPageToPdf } from './pdf-export.js';
import { moveFile, renameFile } from './file-mover.js';
import { createFolder, renameFolder, deleteFolder, getFolders, isFolderEmpty } from './folder-manager.js';
import { basenameOf, dirnameOf, encodePathForApi } from './paths.js';
import { looksLikeGitHubUrl, parseGitHubOwnerRepo } from './github-repo-url.js';
import { SearchStore } from './search-store.js';
import { SearchSync } from './search-sync.js';
import { createSearchUI, formatAge } from './search-ui.js';
import { DraftStore } from './draft-store.js';
import { Autosave } from './autosave.js';
import { TabsModel, tabLabels, tabsStorageKey } from './tabs.js';
import { createTabBar } from './tabs-ui.js';
import { WorkingTree } from './working-tree.js';
import { bindCommitPanel, bindHistoryPanel } from './commit-ui.js';
import { unifiedDiff, renderDiffLines } from './diff-util.js';
import { kindFromPath, isHtmlPath, isMarkdownPath, isEditableTextPath } from './file-kind.js';
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
let commitPanel = null;
let historyPanel = null;
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
init();

async function init() {
  // Wire chrome controls BEFORE any showApp/OAuth work. If a later step throws
  // (search, backlinks, tree), the user must still be able to sign in again.
  if (els.btnLogin) els.btnLogin.onclick = onLoginClick;
  setupRepoSwitcher();
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
  if (els.btnLogout) {
    els.btnLogout.onclick = () => {
      // Defence in depth: logout reloads the page, which tears down every timer
      // anyway, but an autosave aimed at the old token should not outlive it.
      if (autosave) autosave.destroy();
      sessionStorage.clear();
      location.reload();
    };
  }
  if (els.btnRefresh) els.btnRefresh.onclick = () => loadTree();
  // Wrap in arrows: assigning the handler directly would hand it the click
  // event as `folderPath`, creating "[object PointerEvent]/name.md".
  if (els.btnNewFile) {
    els.btnNewFile.onclick = () => {
      closeAddMenu();
      onCreateNewFile();
    };
  }
  if (els.btnNewFolder) {
    els.btnNewFolder.onclick = () => {
      closeAddMenu();
      onCreateNewFolder();
    };
  }
  try { setupAddMenu(); } catch (e) { console.warn('setupAddMenu', e); }
  if (els.btnSave) els.btnSave.onclick = onSaveFile;
  if (els.btnExportPdf) els.btnExportPdf.onclick = onExportPdf;
  if (els.btnDelete) els.btnDelete.onclick = onDeleteFile;

  // Must be awaited, and must be allowed to end init() on its own: finishLogin()
  // calls showApp() itself. Reading the session while the token check is still
  // in flight would build the app TWICE when an OAuth callback lands on a tab
  // that still holds a session — two editors, two ResizeObservers, two paste
  // handlers, with the first one nobody can reach to tear down.
  // Only the editor core is fatal. Optional CDNs (html2pdf, highlight, minisearch)
  // must NOT paint a red banner — they often trip ad-block while EasyMDE is fine.
  if (typeof window.EasyMDE !== 'function') {
    const miss = (window.__mdCdnMiss || ['easymde']).join(', ');
    setLoginStatus(
      'Editor failed to load (' + miss + '). If the console shows ERR_BLOCKED_BY_CLIENT, '
      + 'allow cdn.jsdelivr.net for this site and reload.',
      true
    );
  }

  try {
    if (await consumeOAuthRedirect()) return;
  } catch (e) {
    console.error('OAuth callback failed', e);
    setLoginStatus('Login failed: ' + (e && e.message ? e.message : e), true);
  }

  if (isDemoSession()) {
    startDemo();
    return;
  }
  const saved = readSession();
  if (saved) {
    try {
      state.client = new GitHubClient(saved);
      state.branch = saved.branch;
      showApp(saved.owner, saved.repo);
      loadTree();
    } catch (e) {
      console.error('Session restore failed', e);
      sessionStorage.removeItem('gh_token');
      try { sessionStorage.removeItem('gh_demo'); } catch (_) {}
      state.demo = false;
      if (els.demoBanner) els.demoBanner.classList.add('hidden');
      sessionStorage.removeItem('gh_owner');
      sessionStorage.removeItem('gh_repo');
      setLoginStatus('Could not restore session: ' + (e && e.message ? e.message : e) + '. Sign in again.', true);
      restorePendingLoginFields();
    }
  } else {
    const tokenOnly = sessionStorage.getItem('gh_token');
    if (tokenOnly) {
      // OAuth done, repo not chosen yet (reload mid-picker)
      void showRepoPicker(tokenOnly);
    } else {
      restorePendingLoginFields();
    }
  }
  setupRepoPickerOnce();
  setupRepoSwitcher();

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

function readSession() {
  const token = sessionStorage.getItem('gh_token');
  const owner = sessionStorage.getItem('gh_owner');
  const repo = sessionStorage.getItem('gh_repo');
  const branch = sessionStorage.getItem('gh_branch');
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch };
}

function onLoginClick() {
  // Repo is chosen AFTER OAuth — only send the user to GitHub.
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

  // Optional: pre-filled owner/repo from a previous "manual path" attempt
  const pendingOwner = sessionStorage.getItem('gh_pending_owner');
  const pendingRepo = sessionStorage.getItem('gh_pending_repo');
  sessionStorage.removeItem('gh_pending_owner');
  sessionStorage.removeItem('gh_pending_repo');

  sessionStorage.setItem('gh_token', token);

  if (pendingOwner && pendingRepo) {
    await finishLogin(token, pendingOwner, pendingRepo);
    return true;
  }

  // Default path: pick a repo from the authenticated account.
  await showRepoPicker(token);
  return true;
}

function restorePendingLoginFields() {
  const owner = sessionStorage.getItem('gh_pending_owner');
  const repo = sessionStorage.getItem('gh_pending_repo');
  if (owner) els.inputOwner.value = owner;
  if (repo) els.inputRepo.value = repo;
}


/** @type {Array<{full_name: string, name: string, owner: string, private: boolean, description: string}>} */
let cachedRepos = [];

async function showRepoPicker(token) {
  setLoginStatus('Loading your repositories…', false);
  if (els.loginCta) els.loginCta.classList.add('hidden');
  if (els.loginTrust) els.loginTrust.classList.add('hidden');
  if (els.repoPicker) els.repoPicker.classList.remove('hidden');

  const client = new GitHubClient({ token, owner: '', repo: '' });
  try {
    const user = await client.getAuthenticatedUser();
    if (els.repoPickerUser) {
      els.repoPickerUser.textContent = 'Signed in as @' + (user.login || 'user')
        + ' — pick a repository to open.';
    }
    const raw = await client.listUserRepos();
    cachedRepos = (raw || []).map((r) => ({
      full_name: r.full_name,
      name: r.name,
      owner: r.owner && r.owner.login ? r.owner.login : String(r.full_name || '').split('/')[0],
      private: !!r.private,
      description: r.description || '',
      pushed_at: r.pushed_at || '',
    }));
    renderRepoList('');
    setLoginStatus(
      cachedRepos.length
        ? 'Select a repository to continue.'
        : 'No repositories found. Use “Open a repo by path” below, or create one on GitHub.',
      !cachedRepos.length
    );
    if (els.repoSearch) {
      els.repoSearch.value = '';
      els.repoSearch.focus();
    }
  } catch (e) {
    setLoginStatus('Could not list repositories: ' + (e && e.message ? e.message : e), true);
    // Still allow manual owner/repo entry.
    if (els.repoPicker) els.repoPicker.classList.remove('hidden');
  }
  setupRepoPickerOnce();
}

function renderRepoList(filter) {
  if (!els.repoList) return;
  const q = String(filter || '').trim().toLowerCase();
  const items = !q
    ? cachedRepos
    : cachedRepos.filter((r) =>
        r.full_name.toLowerCase().includes(q)
        || (r.description && r.description.toLowerCase().includes(q))
      );
  els.repoList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'repo-list-empty';
    empty.textContent = q ? 'No match for “' + filter + '”.' : 'No repositories to show.';
    els.repoList.appendChild(empty);
    return;
  }
  for (const r of items.slice(0, 100)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'repo-list-item';
    btn.setAttribute('role', 'option');
    const title = document.createElement('span');
    title.className = 'repo-full';
    title.textContent = r.full_name + (r.private ? ' 🔒' : '');
    btn.appendChild(title);
    if (r.description) {
      const meta = document.createElement('span');
      meta.className = 'repo-meta';
      meta.textContent = r.description;
      btn.appendChild(meta);
    }
    btn.addEventListener('click', () => {
      const token = sessionStorage.getItem('gh_token');
      if (!token) {
        setLoginStatus('Session lost — sign in again.', true);
        return;
      }
      finishLogin(token, r.owner, r.name);
    });
    els.repoList.appendChild(btn);
  }
}


function setRepoSwitchStatus(msg, isError) {
  if (!els.repoSwitchStatus) return;
  els.repoSwitchStatus.textContent = msg || '';
  els.repoSwitchStatus.className = 'status' + (isError ? ' err' : msg ? ' ok' : '');
}

function closeRepoSwitcher() {
  if (!els.repoSwitchOverlay) return;
  els.repoSwitchOverlay.classList.add('hidden');
  els.repoSwitchOverlay.setAttribute('aria-hidden', 'true');
}

function renderSwitchRepoList(filter) {
  if (!els.repoSwitchList) return;
  const q = String(filter || '').trim().toLowerCase();
  const items = !q
    ? cachedRepos
    : cachedRepos.filter((r) =>
        r.full_name.toLowerCase().includes(q)
        || (r.description && r.description.toLowerCase().includes(q))
      );
  els.repoSwitchList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'repo-list-empty';
    empty.textContent = q ? 'No match.' : 'No repositories loaded.';
    els.repoSwitchList.appendChild(empty);
    return;
  }
  const cur = (sessionStorage.getItem('gh_owner') || '') + '/' + (sessionStorage.getItem('gh_repo') || '');
  for (const r of items.slice(0, 100)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'repo-list-item';
    const title = document.createElement('span');
    title.className = 'repo-full';
    title.textContent = r.full_name + (r.private ? ' 🔒' : '')
      + (r.full_name === cur ? ' · current' : '');
    btn.appendChild(title);
    if (r.description) {
      const meta = document.createElement('span');
      meta.className = 'repo-meta';
      meta.textContent = r.description;
      btn.appendChild(meta);
    }
    btn.addEventListener('click', () => {
      void switchRepository(r.owner, r.name);
    });
    els.repoSwitchList.appendChild(btn);
  }
}

async function openRepoSwitcher() {
  if (!els.repoSwitchOverlay) return;
  const token = sessionStorage.getItem('gh_token');
  if (!token) {
    setSaveStatus('Not signed in', true);
    return;
  }
  els.repoSwitchOverlay.classList.remove('hidden');
  els.repoSwitchOverlay.setAttribute('aria-hidden', 'false');
  setRepoSwitchStatus('Loading repositories…', false);
  if (els.repoSwitchSearch) els.repoSwitchSearch.value = '';
  try {
    const client = new GitHubClient({ token, owner: '', repo: '' });
    const raw = await client.listUserRepos();
    cachedRepos = (raw || []).map((r) => ({
      full_name: r.full_name,
      name: r.name,
      owner: r.owner && r.owner.login ? r.owner.login : String(r.full_name || '').split('/')[0],
      private: !!r.private,
      description: r.description || '',
      pushed_at: r.pushed_at || '',
    }));
    renderSwitchRepoList('');
    setRepoSwitchStatus(cachedRepos.length ? '' : 'No repositories found.', !cachedRepos.length);
    if (els.repoSwitchSearch) els.repoSwitchSearch.focus();
  } catch (e) {
    setRepoSwitchStatus('Failed to load: ' + (e && e.message ? e.message : e), true);
  }
}

async function switchRepository(owner, repo) {
  const token = sessionStorage.getItem('gh_token');
  if (!token) {
    setRepoSwitchStatus('Session expired — sign in again.', true);
    return;
  }
  if (
    owner === sessionStorage.getItem('gh_owner')
    && repo === sessionStorage.getItem('gh_repo')
  ) {
    closeRepoSwitcher();
    return;
  }
  // Best-effort: push local dirty work for the current file before tearing down.
  try {
    if (autosave && typeof autosave.saveNow === 'function' && autosave.hasUnsavedDraft
        && autosave.hasUnsavedDraft()) {
      setRepoSwitchStatus('Saving current file…', false);
      await autosave.saveNow();
    }
  } catch (_) { /* continue switch even if save fails */ }

  setRepoSwitchStatus('Opening ' + owner + '/' + repo + '…', false);
  try {
    await finishLogin(token, owner, repo);
    closeRepoSwitcher();
  } catch (e) {
    setRepoSwitchStatus('Could not open: ' + (e && e.message ? e.message : e), true);
  }
}

function setupRepoSwitcher() {
  if (!els.btnSwitchRepo || els.btnSwitchRepo.dataset.bound) return;
  els.btnSwitchRepo.dataset.bound = '1';
  els.btnSwitchRepo.addEventListener('click', () => { void openRepoSwitcher(); });
  if (els.btnRepoSwitchClose) {
    els.btnRepoSwitchClose.addEventListener('click', closeRepoSwitcher);
  }
  if (els.repoSwitchOverlay) {
    els.repoSwitchOverlay.addEventListener('click', (e) => {
      if (e.target === els.repoSwitchOverlay) closeRepoSwitcher();
    });
  }
  if (els.repoSwitchSearch) {
    els.repoSwitchSearch.addEventListener('input', () => {
      renderSwitchRepoList(els.repoSwitchSearch.value);
    });
  }
  if (els.btnSwitchOpenPath) {
    els.btnSwitchOpenPath.addEventListener('click', () => {
      let owner = (els.switchInputOwner && els.switchInputOwner.value || '').trim();
      let repo = (els.switchInputRepo && els.switchInputRepo.value || '').trim();
      const parsed = parseGitHubOwnerRepo(owner) || parseGitHubOwnerRepo(repo);
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
      if (!owner || !repo) {
        setRepoSwitchStatus('Enter owner and repository.', true);
        return;
      }
      void switchRepository(owner, repo);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.repoSwitchOverlay
        && !els.repoSwitchOverlay.classList.contains('hidden')) {
      closeRepoSwitcher();
    }
  });
}

function setupRepoPickerOnce() {
  if (document.documentElement.dataset.repoPickerBound) return;
  document.documentElement.dataset.repoPickerBound = '1';
  if (els.repoSearch) {
    els.repoSearch.addEventListener('input', () => {
      renderRepoList(els.repoSearch.value);
    });
  }
  if (els.btnOpenRepo) {
    els.btnOpenRepo.addEventListener('click', onManualOpenRepo);
  }
}

function onManualOpenRepo() {
  let owner = (els.inputOwner && els.inputOwner.value || '').trim();
  let repo = (els.inputRepo && els.inputRepo.value || '').trim();
  const parsed = parseGitHubOwnerRepo(owner) || parseGitHubOwnerRepo(repo);
  if (parsed) {
    owner = parsed.owner;
    repo = parsed.repo;
    if (els.inputOwner) els.inputOwner.value = owner;
    if (els.inputRepo) els.inputRepo.value = repo;
  }
  if (!owner || !repo) {
    setLoginStatus('Enter both owner and repository name.', true);
    return;
  }
  const token = sessionStorage.getItem('gh_token');
  if (!token) {
    // Not signed in yet — stash and start OAuth
    sessionStorage.setItem('gh_pending_owner', owner);
    sessionStorage.setItem('gh_pending_repo', repo);
    setLoginStatus('Redirecting to GitHub...', false);
    location.href = '/auth/login';
    return;
  }
  finishLogin(token, owner, repo);
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
    if (els.branchLabel) els.branchLabel.textContent = branch;
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
      setLoginStatus(msg, true);
    } catch (_) {}
    return;
  }

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
    onActiveFolderChange: (folderPath) => updateActiveFolderPathLabel(folderPath),
  });
  updateActiveFolderPathLabel(fileTree.getActiveFolder());

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
          refreshCommitBadge();
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
  setupCommitAndHistory();
  workingTree.clearAll();
  refreshCommitBadge();

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
    refreshCommitBadge();
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
 * Creates a new text file (.md, .html, .js, .css, …). folderPath defaults to the
 * tree's active folder so the file lands where the user is looking.
 */

function formatActiveFolderPath(folderPath) {
  const p = (folderPath || '').replace(/^\/+|\/+$/g, '');
  return p ? p : '/';
}

function updateActiveFolderPathLabel(folderPath) {
  if (!els.activeFolderPath) return;
  const label = formatActiveFolderPath(folderPath);
  els.activeFolderPath.textContent = label;
  els.activeFolderPath.title = label === '/'
    ? 'Target: repository root'
    : 'Target folder: ' + label;
}

function closeAddMenu() {
  if (els.addMenu) els.addMenu.classList.add('hidden');
}

function setupAddMenu() {
  if (!els.btnAddMenu || els.btnAddMenu.dataset.bound) return;
  els.btnAddMenu.dataset.bound = '1';
  els.btnAddMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!els.addMenu) return;
    els.addMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!els.addMenu || els.addMenu.classList.contains('hidden')) return;
    if (els.addMenu.contains(e.target) || (els.btnAddMenu && els.btnAddMenu.contains(e.target))) return;
    closeAddMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAddMenu();
  });
}

async function onCreateNewFile(folderPath = fileTree.getActiveFolder()) {
  folderPath = toFolderPath(folderPath);
  const name = prompt(
    `New file name (created in ${targetFolderLabel(folderPath)}):\n` +
      `Examples: note.md, page.html, script.js, styles.css`,
    'untitled.md'
  );
  if (!name) return;

  let path;
  try {
    path = resolvePathIn(folderPath, name);
    if (!isEditableTextPath(path)) {
      throw new Error(
        'Unsupported file type. Use a text extension (.md, .html, .js, .css, .json, .txt, …)'
      );
    }
    if (state.allFiles.some((f) => f.path === path)) throw new Error(`"${path}" already exists`);
  } catch (e) {
    alert(e.message);
    return;
  }

  try {
    setSaveStatus(`Creating ${path}...`, false);
    const starter = starterContentForPath(path);
    await state.client.putFile(path, utf8ToB64(starter), `Create ${path}`);
    await loadTree();
    fileTree.setActiveFolder(folderPath, { expand: true }); // reveal the new file
    await openFile(path);
    setSaveStatus(`File created: ${path}`, false);
  } catch (e) {
    setSaveStatus('Create error: ' + e.message, true);
  }
}

/** Initial body for a newly created file, by kind. */
function starterContentForPath(path) {
  const kind = kindFromPath(path);
  if (kind.kind === 'html') {
    return (
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n' +
      '  <title>New page</title>\n</head>\n<body>\n  <h1>New page</h1>\n</body>\n</html>\n'
    );
  }
  if (kind.kind === 'code') {
    if (kind.ext === 'css') return '/* styles */\n\n';
    if (kind.ext === 'json') return '{\n  \n}\n';
    if (kind.ext === 'js' || kind.ext === 'mjs' || kind.ext === 'cjs' || kind.ext === 'ts' || kind.ext === 'jsx' || kind.ext === 'tsx') {
      return '// script\n\n';
    }
    if (kind.ext === 'py') return '# script\n\n';
    return '';
  }
  if (kind.kind === 'markdown') return '# New file\n';
  return '';
}

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

function refreshCommitBadge() {
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

function setupCommitAndHistory() {
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

  if (!els.btnCommit.dataset.bound) {
    els.btnCommit.dataset.bound = '1';
    els.btnCommit.addEventListener('click', () => {
      // Toggle: second click closes the drawer (same UX as History)
      if (commitPanel && typeof commitPanel.isOpen === 'function' && commitPanel.isOpen()) {
        commitPanel.close();
        els.btnCommit.classList.remove('active-panel');
        hideDiffOverlay();
        return;
      }
      // Flush current editor text into working tree before opening panel
      if (state.currentPath && editorHandle) {
        workingTree.setDirty(
          state.currentPath,
          editorHandle.easyMDE.value(),
          state.currentSha || null
        );
      }
      // Also pull dirty text from open tabs that aren't active
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

  if (!els.btnHistory.dataset.bound) {
    els.btnHistory.dataset.bound = '1';
    els.btnHistory.addEventListener('click', async () => {
      // Toggle: second click closes the drawer
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
        const list = await state.client.listCommits({ branch: state.branch, perPage: 40 });
        const items = list.map((c) => ({
          sha: c.sha,
          message: (c.commit && c.commit.message) || '',
          author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || 'unknown',
          date: formatCommitDate(c.commit && c.commit.author && c.commit.author.date),
          stats: c.stats ? `+${c.stats.additions || 0} −${c.stats.deletions || 0}` : '',
        }));
        historyPanel.renderList(items);
        if (!historyPanel.isOpen()) return; // closed while loading
        historyPanel.setLoading('Select a commit');
      } catch (e) {
        if (historyPanel.isOpen()) historyPanel.setLoading('Error: ' + e.message);
      }
    });
  }
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
  historyPanel.setLoading('Loading diff…');
  try {
    const detail = await state.client.getCommitDetail(sha);
    historyPanel.renderDetail({
      sha: detail.sha,
      message: (detail.commit && detail.commit.message) || '',
      files: (detail.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        patch: f.patch,
        additions: f.additions,
        deletions: f.deletions,
        sha: f.sha,
      })),
    });
  } catch (e) {
    historyPanel.setLoading('Error: ' + e.message);
  }
}

/**
 * Multi-file commit via Git Data API.
 * andPush is informational — API commit already updates the remote ref.
 */
async function doCommit(message, andPush) {
  const changes = workingTree.listChanges();
  if (!changes.length) return;
  commitPanel.setBusy(true);
  setSaveStatus(andPush ? 'Committing & pushing…' : 'Committing…', false);
  try {
    // Prefer current editor buffer for active path
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

    // Clear dirty state for committed paths
    for (const c of latest) workingTree.clear(c.path);
    refreshCommitBadge();
    if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());

    // Update current SHA if active file was in the commit
    if (state.currentPath && latest.some((c) => c.path === state.currentPath)) {
      // Best-effort: refresh sha from tree after commit
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
        await loadTree();
      }
    } else {
      await loadTree();
    }

    // Mark tabs clean for committed paths
    for (const c of latest) {
      const entry = tabDocs.get(c.path);
      if (entry) entry.unsaved = false;
      if (c.path === state.currentPath) activeFileUnsaved = false;
    }
    renderTabs();

    commitPanel.clearMessage();
    commitPanel.close();
    if (els.btnCommit) els.btnCommit.classList.remove('active-panel');
    hideDiffOverlay();
    // Keep draft store + tab/autosave state aligned with workingTree
    // (single-file Save already goes through noteCommit → workingTree.clear)
    for (const c of latest) {
      noteCommit(c.path, null); // blob sha refreshed from tree below; do not store commit sha as file sha
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
    setSaveStatus(
      (andPush ? 'Committed & pushed ' : 'Committed ') + short + ' · ' + latest.length + ' file(s)',
      false
    );
  } catch (e) {
    setSaveStatus('Commit failed: ' + e.message, true);
  } finally {
    commitPanel.setBusy(false);
  }
}


// ====================== PRE-COMMIT DIFF + HISTORY RESTORE ======================

/** @type {{ path: string, text: string, mode: string, commitSha?: string }|null} */
let diffOverlayState = null;

function hideDiffOverlay() {
  diffOverlayState = null;
  if (els.diffOverlay) els.diffOverlay.classList.add('hidden');
  if (els.btnDiffRestore) els.btnDiffRestore.classList.add('hidden');
  if (els.diffOverlayBody) els.diffOverlayBody.innerHTML = '';
}

/**
 * Show unified diff of working copy vs last known GitHub version (pre-commit review).
 */
async function showPreCommitDiff(path) {
  const change = workingTree.get(path);
  if (!change) {
    setSaveStatus('No local changes for ' + path, true);
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

/**
 * Restore a file version from a historical commit into the editor as local changes.
 * Does NOT commit — user reviews and commits intentionally.
 */
async function restoreFileFromHistory(file, commitSha) {
  const path = file.filename || file.path;
  if (!path) return;

  const confirmed = confirm(
    'Restore "' + path + '" from commit ' + String(commitSha).slice(0, 7) + '?\n\n' +
    'This loads that version into the editor as local changes. ' +
    'It will not commit until you do.'
  );
  if (!confirmed) return;

  setSaveStatus('Restoring ' + path + '…', false);
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

    await openFile(path);
    setEditorValue(text);
    state.currentPath = path;
    if (head) state.currentSha = head.sha;

    workingTree.setDirty(path, text, baseSha);
    activeFileUnsaved = true;
    const tab = tabDocs.get(path);
    if (tab) {
      tab.unsaved = true;
      try {
        if (tab.doc && typeof tab.doc.setValue === 'function') tab.doc.setValue(text);
      } catch (_) {}
    }
    ensureAutosave().onChange(text);
    refreshCommitBadge();
    if (fileTree) fileTree.setDirtyMap(workingTree.statusMap());
    renderTabs();

    if (historyPanel) historyPanel.close();
    hideDiffOverlay();
    setSaveStatus(
      'Restored ' + path + ' from ' + String(commitSha).slice(0, 7) + ' — review and Commit when ready',
      false
    );
  } catch (e) {
    setSaveStatus('Restore failed: ' + e.message, true);
  }
}
