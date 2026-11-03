// image-audit.js
// Pure image audit of a repository: which pictures no note links to, which
// links point at a missing picture, which pictures are byte-identical (same
// blob sha). No network, no DOM: the caller passes the tree and the texts
// (tools/image-audit.mjs reads them from git HEAD).
// Link rules are the reference rewriter's (AGENTS.md Architecture rules 3, 7):
// REF_TOKEN_RE outside fences and code spans, external targets skipped, the
// target decoded once, "/x" from the repo root, anything else from the folder
// of the note, exact (case-sensitive) match against the tree.
// Fail-safe: an unread note, a wiki image link or an HTML file pointing at a
// picture makes the report invalid, and an invalid report lists NO unused
// pictures, so nothing can be offered for deletion by mistake.

import { REF_TOKEN_RE, classifyRefMatch } from './markdown-tokens.js';
import { splitByFences, findCodeSpans } from './md-fences.js';
import { dirnameOf, resolveRelativePath, decodeUriSafe, isExternalOrAnchor, isImagePath } from './paths.js';

const DOC_RE = /\.(md|html?)$/i;
const HTML_RE = /\.html?$/i;
const WIKI_RE = /(!?)\[\[([^\]]+)\]\]/g;
const HTML_REF_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/** Calls onChunk(text, codeSpans) for every part of text outside fenced code. */
function outsideFences(text, onChunk) {
  for (const seg of splitByFences(String(text))) {
    if (seg.code) continue;
    onChunk(seg.text, findCodeSpans(seg.text));
  }
}

const inSpan = (spans, i) => spans.some(([s, e]) => i >= s && i < e);
const isRepoTarget = (t) => Boolean(t) && !isExternalOrAnchor(t) && !t.startsWith('//');

/** ![[x]] or [[x.png]] outside code: a link form the audit does not resolve. */
function hasWikiImageLink(text) {
  let found = false;
  outsideFences(text, (chunk, spans) => {
    const re = new RegExp(WIKI_RE.source, 'g');
    let m;
    while (!found && (m = re.exec(chunk)) !== null) {
      if (inSpan(spans, m.index)) continue;
      const target = m[2].split('|')[0].split('#')[0].trim();
      if (m[1] === '!' || isImagePath(target)) found = true;
    }
  });
  return found;
}

/** src= / href= in an HTML file that points at a repo picture (data: and external ignored). */
function hasHtmlImageRef(text) {
  const re = new RegExp(HTML_REF_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    if (/^data:/i.test(v) || !isRepoTarget(v)) continue;
    if (isImagePath(decodeUriSafe(v.split('#')[0].split('?')[0]))) return true;
  }
  return false;
}

/**
 * @param {{ files: Array<{path: string, sha: string}>, texts: Map<string, string|null> }} input
 *   files: every blob of the tree; texts: content of every .md / .html file (null = not read)
 * @returns {{ valid: boolean, reasons: string[], used: Map<string, number>, unused: string[],
 *   broken: Array<{from: string, target: string, caseHint: string|null}>,
 *   duplicates: Array<{sha: string, paths: string[], usedCount: number}> }}
 */
export function auditImages({ files, texts } = {}) {
  const list = Array.isArray(files) ? files : [];
  const paths = new Set(list.map((x) => x.path));
  const byLower = new Map();
  for (const p of paths) byLower.set(p.toLowerCase(), p);

  const reasons = [];
  const used = new Map();
  const broken = [];

  for (const doc of list) {
    if (!DOC_RE.test(doc.path)) continue;
    const text = texts && typeof texts.get === 'function' ? texts.get(doc.path) : undefined;
    if (typeof text !== 'string' || text.includes('\uFFFD')) {
      reasons.push('unread: ' + doc.path);
      continue;
    }
    if (HTML_RE.test(doc.path)) {
      if (hasHtmlImageRef(text)) reasons.push('html image ref: ' + doc.path);
      continue;
    }
    if (hasWikiImageLink(text)) reasons.push('wiki image link: ' + doc.path);

    const dir = dirnameOf(doc.path);
    outsideFences(text, (chunk, spans) => {
      const re = new RegExp(REF_TOKEN_RE.source, 'g');
      let m;
      while ((m = re.exec(chunk)) !== null) {
        if (inSpan(spans, m.index)) continue;
        const target = classifyRefMatch(m[0], m[1], m[2], m[3], m[4], m[5], m[6]).target || '';
        if (!isRepoTarget(target)) continue;
        const dec = decodeUriSafe(target);
        const path = dec.startsWith('/') ? dec.slice(1) : resolveRelativePath(dir, dec);
        if (!isImagePath(path)) continue;
        if (paths.has(path)) used.set(path, (used.get(path) || 0) + 1);
        else broken.push({ from: doc.path, target: path, caseHint: byLower.get(path.toLowerCase()) || null });
      }
    });
  }

  const images = list.filter((x) => isImagePath(x.path));
  const bySha = new Map();
  for (const img of images) {
    if (!bySha.has(img.sha)) bySha.set(img.sha, []);
    bySha.get(img.sha).push(img.path);
  }
  const duplicates = [...bySha.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sha, group]) => {
      const sorted = [...group].sort();
      return { sha, paths: sorted, usedCount: sorted.filter((p) => used.has(p)).length };
    })
    .sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));

  const valid = reasons.length === 0;
  const unused = valid ? images.map((x) => x.path).filter((p) => !used.has(p)).sort() : [];
  return { valid, reasons, used, unused, broken, duplicates };
}
