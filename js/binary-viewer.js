// binary-viewer.js
// View-only panel for PDF and office files:
//   Source  → stub (editing not supported)
//   Live/Preview → PDF embed, DOCX via Mammoth, XLSX via SheetJS, else helpful stub

import { basenameOf, extOf } from './paths.js';
import { kindFromPath } from './file-kind.js';

/** @type {{ path: string, b64: string, objectUrl: string|null, kind: object, arrayBuffer: ArrayBuffer|null }|null} */
let current = null;
/** @type {number} */
let renderToken = 0;

const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  pdf: 'application/pdf',
};

const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

export function guessBinaryMime(path) {
  const e = extOf(path);
  return OFFICE_MIME[e] || 'application/octet-stream';
}

export function isBinaryViewPath(path) {
  const k = kindFromPath(path);
  return k.kind === 'pdf' || k.kind === 'office';
}

/**
 * @param {HTMLElement} rootEl  #binary-viewer
 * @param {string} path
 * @param {string} b64
 * @param {'source'|'split'|'preview'} layoutMode
 */
export function showBinaryViewer(rootEl, path, b64, layoutMode) {
  if (!rootEl) return;
  revokeCurrentUrl();
  const kind = kindFromPath(path);
  let objectUrl = null;
  let arrayBuffer = null;
  try {
    const mime = guessBinaryMime(path);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const blob = new Blob([bytes], { type: mime });
    objectUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.warn('binary-viewer: blob failed', err);
  }
  current = { path, b64, objectUrl, kind, arrayBuffer };
  rootEl.classList.remove('hidden');
  render(rootEl, layoutMode);
}

/** Hide panel and release the blob URL. */
export function hideBinaryViewer(rootEl) {
  revokeCurrentUrl();
  current = null;
  renderToken++;
  if (rootEl) {
    rootEl.classList.add('hidden');
    rootEl.innerHTML = '';
  }
}

/** Re-render when Source / Live / Preview changes (same file). */
export function refreshBinaryViewer(rootEl, layoutMode) {
  if (!current || !rootEl || rootEl.classList.contains('hidden')) return;
  render(rootEl, layoutMode);
}

/** Download the currently open binary (or the given path/b64). */
export function downloadBinaryFile(path, b64) {
  const p = path || (current && current.path);
  const data = b64 || (current && current.b64);
  if (!p || !data) return;
  try {
    const mime = guessBinaryMime(p);
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = basenameOf(p);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    console.warn('downloadBinaryFile failed', err);
  }
}

export function getCurrentBinary() {
  return current;
}

function revokeCurrentUrl() {
  if (current && current.objectUrl) {
    try { URL.revokeObjectURL(current.objectUrl); } catch (_) { /* ignore */ }
    current.objectUrl = null;
  }
}

function b64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function render(rootEl, layoutMode) {
  if (!current) return;
  const { path, objectUrl, kind, b64, arrayBuffer } = current;
  const name = basenameOf(path);
  const isSource = layoutMode === 'source';
  const isPdf = kind.kind === 'pdf';
  const ext = extOf(path);
  const myToken = ++renderToken;

  if (isSource) {
    rootEl.innerHTML = `
      <div class="binary-stub">
        <div class="binary-stub-icon">${isPdf ? '📄' : '📑'}</div>
        <div class="binary-stub-title">${escapeHtml(name)}</div>
        <p class="binary-stub-msg">Editing of this file type is not supported.<br>Such functionality is not available.</p>
        <p class="binary-stub-hint">Switch to <b>Live</b> or <b>Preview</b> to view the file, or use <b>Download</b> to save it to your device.</p>
      </div>`;
    return;
  }

  // Live / Preview
  if (isPdf && objectUrl) {
    rootEl.innerHTML = `
      <div class="binary-preview-frame">
        <iframe class="binary-pdf-frame" title="PDF preview: ${escapeAttr(name)}" src="${objectUrl}#toolbar=1"></iframe>
      </div>`;
    return;
  }

  // DOCX → HTML via Mammoth
  if (ext === 'docx') {
    rootEl.innerHTML = `
      <div class="binary-office-loading">
        <div class="binary-stub-icon">📑</div>
        <p>Loading document preview…</p>
      </div>`;
    const buf = arrayBuffer || b64ToArrayBuffer(b64);
    loadScript(MAMMOTH_CDN, 'mammoth')
      .then(() => {
        if (myToken !== renderToken || !current || current.path !== path) return;
        const mammoth = window.mammoth;
        if (!mammoth || typeof mammoth.convertToHtml !== 'function') {
          throw new Error('Mammoth failed to load');
        }
        return mammoth.convertToHtml({ arrayBuffer: buf });
      })
      .then((result) => {
        if (myToken !== renderToken || !current || current.path !== path) return;
        if (!result) return;
        const warnings = (result.messages || [])
          .filter((m) => m.type === 'warning')
          .map((m) => m.message);
        rootEl.innerHTML = `
          <div class="binary-office-scroll">
            <div class="binary-office-toolbar">
              <span class="binary-office-name">${escapeHtml(name)}</span>
              <span class="binary-office-badge">DOCX preview</span>
            </div>
            <div class="binary-office-html">${result.value || '<p><em>(empty document)</em></p>'}</div>
            ${warnings.length ? `<div class="binary-office-warnings">${warnings.map((w) => escapeHtml(w)).join('<br>')}</div>` : ''}
          </div>`;
      })
      .catch((err) => {
        if (myToken !== renderToken) return;
        console.warn('DOCX preview failed', err);
        rootEl.innerHTML = officeFallbackHtml(name, 'Document', err && err.message, objectUrl);
      });
    return;
  }

  // XLSX / XLS → HTML table via SheetJS
  if (ext === 'xlsx' || ext === 'xls') {
    rootEl.innerHTML = `
      <div class="binary-office-loading">
        <div class="binary-stub-icon">📊</div>
        <p>Loading spreadsheet preview…</p>
      </div>`;
    const buf = arrayBuffer || b64ToArrayBuffer(b64);
    loadScript(XLSX_CDN, 'XLSX')
      .then(() => {
        if (myToken !== renderToken || !current || current.path !== path) return;
        const XLSX = window.XLSX;
        if (!XLSX || typeof XLSX.read !== 'function') {
          throw new Error('SheetJS failed to load');
        }
        const wb = XLSX.read(buf, { type: 'array' });
        const sheets = wb.SheetNames || [];
        if (!sheets.length) {
          rootEl.innerHTML = officeFallbackHtml(name, 'Spreadsheet', 'Workbook has no sheets', objectUrl);
          return;
        }
        let tabs = sheets.map((s, i) =>
          `<button type="button" class="binary-sheet-tab${i === 0 ? ' active' : ''}" data-sheet="${escapeAttr(s)}">${escapeHtml(s)}</button>`
        ).join('');
        const firstHtml = sheetToHtml(XLSX, wb.Sheets[sheets[0]]);
        rootEl.innerHTML = `
          <div class="binary-office-scroll binary-xlsx">
            <div class="binary-office-toolbar">
              <span class="binary-office-name">${escapeHtml(name)}</span>
              <span class="binary-office-badge">Spreadsheet preview</span>
            </div>
            <div class="binary-sheet-tabs">${tabs}</div>
            <div class="binary-sheet-body">${firstHtml}</div>
          </div>`;
        const body = rootEl.querySelector('.binary-sheet-body');
        rootEl.querySelectorAll('.binary-sheet-tab').forEach((btn) => {
          btn.addEventListener('click', () => {
            rootEl.querySelectorAll('.binary-sheet-tab').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            const sheet = wb.Sheets[btn.dataset.sheet];
            body.innerHTML = sheetToHtml(XLSX, sheet);
          });
        });
      })
      .catch((err) => {
        if (myToken !== renderToken) return;
        console.warn('XLSX preview failed', err);
        rootEl.innerHTML = officeFallbackHtml(name, 'Spreadsheet', err && err.message, objectUrl);
      });
    return;
  }

  // Other office formats (pptx, odt, …): no reliable client-side renderer
  const label = kind.label || 'Office document';
  rootEl.innerHTML = officeFallbackHtml(name, label, null, objectUrl);
}

function sheetToHtml(XLSX, sheet) {
  if (!sheet) return '<p><em>(empty sheet)</em></p>';
  try {
    return XLSX.utils.sheet_to_html(sheet, { editable: false });
  } catch (_) {
    return '<p><em>Could not render this sheet.</em></p>';
  }
}

function officeFallbackHtml(name, label, errMsg, objectUrl) {
  return `
    <div class="binary-stub binary-office">
      <div class="binary-stub-icon">📑</div>
      <div class="binary-stub-title">${escapeHtml(name)}</div>
      <p class="binary-stub-msg">${escapeHtml(label)} — in-browser preview is not available for this format.</p>
      ${errMsg ? `<p class="binary-stub-hint">${escapeHtml(errMsg)}</p>` : ''}
      <p class="binary-stub-hint">Use the <b>Download</b> button in the toolbar to save the file and open it in a desktop application.</p>
      ${objectUrl ? `<p class="binary-stub-meta"><a class="binary-open-tab" href="${objectUrl}" target="_blank" rel="noopener">Open in new tab</a></p>` : ''}
    </div>`;
}

/** Load a UMD script once; resolves when globalName is on window. */
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  const existing = document.querySelector(`script[data-binary-lib="${globalName}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      if (window[globalName]) return resolve(window[globalName]);
      existing.addEventListener('load', () => resolve(window[globalName]));
      existing.addEventListener('error', () => reject(new Error('Failed to load ' + globalName)));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.binaryLib = globalName;
    s.onload = () => {
      if (window[globalName]) resolve(window[globalName]);
      else reject(new Error(globalName + ' global missing after load'));
    };
    s.onerror = () => reject(new Error('Failed to load script: ' + src));
    document.head.appendChild(s);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
