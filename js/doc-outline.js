// doc-outline.js
// Pure heading parser for the document outline panel (no DOM, unit-testable).
// CommonMark ATX headings: up to 3 leading spaces, 1-6 #'s, then a space/tab
// (or end of line), optional closing sequence of #'s preceded by a space.
//
// Deliberately skips:
// * fenced code blocks (``` or ~~~) — a "# comment" inside code is not a heading;
// * indented code (>= 4 spaces);
// * the trailing '#' of titles like "C#" (only a space-prefixed closing run counts).
// Fences are recognised by md-fences.js, the same rules the rest of the app
// uses (a ```js line does not close a block, inline ```x``` does not open one).

import { splitByFences } from './md-fences.js';

export function parseHeadingOutline(text) {
  const src = String(text || '');
  const lines = src.split('\n');
  const inFence = new Array(lines.length).fill(false);
  let lineNo = 0;
  for (const seg of splitByFences(src)) {
    const count = (seg.text.match(/\n/g) || []).length + (seg.text.endsWith('\n') ? 0 : 1);
    if (seg.code) for (let i = lineNo; i < lineNo + count; i++) inFence[i] = true;
    lineNo += count;
  }
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const line = lines[i];
    // ATX heading: up to 3 leading spaces, 1-6 #'s, then space/tab or EOL.
    // "#Title" (no space) is NOT a heading per CommonMark.
    const m = /^[ \t]{0,3}(#{1,6})([ \t]*)(.*)$/.exec(line);
    if (!m) continue;
    if (m[3] !== '' && m[2] === '') continue;
    const level = m[1].length;
    let heading = (m[3] || '').trim();
    // Strip an ATX closing sequence ("## Title ##") — only when it is a
    // space-separated run at the very end, so "C#" keeps its '#'.
    heading = heading.replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (!heading) continue;
    items.push({ line: i, level, text: heading });
  }
  return items;
}
