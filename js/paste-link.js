// paste-link.js
// A URL pasted over selected text becomes a markdown link: [text](url).
// Pure (no DOM): editor.js decides when to ask, this decides what to insert.

import { splitByFences, findCodeSpans } from './md-fences.js';

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * @param {{selection: string, clipboardText: string, inCode?: boolean}} p
 * @returns {string|null} the text to insert, or null for a normal paste
 */
export function linkFromPaste({ selection, clipboardText, inCode = false } = {}) {
  if (inCode) return null;
  const sel = String(selection ?? '');
  const url = String(clipboardText ?? '').trim();
  if (!sel.trim() || /[\r\n]/.test(sel) || /[[\]]/.test(sel)) return null;
  if (!URL_RE.test(url) || URL_RE.test(sel.trim())) return null;
  if (/[<>]/.test(url)) return null; // would break the <...> form
  const target = /[()]/.test(url) ? '<' + url + '>' : url;
  return '[' + sel + '](' + target + ')';
}

/** Whether offset (in the whole text) is inside fenced or inline code. */
export function isInsideCode(text, offset) {
  for (const seg of splitByFences(text)) {
    if (offset < seg.start || offset >= seg.start + seg.text.length) continue;
    if (seg.code) return true;
    const rel = offset - seg.start;
    return findCodeSpans(seg.text).some(([s, e]) => rel >= s && rel < e);
  }
  return false;
}
