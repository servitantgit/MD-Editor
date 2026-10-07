// search-index.js
// Pure logic around MiniSearch: build, add, remove, update, query and
// serialize/deserialize an index, plus the snippet/body-cache helpers the UI
// needs. NO DOM, NO network, NO IndexedDB — which is exactly why it can be
// unit-tested in plain Node (see test/search-index.test.js).
//
// MiniSearch itself is injected as a constructor rather than imported: in the
// browser it arrives as the `MiniSearch` global from the jsdelivr <script> tag
// (no bundler in this project), in Node the test passes the npm package.

import { extOf, basenameOf, escapeAttr } from './paths.js';

export const MAX_RESULTS = 50;
export const BODY_CACHE_LIMIT = 200;

/** Characters of context kept before / after the highlighted term. */
export const SNIPPET_BEFORE = 15;
export const SNIPPET_AFTER = 60;

/**
 * Fresh options object on every call — MiniSearch keeps a reference to the
 * options it was built with, and the SAME options must be passed to
 * MiniSearch.loadJSON() to deserialize an index (a documented requirement, not
 * an accident), so both paths must agree exactly.
 */
export function createSearcherOptions() {
  return {
    fields: ['title', 'path', 'body'],
    // body is deliberately NOT stored: it is by far the biggest field and the
    // serialized index is what lands in IndexedDB. Snippets come from the live
    // file body (see createBodyCache), never from the index.
    storeFields: ['path', 'title'],
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' },
  };
}

/** Markdown notes (legacy name kept for callers). */
export function isMarkdownPath(path) {
  return extOf(path) === 'md';
}

/** Text files indexed for full-text search (md, html, plain text, …). */
const SEARCHABLE_EXT = new Set(['md', 'markdown', 'mdown', 'html', 'htm', 'txt', 'text', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash']);
export function isSearchablePath(path) {
  return SEARCHABLE_EXT.has(extOf(path));
}

/** "Notes/Ideas.md" -> "Ideas". Non-markdown names keep their extension. */
export function titleFromPath(path) {
  return basenameOf(path).replace(/\.(md|markdown|mdown)$/i, '');
}

/** The first `# ...` heading, or the file name when the note has none. */
export function extractTitle(path, body) {
  const heading = String(body || '').match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  return heading ? heading[1].trim() : titleFromPath(path);
}
/**
 * Cheap markdown -> plain text. Deliberately a pile of regexes and NOT a real
 * parser (a parser would be a new dependency for a cosmetic gain).
 *
 * Note what is NOT stripped: raw HTML. A note containing "<script>" keeps it,
 * which is precisely why buildSnippet() must escape its output.
 */
export function stripMarkdown(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/~~~[\s\S]*?~~~/g, ' ') // alternative fence
    .replace(/`[^`\n]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images (whole)
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: keep the text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s{0,3}>{1,}\s?/gm, '') // block quotes
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '') // list bullets
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/[*_~]{1,3}/g, '') // emphasis
    .replace(/\|/g, ' ') // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

/** The individual words of a query, in order. */
export function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Indexes a raw markdown file. `body` is the decoded UTF-8 file contents. */
export function buildDocument(path, body) {
  return {
    id: path,
    path,
    title: extractTitle(path, body),
    body: stripMarkdown(body),
  };
}

function findFirstTerm(text, terms) {
  const lower = text.toLowerCase();
  let best = null;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index === -1) continue;
    if (!best || index < best.index || (index === best.index && term.length > best.length)) {
      best = { index, length: term.length };
    }
  }
  return best;
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * A one-line snippet around the first matched query term, with the term wrapped
 * in <mark>. Everything around it goes through escapeAttr() — a note body is
 * untrusted input, and the UI assigns the result to innerHTML.
 */
export function buildSnippet(body, query, { before = SNIPPET_BEFORE, after = SNIPPET_AFTER } = {}) {
  const text = normalizeWhitespace(stripMarkdown(body));
  if (!text) return '';

  const hit = findFirstTerm(text, queryTerms(query));
  if (!hit) return escapeAttr(text.slice(0, before + after));

  const start = Math.max(0, hit.index - before);
  const end = Math.min(text.length, hit.index + hit.length + after);
  const lead = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return (
    lead +
    escapeAttr(text.slice(start, hit.index)) +
    '<mark>' + escapeAttr(text.slice(hit.index, hit.index + hit.length)) + '</mark>' +
    escapeAttr(text.slice(hit.index + hit.length, end)) +
    tail
  );
}

/**
 * Bounded LRU cache of raw file bodies, used for snippet generation.
 *
 * The body is deliberately kept OUT of the index (the index would balloon), so
 * this cache is the fast path for snippets; anything missing is fetched lazily
 * by the UI. A Map preserves insertion order, which is all an LRU needs here.
 */
export function createBodyCache(limit = BODY_CACHE_LIMIT) {
  const map = new Map();
  return {
    get(path) {
      if (!map.has(path)) return undefined;
      const value = map.get(path);
      map.delete(path); // re-insert -> most recently used ends up last
      map.set(path, value);
      return value;
    },
    set(path, body) {
      if (map.has(path)) map.delete(path);
      map.set(path, body);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    has: (path) => map.has(path),
    get size() { return map.size; },
    delete: (path) => map.delete(path),
    clear: () => map.clear(),
  };
}

/** Everything the UI needs from one search hit, in a plain object. */
function toResult(hit) {
  return { path: hit.path, title: hit.title, score: hit.score };
}

/**
 * Splits a fresh getTree() result against the stored manifest.
 * @returns {{added: string[], removed: string[], changed: string[]}}
 */
export function diffTree(tree, manifest = {}) {
  const added = [];
  const changed = [];
  const seen = new Set();
  for (const { path, sha } of tree) {
    seen.add(path);
    const known = manifest[path];
    if (known === undefined) added.push(path);
    else if (known !== sha) changed.push(path);
  }
  const removed = Object.keys(manifest).filter((path) => !seen.has(path));
  return { added, removed, changed };
}

/**
 * Thin, testable wrapper around one MiniSearch instance.
 *
 * Note `removeDocument()`: we only store 'path' and 'title', so the full
 * document MiniSearch.remove() demands is NOT available. discard() takes the
 * ID alone and is documented as having "the same visible effect", with
 * MiniSearch's own auto-vacuuming cleaning the inverted index up afterwards.
 * Calling remove() with a reconstructed body would corrupt the index.
 */
export class SearchIndex {
  constructor(MiniSearchCtor, { serialized = null } = {}) {
    this.MiniSearchCtor = MiniSearchCtor;
    this.bodyCache = createBodyCache();
    this.searcher = serialized
      ? MiniSearchCtor.loadJSON(serialized, createSearcherOptions())
      : new MiniSearchCtor(createSearcherOptions());
  }

  get size() { return this.searcher.documentCount; }

  has(path) { return this.searcher.has(path); }

  /** Indexes (or re-indexes) one markdown file. */
  add(path, body) {
    if (this.searcher.has(path)) this.removeDocument(path);
    this.searcher.add(buildDocument(path, body));
    this.bodyCache.set(path, body);
  }

  addAll(entries) {
    entries.forEach((entry) => this.add(entry.path, entry.body));
  }

  /** Drops a file from the index and from the body cache. */
  removeDocument(path) {
    if (this.searcher.has(path)) this.searcher.discard(path);
    this.bodyCache.delete(path);
  }

  updateDocument(path, body) {
    this.removeDocument(path);
    this.add(path, body);
  }

  /**
   * @returns {Array<{path: string, title: string, score: number}>} ordered by
   *   MiniSearch score, capped at MAX_RESULTS.
   */
  query(text, { limit = MAX_RESULTS } = {}) {
    if (!String(text || '').trim()) return [];
    return this.searcher.search(text).slice(0, limit).map(toResult);
  }

  clear() {
    this.searcher.removeAll();
    this.bodyCache.clear();
  }

  /** JSON string, ready to be handed to the IndexedDB store as-is. */
  serialize() {
    return JSON.stringify(this.searcher.toJSON());
  }
}

/**
 * Deserializes a stored index. A corrupt/unreadable blob degrades to an empty
 * index instead of throwing — the sync then just rebuilds from the tree.
 */
export function createSearchIndex(MiniSearchCtor, serialized = null) {
  if (serialized) {
    try {
      return new SearchIndex(MiniSearchCtor, { serialized });
    } catch (_) { /* fall through to an empty index */ }
  }
  return new SearchIndex(MiniSearchCtor);
}