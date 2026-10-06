// file-kind.js
// Pure helpers: extension → editor kind / CodeMirror mode / preview strategy.

const TABLE = [
  { exts: ['md', 'markdown', 'mdown'], kind: 'markdown', mode: 'gfm', label: 'Markdown', preview: 'markdown' },
  { exts: ['html', 'htm'], kind: 'html', mode: 'htmlmixed', label: 'HTML', preview: 'html' },
  { exts: ['js', 'mjs', 'cjs'], kind: 'code', mode: 'javascript', label: 'JavaScript', preview: 'code' },
  { exts: ['ts', 'tsx'], kind: 'code', mode: 'javascript', label: 'TypeScript', preview: 'code' },
  { exts: ['jsx'], kind: 'code', mode: 'javascript', label: 'JSX', preview: 'code' },
  { exts: ['css'], kind: 'code', mode: 'css', label: 'CSS', preview: 'code' },
  { exts: ['scss', 'sass'], kind: 'code', mode: 'css', label: 'SCSS', preview: 'code' },
  { exts: ['json'], kind: 'code', mode: 'javascript', label: 'JSON', preview: 'code' },
  { exts: ['py'], kind: 'code', mode: 'python', label: 'Python', preview: 'code' },
  { exts: ['sh', 'bash', 'zsh'], kind: 'code', mode: 'shell', label: 'Shell', preview: 'code' },
  { exts: ['xml', 'svg'], kind: 'code', mode: 'xml', label: 'XML', preview: 'code' },
  { exts: ['yml', 'yaml'], kind: 'code', mode: 'yaml', label: 'YAML', preview: 'code' },
  { exts: ['txt', 'log', 'csv', 'tsv'], kind: 'text', mode: 'null', label: 'Text', preview: 'code' },
];

const byExt = new Map();
for (const row of TABLE) {
  for (const e of row.exts) byExt.set(e, row);
}

/** @param {string} path */
export function extOfPath(path) {
  const base = String(path || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

/**
 * @param {string} path
 * @returns {{ kind: string, mode: string, label: string, preview: 'markdown'|'html'|'code', ext: string }}
 */
export function kindFromPath(path) {
  const ext = extOfPath(path);
  const row = byExt.get(ext);
  if (row) return { ...row, ext };
  return { kind: 'text', mode: 'null', label: ext ? ext.toUpperCase() : 'Text', preview: 'code', ext };
}

/** Text files the editor can open (not images/binaries). */
export function isEditableTextPath(path) {
  const k = kindFromPath(path);
  if (k.kind === 'markdown' || k.kind === 'html' || k.kind === 'code' || k.kind === 'text') return true;
  // Unknown extension: still allow if it looks like text (no well-known binary)
  const binary = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'wasm',
    'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'webm', 'exe', 'dll',
  ]);
  return !binary.has(extOfPath(path));
}

export function isMarkdownPath(path) {
  return kindFromPath(path).kind === 'markdown';
}

export function isHtmlPath(path) {
  return kindFromPath(path).kind === 'html';
}
