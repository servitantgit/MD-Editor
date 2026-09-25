// app.js
// Точка збирання застосунку. Тримає мінімальний стан і підключає модулі один до одного.
// Уся бізнес-логіка живе в окремих модулях (paths/markdown-tokens/reference-rewriter/
// file-mover/image-resolver) — тут лише "проводка" й обробники подій DOM.

import { GitHubClient, utf8ToB64, b64ToUtf8 } from './github-client.js';
import { ImageResolver } from './image-resolver.js';
import { createEditor } from './editor.js';
import { FileTree } from './file-tree.js';
import { setupImageDropzone, pickImageFiles, uploadImage } from './upload.js';
import { exportCurrentPageToPdf } from './pdf-export.js';
import { moveFile } from './file-mover.js';

const els = {
  loginScreen: document.getElementById('login-screen'),
  loginStatus: document.getElementById('login-status'),
  inputOwner: document.getElementById('input-owner'),
  inputRepo: document.getElementById('input-repo'),
  inputToken: document.getElementById('input-token'),
  btnLogin: document.getElementById('btn-login'),

  appHeader: document.getElementById('app-header'),
  appMain: document.getElementById('app-main'),
  repoLabel: document.getElementById('repo-label'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnLogout: document.getElementById('btn-logout'),

  fileTreeEl: document.getElementById('file-tree'),
  btnNewFile: document.getElementById('btn-new-file'),

  currentFileLabel: document.getElementById('current-file'),
  btnSave: document.getElementById('btn-save'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
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
  const saved = readSession();
  if (saved) {
    state.client = new GitHubClient(saved);
    state.branch = saved.branch;
    showApp(saved.owner, saved.repo);
    loadTree();
  }

  els.btnLogin.onclick = onLoginClick;
  els.btnLogout.onclick = () => {
    sessionStorage.clear();
    location.reload();
  };
  els.btnRefresh.onclick = () => loadTree();
  els.btnNewFile.onclick = onCreateNewFile;
  els.btnSave.onclick = onSaveFile;
  els.btnExportPdf.onclick = onExportPdf;
}

function readSession() {
  const token = sessionStorage.getItem('gh_token');
  const owner = sessionStorage.getItem('gh_owner');
  const repo = sessionStorage.getItem('gh_repo');
  const branch = sessionStorage.getItem('gh_branch');
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch };
}

async function onLoginClick() {
  const owner = els.inputOwner.value.trim();
  const repo = els.inputRepo.value.trim();
  const token = els.inputToken.value.trim();
  if (!owner || !repo || !token) {
    setLoginStatus('Заповніть усі поля', true);
    return;
  }

  setLoginStatus('Перевірка...', false);
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
    setLoginStatus('Помилка: ' + e.message, true);
  }
}

function setLoginStatus(msg, isError) {
  els.loginStatus.textContent = msg;
  els.loginStatus.className = 'status ' + (isError ? 'err' : 'ok');
}

function setSaveStatus(msg, isError) {
  els.saveStatus.textContent = msg;
  els.saveStatus.className = 'status ' + (isError ? 'err' : 'ok');
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
      setSaveStatus(`Прев’ю: не вдалося завантажити ${count} зображення(нь) — деталі показані на місці картинки`, true),
  });

  // Ключовий фікс "не скролиться / не редагується": примусово перераховуємо
  // layout CodeMirror одразу після того, як контейнер став видимим і отримав
  // реальні розміри (на момент конструювання EasyMDE контейнер міг ще не мати
  // фінальної висоти через flex-розкладку, що зустрічається сторінки).
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
  els.fileTreeEl.innerHTML = '<div class="tree-loading">Завантаження...</div>';
  try {
    const files = await state.client.getTree(state.branch);
    state.allFiles = files;
    fileTree.setFiles(files);
  } catch (e) {
    els.fileTreeEl.innerHTML = `<div class="tree-error">Помилка: ${escapeHtml(e.message)}</div>`;
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
      overlay.querySelector('.image-preview-path').textContent = 'Не вдалося завантажити: ' + err.message;
      console.warn('previewImageFile', path, err);
    });
}

async function onMoveFile(oldPath, targetFolder) {
  setSaveStatus(`Переміщення ${oldPath}...`, false);
  try {
    const { newPath, updatedFiles, skipped } = await moveFile(state.client, state.allFiles, oldPath, targetFolder);
    if (skipped) return;

    if (state.currentPath === oldPath) {
      state.currentPath = newPath;
      els.currentFileLabel.textContent = newPath;
    }
    if (state.currentPath && updatedFiles.includes(state.currentPath)) {
      await openFile(state.currentPath); // підтягнути свіжий вміст/sha після автозаміни посилань
    }

    imageResolver.invalidate(oldPath);
    await loadTree();
    setSaveStatus(
      `Переміщено: ${oldPath} → ${newPath}` +
        (updatedFiles.length ? ` (оновлено посилань у ${updatedFiles.length} файл(ах))` : ''),
      false
    );
  } catch (e) {
    setSaveStatus('Помилка переміщення: ' + e.message, true);
  }
}

// ====================== OPEN / SAVE ======================
async function openFile(path) {
  fileTree.setActive(path);
  els.currentFileLabel.textContent = path;
  els.btnSave.disabled = true;
  els.btnExportPdf.disabled = true;
  setSaveStatus('Завантаження...', false);

  try {
    const { b64, sha } = await state.client.getFileB64(path);
    state.currentPath = path;
    state.currentSha = sha;
    editorHandle.easyMDE.value(b64ToUtf8(b64));
    editorHandle.refreshLayout();

    els.btnSave.disabled = false;
    els.btnExportPdf.disabled = false;
    setSaveStatus('Готово', false);
  } catch (e) {
    setSaveStatus('Помилка: ' + e.message, true);
  }
}

async function onSaveFile() {
  if (!state.currentPath) return;
  const content = editorHandle.easyMDE.value();

  els.btnSave.disabled = true;
  setSaveStatus('Збереження...', false);
  try {
    const data = await state.client.putFile(state.currentPath, utf8ToB64(content), `Update ${state.currentPath}`, state.currentSha);
    state.currentSha = data.content.sha;
    setSaveStatus('Збережено ✓', false);
  } catch (e) {
    setSaveStatus('Помилка: ' + e.message, true);
  } finally {
    els.btnSave.disabled = false;
  }
}

async function onCreateNewFile() {
  const path = prompt('Шлях нового файлу (наприклад docs/new.md):');
  if (!path || !path.endsWith('.md')) {
    alert('Шлях має закінчуватися на .md');
    return;
  }
  try {
    await state.client.putFile(path, utf8ToB64('# New file\n'), `Create ${path}`);
    await loadTree();
    openFile(path);
  } catch (e) {
    alert('Помилка створення: ' + e.message);
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
