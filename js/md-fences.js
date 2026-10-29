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

const OPEN_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * @param {string} text
 * @returns {{text: string, code: boolean, start: number}[]}
 */
export function splitByFences(text) {
  const src = String(text ?? '');
  const out = [];
  let fence = null;
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
    if (fence) {
      isCode = true;
      const m = CLOSE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else {
      const m = OPEN_RE.exec(line);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = m[1];
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

/** Same as text.replace(re, replacer), but fenced code blocks are left untouched. */
export function replaceOutsideFences(text, re, replacer) {
  return mapOutsideFences(text, (chunk) => chunk.replace(re, replacer));
}
