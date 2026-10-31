// link-suggest.js
// Pure helpers for links to repository files: the one link format of the app
// (Copy as link and the link suggestions while typing) and the ranking of
// files for a typed query. No DOM, unit-tested in test/link-suggest.test.js.

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
