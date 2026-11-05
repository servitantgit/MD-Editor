// search-matches.js
// Source ranges for actual MiniSearch tokens. No DOM, storage or scrolling.
// Indexing is unchanged; see AGENTS.md for the agreed parsing limitations.
import { isMarkdownPath } from './file-kind.js';
import { splitByFences, findCodeSpans } from './md-fences.js';
import { REF_TOKEN_RE, classifyRefMatch } from './markdown-tokens.js';

function excludedRanges(text, path) {
  if (!isMarkdownPath(path)) return [];
  const ranges = [];
  for (const segment of splitByFences(text)) {
    const base = segment.start;
    if (segment.code) {
      ranges.push([base, base + segment.text.length]);
      continue;
    }
    const spans = findCodeSpans(segment.text);
    for (const [from, to] of spans) ranges.push([base + from, base + to]);

    // Capture indices locate destinations even when the same word is in
    // the label. Never find a target by searching for its text in the token.
    const flags = REF_TOKEN_RE.flags.includes('d')
      ? REF_TOKEN_RE.flags : REF_TOKEN_RE.flags + 'd';
    const re = new RegExp(REF_TOKEN_RE.source, flags);
    for (const match of segment.text.matchAll(re)) {
      if (spans.some(([from, to]) => match.index >= from && match.index < to)) {
        continue;
      }
      const parsed = classifyRefMatch(...Array.from(match));
      if (parsed.kind === 'img-md') {
        ranges.push([base + match.index, base + match.index + match[0].length]);
      } else if (parsed.kind === 'link-md') {
        ranges.push([
          base + match.indices[4][1],
          base + match.index + match[0].length
        ]);
      }
      // Raw HTML remains searchable under the current index contract.
      // Unsupported/reference-style forms are not parsed by a second regex.
    }
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * Returns UTF-16 source offsets, with each token's original text.
 * tokenize/processTerm must be the same functions used by MiniSearch.
 * Tokenization must return original substrings in source order.
 */
export function findSearchMatches(text, { path, terms, tokenize, processTerm }) {
  const source = String(text ?? '');
  if (typeof tokenize !== 'function' || typeof processTerm !== 'function') {
    throw new Error('findSearchMatches: tokenizer and term processor required');
  }
  const wanted = new Set((terms || []).filter((term) =>
    typeof term === 'string' && term.length > 0));
  if (!source || !wanted.size) return [];

  const blocked = excludedRanges(source, path);
  const result = [];
  let cursor = 0;
  let blockIndex = 0;

  for (const token of tokenize(source)) {
    if (typeof token !== 'string') {
      throw new Error('findSearchMatches: tokenizer returned a non-string');
    }
    if (!token) continue;
    const from = source.indexOf(token, cursor);
    if (from < 0) {
      throw new Error('findSearchMatches: token is not an original substring');
    }
    const to = from + token.length;
    cursor = to;

    while (blockIndex < blocked.length && blocked[blockIndex][1] <= from) {
      blockIndex++;
    }
    const block = blocked[blockIndex];
    if (block && from < block[1] && to > block[0]) continue;

    const processed = processTerm(token);
    const candidates = Array.isArray(processed) ? processed : [processed];
    const term = candidates.find((candidate) => wanted.has(candidate));
    if (term !== undefined) {
      result.push({ from, to, text: token, term });
    }
  }
  return result;
}

/** Longest original token by code points; equal length selects earliest offset. */
export function chooseInitialMatch(matches) {
  let best = -1;
  let length = -1;
  for (let i = 0; i < matches.length; i++) {
    const size = Array.from(matches[i].text).length;
    if (size > length || (size === length &&
        (best < 0 || matches[i].from < matches[best].from))) {
      best = i;
      length = size;
    }
  }
  return best;
}
