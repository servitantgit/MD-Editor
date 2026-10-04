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
  folderDropzone: document.getElementById('folder-dropzone'),
  folderDropOverlay: document.getElementById('folder-dropzone-overlay'),
  btnNewFolder: document.getElementById('btn-new-folder'),
  btnNewFile: document.getElementById('btn-new-file'),

  currentFileLabel: document.getElementById('current-file'),
  btnSave: document.getElementById('btn-save'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
  btnDelete: document.getElementById('btn-delete'),
  saveStatus: document.getElementById('save-status'),

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
};

let imageResolver = null;
let fileTree = null;
let editorHandle = null;

// ====================== LOGIN ======================
init();

function init() {
  consumeOAuthRedirect();

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
 */
function consumeOAuthRedirect() {
  const hash = location.hash || '';
  const match = hash.match(/(?:^#|&)gh_token=([^&]+)/);
  if (!match) return;

  const token = decodeURIComponent(match[1]);
  history.replaceState(null, '', location.pathname + location.search);

  const owner = sessionStorage.getItem('gh_pending_owner');
  const repo = sessionStorage.getItem('gh_pending_repo');
  sessionStorage.removeItem('gh_pending_owner');
  sessionStorage.removeItem('gh_pending_repo');

  if (!owner || !repo) {
    setLoginStatus('Login session lost (owner/repo). Please try again.', true);
    return;
  }

  finishLogin(token, owner, repo);
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

// ====================== APP SHELL ======================
function showApp(owner, repo) {
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
    fileTree.setFiles(files);
  } catch (e) {
    els.fileTreeEl.innerHTML = `<div class="tree-error">Error: ${escapeHtml(e.message)}</div>`;
  }
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

    if (state.currentPath === oldPath) {
      state.currentPath = newPath;
      els.currentFileLabel.textContent = newPath;
    }
    if (state.currentPath && updatedFiles.includes(state.currentPath)) {
      await openFile(state.currentPath); // pull fresh contents/sha after auto link replacement
    }

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

// ====================== OPEN / SAVE ======================
async function openFile(path) {
  fileTree.setActive(path);
  els.currentFileLabel.textContent = path;
  els.btnSave.disabled = true;
  els.btnExportPdf.disabled = true;
  els.btnDelete.disabled = true;
  setSaveStatus('Loading...', false);

  try {
    const { b64, sha } = await state.client.getFileB64(path);
    state.currentPath = path;
    state.currentSha = sha;
    editorHandle.easyMDE.value(b64ToUtf8(b64));
    editorHandle.refreshLayout();
    editorHandle.refreshInlineImages();

    els.btnSave.disabled = false;
    els.btnExportPdf.disabled = false;
    els.btnDelete.disabled = false;
    setSaveStatus('Ready', false);
  } catch (e) {
    setSaveStatus('Error: ' + e.message, true);
  }
}

async function onSaveFile() {
  if (!state.currentPath) return;
  const content = editorHandle.easyMDE.value();

  els.btnSave.disabled = true;
  setSaveStatus('Saving...', false);
  try {
    const data = await state.client.putFile(state.currentPath, utf8ToB64(content), `Update ${state.currentPath}`, state.currentSha);
    state.currentSha = data.content.sha;
    setSaveStatus('Saved ✓', false);
  } catch (e) {
    setSaveStatus('Error: ' + e.message, true);
  } finally {
    els.btnSave.disabled = false;
  }
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
    closeCurrentFile();
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

// After deletion (or when no file is open) the editor must not keep
// the deleted file's contents: clear the text, drop inline images, lock actions.
function closeCurrentFile() {
  state.currentPath = null;
  state.currentSha = null;
  els.currentFileLabel.textContent = 'No file selected';
  fileTree.clearActive();
  editorHandle.easyMDE.value('');
  editorHandle.refreshLayout();
  editorHandle.refreshInlineImages();
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

/** Turns whatever was passed into a folder path, or '' for the repo root.
 *
 * The toolbar wires these handlers straight to `onclick`, so a stray
 * MouseEvent/PointerEvent can arrive here as `folderPath`. Coercing it keeps a
 * typo in one place from producing a path like "[object PointerEvent]/x.md"
 * all the way down to the GitHub API. */
function toFolderPath(value) {
  return typeof value === 'string' ? value : '';
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

    if (state.currentPath === path) {
      state.currentPath = newPath;
      els.currentFileLabel.textContent = newPath;
      await openFile(newPath); // refresh the editor + sha under the new path
    } else if (state.currentPath && updatedFiles.includes(state.currentPath)) {
      await openFile(state.currentPath);
    }

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
    if (state.currentPath === path) closeCurrentFile();
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
    if (state.currentPath && state.currentPath.startsWith(folderPath + '/')) {
      state.currentPath = newPath + state.currentPath.slice(folderPath.length);
      els.currentFileLabel.textContent = state.currentPath;
      await openFile(state.currentPath);
    }
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
    if (state.currentPath && state.currentPath.startsWith(folderPath + '/')) {
      closeCurrentFile();
    }
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
