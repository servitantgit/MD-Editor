// link-suggest.js
// Pure helpers for links to repository files: the one link format of the app
// (Copy as link and the link suggestions while typing) and the ranking of
// files for a typed query (pure), plus createLinkSuggest(), the popup shown
// while typing [[ in the editor. Unit-tested in test/link-suggest.test.js.

import { basenameOf } from './paths.js';

/**
 * A repo-root absolute markdown link: [name](/path). The display name drops
 * .md; other files keep their extension (images, html, code).
 *
 * Root-absolute because the link is pasted into a note in another folder; the
 * editor, the reference rewriter and GitHub all resolve /path from the root.
 * DO NOT percent-encode: marked encodes the URL once at HTML serialization, so
 * a pre-encoded %20 would come back as %25 on the way to GitHub (a 404).
 * A space or a parenthesis would end the link, so such a URL goes in <...>,
 * the standard markdown escape; marked strips the brackets.
 * @param {string} path
 * @returns {string}
 */
export function buildFileLink(path) {
  const clean = String(path || '').replace(/^\/+/, '');
  const name = basenameOf(clean).replace(/\.md$/i, '');
  const url = '/' + clean;
  return '[' + name + '](' + (/[()\s]/.test(url) ? '<' + url + '>' : url) + ')';
}

/**
 * Files matching a typed query, best first. Case-insensitive. Groups: the file
 * name starts with the query, the name contains it, only the path contains it.
 * Within a group: .md files first, then the shorter path, then alphabetical.
 * An empty query lists every file in the same order. Files without a match
 * are dropped.
 * @param {Array<string|{path: string}>} files
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function rankLinkSuggestions(files, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  const ranked = [];
  for (const f of files || []) {
    const path = typeof f === 'string' ? f : f && f.path;
    if (typeof path !== 'string' || !path) continue;
    const name = basenameOf(path).toLowerCase();
    let group;
    if (!q || name.startsWith(q)) group = 0;
    else if (name.includes(q)) group = 1;
    else if (path.toLowerCase().includes(q)) group = 2;
    else continue;
    ranked.push({ path, group, md: /\.md$/i.test(path) ? 0 : 1 });
  }
  ranked.sort((a, b) =>
    a.group - b.group ||
    a.md - b.md ||
    a.path.length - b.path.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.path);
}

/**
 * The popup shown while typing [[ in CodeMirror. The text from the last [[ up
 * to the cursor is the query, the notes are ranked by rankLinkSuggestions(),
 * and Enter/Tab (or a click) replaces [[query with buildFileLink(path).
 * Up/Down/Enter/Tab/Esc are taken over only while the popup is open (a key map
 * added on open and removed on close), so Enter keeps continuing lists the rest
 * of the time. Esc closes it for that [[ until the cursor leaves it.
 * @param {object} cm CodeMirror 5 instance
 * @param {{getFiles: () => Array<string|{path: string}>, document?: Document, limit?: number}} opts
 * @returns {{close: () => void, destroy: () => void}}
 */
export function createLinkSuggest(cm, opts = {}) {
  const getFiles = typeof opts.getFiles === 'function' ? opts.getFiles : () => [];
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const limit = opts.limit || 8;
  let menu = null;
  let items = [];
  let active = 0;
  let dismissed = null;
  let destroyed = false;

  // The open [[ before the cursor, or null. A [ or ] in the query means the
  // link is already closed or is something else.
  function current() {
    const cur = cm.getCursor();
    const before = String(cm.getLine(cur.line) || '').slice(0, cur.ch);
    const start = before.lastIndexOf('[[');
    if (start < 0) return null;
    const query = before.slice(start + 2);
    if (/[\[\]]/.test(query)) return null;
    return { line: cur.line, start, ch: cur.ch, query };
  }

  const keyMap = {
    Up: () => move(-1),
    Down: () => move(1),
    Enter: () => pick(active),
    Tab: () => pick(active),
    Esc: () => dismiss(),
  };

  function update() {
    if (destroyed) return;
    const q = current();
    if (!q) { dismissed = null; close(); return; }
    if (dismissed && dismissed.line === q.line && dismissed.start === q.start) { close(); return; }
    dismissed = null;
    const paths = rankLinkSuggestions(getFiles() || [], q.query, limit);
    if (!paths.length) { close(); return; }
    items = paths;
    active = 0;
    render();
  }

  function render() {
    if (!doc || !doc.body) return;
    if (!menu) {
      menu = doc.createElement('div');
      menu.className = 'folder-context-menu link-suggest-menu';
      menu.addEventListener('mousedown', onMouseDown);
      doc.body.appendChild(menu);
      cm.addKeyMap(keyMap);
    }
    menu.textContent = '';
    items.forEach((path, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'link-suggest-item' + (i === active ? ' active' : '');
      b.dataset.path = path;
      const name = doc.createElement('span');
      name.className = 'link-suggest-name';
      name.textContent = basenameOf(path);
      const where = doc.createElement('span');
      where.className = 'link-suggest-path';
      where.textContent = path;
      b.append(name, where);
      menu.appendChild(b);
    });
    place();
  }

  function place() {
    let c = null;
    try { c = cm.cursorCoords(true, 'window'); } catch (_) { /* no layout */ }
    if (!c || !menu) return;
    menu.style.position = 'fixed';
    menu.style.left = Math.round(c.left) + 'px';
    menu.style.top = Math.round(c.bottom + 2) + 'px';
    const win = doc.defaultView;
    const rect = menu.getBoundingClientRect();
    if (win && rect.bottom > win.innerHeight) menu.style.top = Math.max(0, Math.round(c.top - rect.height - 2)) + 'px';
    if (win && rect.right > win.innerWidth) menu.style.left = Math.max(0, Math.round(win.innerWidth - rect.width - 4)) + 'px';
  }

  function move(step) {
    if (!menu || !items.length) return;
    active = (active + step + items.length) % items.length;
    Array.from(menu.children).forEach((b, i) => b.classList.toggle('active', i === active));
    const el = menu.children[active];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    const q = current();
    const path = items[index];
    close();
    if (!q || !path) return;
    const insert = () => cm.replaceRange(buildFileLink(path), { line: q.line, ch: q.start }, { line: q.line, ch: q.ch });
    if (typeof cm.operation === 'function') cm.operation(insert); else insert();
    if (typeof cm.focus === 'function') cm.focus();
  }

  function dismiss() {
    const q = current();
    dismissed = q ? { line: q.line, start: q.start } : null;
    close();
  }

  function onMouseDown(e) {
    // Keep the focus (and the cursor) in the editor while clicking an item.
    e.preventDefault();
    const b = e.target && e.target.closest ? e.target.closest('.link-suggest-item') : null;
    if (!b || !menu) return;
    pick(Array.prototype.indexOf.call(menu.children, b));
  }

  function close() {
    if (menu) {
      menu.removeEventListener('mousedown', onMouseDown);
      menu.remove();
      menu = null;
      try { cm.removeKeyMap(keyMap); } catch (_) { /* editor already gone */ }
    }
    items = [];
    active = 0;
  }

  function onBlur() { close(); }

  cm.on('cursorActivity', update);
  cm.on('blur', onBlur);

  return {
    close,
    destroy() {
      destroyed = true;
      close();
      try {
        cm.off('cursorActivity', update);
        cm.off('blur', onBlur);
      } catch (_) { /* editor already gone */ }
    },
  };
}
