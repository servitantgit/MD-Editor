// diff-util.js
// Minimal unified diff (no dependencies). Good enough for markdown review before commit.

/**
 * Myers-inspired simple LCS line diff → unified hunks.
 * @param {string} oldText
 * @param {string} newText
 * @param {string} [path]
 * @returns {{ lines: Array<{type: 'ctx'|'add'|'del'|'hunk', text: string}>, stats: {additions: number, deletions: number} }}
 */
export function unifiedDiff(oldText, newText, path = 'file') {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  // Drop trailing empty line artifacts from split on empty string
  if (a.length === 1 && a[0] === '') a.pop();
  if (b.length === 1 && b[0] === '') b.pop();

  const n = a.length;
  const m = b.length;
  // DP LCS lengths
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** @type {Array<{type: 'ctx'|'add'|'del', text: string, oldNo?: number, newNo?: number}>} */
  const raw = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: 'ctx', text: a[i], oldNo, newNo });
      i++; j++; oldNo++; newNo++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'del', text: a[i], oldNo });
      i++; oldNo++;
    } else {
      raw.push({ type: 'add', text: b[j], newNo });
      j++; newNo++;
    }
  }
  while (i < n) {
    raw.push({ type: 'del', text: a[i], oldNo });
    i++; oldNo++;
  }
  while (j < m) {
    raw.push({ type: 'add', text: b[j], newNo });
    j++; newNo++;
  }

  let additions = 0;
  let deletions = 0;
  for (const r of raw) {
    if (r.type === 'add') additions++;
    if (r.type === 'del') deletions++;
  }

  // Build hunks with context (3 lines)
  const CONTEXT = 3;
  /** @type {Array<{type: string, text: string}>} */
  const lines = [];
  // Mark indices that should be shown
  const show = new Array(raw.length).fill(false);
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== 'ctx') {
      for (let t = Math.max(0, k - CONTEXT); t <= Math.min(raw.length - 1, k + CONTEXT); t++) {
        show[t] = true;
      }
    }
  }

  let k = 0;
  while (k < raw.length) {
    if (!show[k]) {
      k++;
      continue;
    }
    // Find contiguous shown region
    let end = k;
    while (end < raw.length && show[end]) end++;
    // Hunk header
    const slice = raw.slice(k, end);
    const oldStart = slice.find((s) => s.oldNo != null)?.oldNo ?? 1;
    const newStart = slice.find((s) => s.newNo != null)?.newNo ?? 1;
    const oldCount = slice.filter((s) => s.type !== 'add').length;
    const newCount = slice.filter((s) => s.type !== 'del').length;
    lines.push({
      type: 'hunk',
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    });
    for (const s of slice) {
      if (s.type === 'ctx') lines.push({ type: 'ctx', text: ' ' + s.text });
      else if (s.type === 'add') lines.push({ type: 'add', text: '+' + s.text });
      else lines.push({ type: 'del', text: '-' + s.text });
    }
    k = end;
  }

  if (!lines.length && oldText === newText) {
    lines.push({ type: 'ctx', text: ' (no textual changes)' });
  }

  return { lines, stats: { additions, deletions }, path };
}

/** Render diff lines into a container element. */
export function renderDiffLines(container, diff) {
  container.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'diff-patch';
  for (const line of diff.lines) {
    const div = document.createElement('div');
    if (line.type === 'add') div.className = 'diff-add';
    else if (line.type === 'del') div.className = 'diff-del';
    else if (line.type === 'hunk') div.className = 'diff-hunk';
    div.textContent = line.text;
    pre.appendChild(div);
  }
  container.appendChild(pre);
}
