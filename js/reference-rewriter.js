// reference-rewriter.js
// Pure link-recalculation logic for file moves. No fetch() —
// takes file text, returns new text. The network part (who to read/write)
// is done by file-mover.js, which uses these functions.

import {
  basenameOf,
  dirnameOf,
  resolveRelativePath,
  relativePathFromTo,
  encodeLinkPath,
  decodeUriSafe,
  isExternalOrAnchor,
} from './paths.js';
import { REF_TOKEN_RE, classifyRefMatch, rebuildRefToken } from './markdown-tokens.js';
import { replaceOutsideFences } from './md-fences.js';

/**
 * The file ITSELF moves from oldDir to newDir: recalculates its OWN relative
 * links so they still point at the same targets (style stays
 * relative — the way other notes in the repo are already written).
 * Root ("/...") and external links are left untouched.
 */
export function rewriteOwnRelativeLinks(text, oldDir, newDir) {
  if (oldDir === newDir) return text;
  return replaceOutsideFences(text, REF_TOKEN_RE, (full, g1, g2, g3, g4, g5, g6) => {
    const parsed = classifyRefMatch(full, g1, g2, g3, g4, g5, g6);
    const target = parsed.target;
    if (isExternalOrAnchor(target) || target.startsWith('/')) return full;

    const decoded = decodeUriSafe(target);
    const resolvedAbs = resolveRelativePath(oldDir, decoded);
    const rel = relativePathFromTo(newDir, resolvedAbs);
    // A link in <...> keeps a plain path (as buildFileLink writes it); any other
    // form is percent-encoded, as before.
    const newRel = parsed.angle ? rel : encodeLinkPath(rel);
    return rebuildRefToken(parsed, newRel, full);
  });
}

/**
 * Checks/rewrites in the text of ANOTHER file (located in fileDir) all links
 * that actually point at oldPath — both relative and root-relative — to newPath.
 * Returns {changed, text}.
 */
export function updateReferencesInFile(text, fileDir, oldPath, newPath, options = {}) {
  let changed = false;
  const newText = replaceOutsideFences(text, REF_TOKEN_RE, (full, g1, g2, g3, g4, g5, g6) => {
    const parsed = classifyRefMatch(full, g1, g2, g3, g4, g5, g6);
    const target = parsed.target;
    if (isExternalOrAnchor(target)) return full;

    const decoded = decodeUriSafe(target);
    const isAbsoluteStyle = decoded.startsWith('/');
    const resolved = isAbsoluteStyle ? decoded.slice(1) : resolveRelativePath(fileDir, decoded);
    if (resolved !== oldPath) return full;

    changed = true;
    // A link in <...> keeps a plain path (as buildFileLink writes it); any other
    // form is percent-encoded, as before.
    const enc = parsed.angle ? (p) => p : encodeLinkPath;
    const newTarget = isAbsoluteStyle
      ? '/' + enc(newPath)
      : enc(relativePathFromTo(fileDir, newPath));
    return rebuildRefToken(parsed, newTarget, full);
  });
  const wiki = rewriteWikiLinks(newText, fileDir, oldPath, newPath, options);
  return { changed: changed || wiki.changed, text: wiki.text };
}

const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/**
 * [[wiki links]] in ANOTHER note that point at oldPath -> newPath. Same rules
 * as backlinks.js (Obsidian): [[./x]] / [[../x]] from the note folder, any
 * other path ([[A/x]], [[/A/x]]) from the repository root, a bare name ([[x]])
 * only when options.wikiName (the caller knows the name changed and the old
 * name is unique). The written form is kept: .md or not, a leading slash,
 * #heading, |alias, the ! of an embed. Code spans and fences are skipped.
 */
function rewriteWikiLinks(text, fileDir, oldPath, newPath, options) {
  let changed = false;
  const newNoExt = newPath.replace(/\.md$/i, '');
  const pick = (p) => (p === oldPath ? newPath : (p + '.md' === oldPath ? newNoExt : null));
  const out = replaceOutsideFences(text, WIKI_RE, (full, inner) => {
    const pipe = inner.indexOf('|');
    const head = pipe < 0 ? inner : inner.slice(0, pipe);
    const alias = pipe < 0 ? '' : inner.slice(pipe);
    const hash = head.indexOf('#');
    const target = hash < 0 ? head : head.slice(0, hash);
    const heading = hash < 0 ? '' : head.slice(hash);
    const t = target.trim();
    if (!t || /^(https?:|mailto:)/i.test(t)) return full;
    let next = null;
    if (/^\.\.?\//.test(t)) {
      const hit = pick(resolveRelativePath(fileDir, t));
      if (hit !== null) {
        next = relativePathFromTo(fileDir, hit);
        if (!next.startsWith('.')) next = './' + next; // stay relative, never turn into a bare name
      }
    } else if (t.includes('/')) {
      const lead = t.startsWith('/') ? '/' : '';
      const hit = pick(t.slice(lead.length));
      if (hit !== null) next = lead + hit;
    } else if (options && options.wikiName) {
      const oldBase = basenameOf(oldPath);
      if (t === oldBase) next = basenameOf(newPath);
      else if (t + '.md' === oldBase) next = basenameOf(newPath).replace(/\.md$/i, '');
    }
    if (next === null || next === t) return full;
    changed = true;
    return '[[' + target.replace(t, () => next) + heading + alias + ']]';
  });
  return { changed, text: out };
}

/** Convenience helper: dirname of the new path when renaming/moving a file. */
export function dirOf(path) {
  return dirnameOf(path);
}
