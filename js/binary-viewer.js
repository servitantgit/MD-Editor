// binary-viewer.js
// View-only panel for PDF and office files: Source shows a stub,
// Live/Preview show a native PDF embed or an office placeholder + Download.

import { basenameOf, extOf } from './paths.js';
import { kindFromPath } from './file-kind.js';

/** @type {{ path: string, b64: string, objectUrl: string|null, kind: object }|null} */
let current = null;

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
  try {
    const mime = guessBinaryMime(path);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    objectUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.warn('binary-viewer: blob failed', err);
  }
  current = { path, b64, objectUrl, kind };
  rootEl.classList.remove('hidden');
  render(rootEl, layoutMode);
}

/** Hide panel and release the blob URL. */
export function hideBinaryViewer(rootEl) {
  revokeCurrentUrl();
  current = null;
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

function render(rootEl, layoutMode) {
  if (!current) return;
  const { path, objectUrl, kind } = current;
  const name = basenameOf(path);
  const isSource = layoutMode === 'source';
  const isPdf = kind.kind === 'pdf';

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

  // Office (and PDF without blob): informational card + embed attempt is not reliable for private repos
  const label = kind.label || 'Office document';
  rootEl.innerHTML = `
    <div class="binary-stub binary-office">
      <div class="binary-stub-icon">📑</div>
      <div class="binary-stub-title">${escapeHtml(name)}</div>
      <p class="binary-stub-msg">${escapeHtml(label)} — in-browser editing is not available.</p>
      <p class="binary-stub-hint">Use the <b>Download</b> button in the toolbar to save the file and open it in a desktop application (Word, Excel, LibreOffice, etc.).</p>
      ${objectUrl ? `<p class="binary-stub-meta"><a class="binary-open-tab" href="${objectUrl}" target="_blank" rel="noopener">Open in new tab</a> (may not render for this format)</p>` : ''}
    </div>`;
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
