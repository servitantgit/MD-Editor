// markdown-commands.js
// Small editing commands for the toolbar. Pure line logic is kept separate from
// CodeMirror so it can be unit-tested without a browser.

const TASK_RE = /^(\s*)[-*+] \[[ xX]\] /;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)]) /;

/**
 * Toggle "- [ ] " task markers on a block of lines.
 * - every non-empty line already a task -> remove the markers (keep indent);
 * - otherwise -> convert non-task lines (replacing "- ", "* ", "1. " markers),
 *   keep existing tasks, leave empty lines alone;
 * - only empty lines -> add a marker so the user can start typing.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function toggleTaskLines(lines) {
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) {
    return lines.map((l) => l + '- [ ] ');
  }
  if (nonEmpty.every((l) => TASK_RE.test(l))) {
    return lines.map((l) => l.replace(TASK_RE, '$1'));
  }
  return lines.map((l) => {
    if (l.trim() === '' || TASK_RE.test(l)) return l;
    const m = l.match(LIST_RE);
    if (m) return m[1] + '- [ ] ' + l.slice(m[0].length);
    const indent = l.match(/^\s*/)[0];
    return indent + '- [ ] ' + l.slice(indent.length);
  });
}

/**
 * Apply toggleTaskLines to the lines covered by the CodeMirror selection.
 * A selection that ends at column 0 of a line does not include that line.
 * @param {object} cm CodeMirror 5 instance
 */
export function applyTaskList(cm) {
  if (!cm) return;
  const from = cm.getCursor('from');
  const to = cm.getCursor('to');
  const head = cm.getCursor('head');
  let endLine = to.line;
  if (to.line > from.line && to.ch === 0) endLine -= 1;
  const lines = [];
  for (let i = from.line; i <= endLine; i++) lines.push(cm.getLine(i));
  const next = toggleTaskLines(lines);
  const lastLen = lines[lines.length - 1].length;
  cm.operation(() => {
    cm.replaceRange(next.join('\n'), { line: from.line, ch: 0 }, { line: endLine, ch: lastLen });
    if (from.line === endLine) {
      const delta = next[0].length - lines[0].length;
      const ch = Math.min(next[0].length, Math.max(0, head.ch + delta));
      cm.setCursor({ line: from.line, ch });
    } else {
      cm.setSelection({ line: from.line, ch: 0 }, { line: endLine, ch: next[next.length - 1].length });
    }
  });
  cm.focus();
}