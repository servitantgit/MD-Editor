// doc-outline.js
// Pure heading parser for the document outline panel (no DOM, unit-testable).
// CommonMark ATX headings: up to 3 leading spaces, 1-6 #'s, then a space/tab
// (or end of line), optional closing sequence of #'s preceded by a space.
//
// Deliberately skips:
// * fenced code blocks (``` or ~~~) — a "# comment" inside code is not a heading;
// * indented code (>= 4 spaces);
// * the trailing '#' of titles like "C#" (only a space-prefixed closing run counts).

export function parseHeadingOutline(text) {
  const lines = String(text || '').split('\n');
  const items = [];
  let fence = null; // '```' or '~~~' while inside a fenced block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] === '`' ? '`' : '~';
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
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
