// md-fences.js
// Splits markdown text into fenced-code and non-code segments so that
// link/image rewriting can skip code blocks. Joining all segment texts
// gives the input back byte-for-byte (CRLF preserved).
//
// Rules (CommonMark-like, deliberately lenient on indentation):
// * opening fence: any indentation, then ``` or ~~~ (3 or more); for a
//   backtick fence the rest of the line must not contain a backtick
//   (otherwise it is inline code such as ```x```);
// * closing fence: same character, at least as long as the opening one,
//   followed only by spaces/tabs;
// * an unclosed fence runs to the end of the text;
// * fence lines themselves belong to the code segment.
// * a fence may sit inside a blockquote ("> ```"); it is closed by a fence at
//   the same quote depth, or when the quote ends (fewer '>' or a blank line).
// findCodeSpans() finds inline code (`x`, ``x``); replaceOutsideFences() also
// skips every match that starts inside inline code.

const OPEN_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const QUOTE_RE = /^[ \t]*>[ \t]?/;

/** Strips blockquote markers: "> > x" -> { depth: 2, rest: "x" }. */
function unquote(line) {
  let depth = 0;
  let rest = line;
  let m;
  while ((m = QUOTE_RE.exec(rest)) !== null) {
    depth++;
    rest = rest.slice(m[0].length);
  }
  return { depth, rest };
}

/**
 * @param {string} text
 * @returns {{text: string, code: boolean, start: number}[]}
 */
export function splitByFences(text) {
  const src = String(text ?? '');
  const out = [];
  let fence = null;
  let fenceDepth = 0;
  let pos = 0;
  let buf = '';
  let bufStart = 0;
  let bufCode = false;
  const flush = () => {
    if (buf) out.push({ text: buf, code: bufCode, start: bufStart });
    buf = '';
  };
  for (const raw of src.split(/(?<=\n)/)) {
    const line = raw.replace(/\n$/, '').replace(/\r$/, '');
    let isCode = false;
    const q = unquote(line);
    // The quote that held the fence has ended, and so has the fence.
    if (fence && q.depth < fenceDepth) fence = null;
    if (fence) {
      isCode = true;
      const m = q.depth === fenceDepth ? CLOSE_RE.exec(q.rest) : null;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else {
      const m = OPEN_RE.exec(q.rest);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = m[1];
        fenceDepth = q.depth;
        isCode = true;
      }
    }
    if (isCode !== bufCode) {
      flush();
      bufCode = isCode;
      bufStart = pos;
    }
    buf += raw;
    pos += raw.length;
  }
  flush();
  return out;
}

/** Returns text where fn(segmentText, segmentStart) is applied to non-code segments only. */
export function mapOutsideFences(text, fn) {
  return splitByFences(text)
    .map((s) => (s.code ? s.text : fn(s.text, s.start)))
    .join('');
}

/**
 * Inline code spans as [start, end) offsets.
 * A run of N backticks is closed by the next run of exactly N backticks;
 * an unmatched run is literal text, and a span never crosses a blank line.
 * Backslash-escaped backticks are not special-cased.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function findCodeSpans(text) {
  const src = String(text ?? '');
  const spans = [];
  const runRe = /`+/g;
  let m;
  while ((m = runRe.exec(src)) !== null) {
    const len = m[0].length;
    const from = m.index + len;
    const closeRe = /`+/g;
    closeRe.lastIndex = from;
    let c;
    let end = -1;
    while ((c = closeRe.exec(src)) !== null) {
      if (c[0].length === len) {
        end = c.index + len;
        break;
      }
    }
    if (end < 0) continue;
    if (/\n[ \t]*\r?\n/.test(src.slice(from, end - len))) continue;
    spans.push([m.index, end]);
    runRe.lastIndex = end;
  }
  return spans;
}

/**
 * Same as text.replace(re, replacer), but fenced code blocks are left untouched,
 * and so is every match that STARTS inside inline code. A link whose text holds
 * code, such as [`a.md`](a.md), starts outside it and is still replaced.
 */
export function replaceOutsideFences(text, re, replacer) {
  return mapOutsideFences(text, (chunk) => {
    const spans = findCodeSpans(chunk);
    if (!spans.length) return chunk.replace(re, replacer);
    return chunk.replace(re, (...args) => {
      // replace() passes (match, ...groups, offset, string[, namedGroups]).
      const last = args[args.length - 1];
      const offset = args[args.length - (typeof last === 'object' && last !== null ? 3 : 2)];
      if (spans.some(([s, e]) => offset >= s && offset < e)) return args[0];
      return replacer(...args);
    });
  });
}
