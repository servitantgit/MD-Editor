// backlinks.js
// Reverse link index for a Markdown knowledge base.
// Forward links are parsed from note bodies; the panel shows who links HERE.
//
// Supported targets (v1):
//   - [label](relative/or/root.md)  and  [label](/Notes/x.md)
//   - [[wikilink]] / [[path/to/note]] / [[note|alias]]  (resolved loosely)
// Skips http(s), mailto, anchors-only, images ![…](…).

import { dirnameOf, resolveRelativePath } from './paths.js';

/** Markdown inline link, not an image. Captures the href. */
const MD_LINK_RE = /(!)?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Obsidian-style wikilinks: [[target]] or [[target|alias]]. */
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isInternalNoteHref(href) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#') || h.startsWith('?')) return false;
  if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(h)) return false;
  // Pure image targets are not "note" backlinks.
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf)$/i.test(h.split('#')[0].split('?')[0])) {
    return false;
  }
  return true;
}

/**
 * Strip hash/query and leading slash; keep repo-relative form.
 * @param {string} href
 */
export function stripHrefDecorations(href) {
  let h = String(href || '').trim();
  h = h.split('#')[0].split('?')[0].trim();
  if (h.startsWith('/')) h = h.slice(1);
  return h;
}

/**
 * Resolve a link as written in `fromPath` to a repo-rooted path (no leading /).
 * @param {string} fromPath
 * @param {string} href
 */
export function resolveNoteLink(fromPath, href) {
  const raw = String(href || '').trim();
  // Leading "/" means repo-root absolute (common in some vaults).
  const fromRoot = raw.startsWith('/');
  const cleaned = stripHrefDecorations(href);
  if (!cleaned) return '';
  if (fromRoot) return cleaned;
  const base = dirnameOf(fromPath || '');
  try {
    return resolveRelativePath(base, cleaned);
  } catch (_) {
    return cleaned;
  }
}

/**
 * Extract outgoing internal targets from a markdown body.
 * @param {string} fromPath
 * @param {string} body
 * @returns {string[]} unique repo-rooted paths (may lack .md; matcher handles it)
 */
export function extractOutgoingLinks(fromPath, body) {
  const text = String(body || '');
  const out = new Set();

  MD_LINK_RE.lastIndex = 0;
  let m;
  while ((m = MD_LINK_RE.exec(text))) {
    if (m[1] === '!') continue; // image
    const href = m[3];
    if (!isInternalNoteHref(href)) continue;
    const abs = resolveNoteLink(fromPath, href);
    if (abs) out.add(abs);
  }

  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(text))) {
    let target = (m[1] || '').split('|')[0].trim();
    if (!target) continue;
    // Wikilinks rarely use extensions; leave as-is for fuzzy match.
    if (/^(https?:|mailto:)/i.test(target)) continue;
    const abs = resolveNoteLink(fromPath, target);
    if (abs) out.add(abs);
  }

  return [...out];
}

/**
 * Whether a stored link target refers to `currentPath`.
 * Handles missing .md, basename-only wikilinks, and exact paths.
 * @param {string} linkTarget
 * @param {string} currentPath
 */
export function linkMatchesPath(linkTarget, currentPath) {
  const t = String(linkTarget || '').replace(/\\/g, '/');
  const p = String(currentPath || '').replace(/\\/g, '/');
  if (!t || !p) return false;
  if (t === p) return true;

  const pNoExt = p.replace(/\.md$/i, '');
  const tNoExt = t.replace(/\.md$/i, '');
  if (tNoExt === pNoExt) return true;
  if (t === pNoExt || tNoExt === p) return true;

  // Basename wikilink: [[Printer jam]] → printer-jam.md / Printer jam.md
  const base = p.split('/').pop() || '';
  const baseNoExt = base.replace(/\.md$/i, '');
  if (t === base || t === baseNoExt || tNoExt === baseNoExt) return true;

  // Case-insensitive basename match (Windows-ish vaults)
  if (tNoExt.toLowerCase() === baseNoExt.toLowerCase()) return true;
  if (tNoExt.toLowerCase() === pNoExt.toLowerCase()) return true;

  return false;
}

/**
 * Mutable reverse index: targetPath → Set<sourcePath>
 * We store under the exact outgoing strings and query by matching.
 */
export function createBacklinkIndex() {
  /** @type {Map<string, Set<string>>} source → outgoing targets */
  const forward = new Map();

  return {
    /** Replace outgoing links for one source file. */
    setFile(sourcePath, body) {
      if (!sourcePath) return;
      // Knowledge-base edges come from notes only.
      if (!/\.(md|markdown|mdown)$/i.test(sourcePath)) {
        this.removeFile(sourcePath);
        return;
      }
      const links = extractOutgoingLinks(sourcePath, body);
      forward.set(sourcePath, new Set(links));
    },

    removeFile(sourcePath) {
      forward.delete(sourcePath);
    },

    clear() {
      forward.clear();
    },

    /** @returns {string[]} sources that link to currentPath, sorted */
    getBacklinks(currentPath) {
      if (!currentPath) return [];
      const sources = [];
      for (const [source, targets] of forward) {
        if (source === currentPath) continue;
        for (const t of targets) {
          if (linkMatchesPath(t, currentPath)) {
            sources.push(source);
            break;
          }
        }
      }
      sources.sort((a, b) => a.localeCompare(b));
      return sources;
    },

    get size() {
      return forward.size;
    },

    /** Test helper */
    _forward() {
      return forward;
    },
  };
}
