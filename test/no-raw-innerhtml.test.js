import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(__dirname, '../js');

/**
 * Guard against putting untrusted HTML into the main page (GitHub token lives there).
 *
 * A line with `.innerHTML =` is accepted when:
 * - it clears the node (empty string), or
 * - the RHS is a static string/template with no ${...}, or
 * - the same line (or a short following window for multi-line templates) mentions
 *   sanitizeHtml / sanitizeOfficeHtml / sanitizeHtmlDocument / renderMarkdownSafe /
 *   escapeHtml / escapeAttr / officeFallbackHtml / sheetToHtml / a variable named
 *   `html` | `clean` (convention: already sanitized upstream).
 *
 * This is a heuristic net, not a full taint analysis. Prefer fixing code over
 * growing exceptions.
 */
const ASSIGN_RE = /\.innerHTML\s*=/;
const CLEAR_RE = /\.innerHTML\s*=\s*(['"`])\s*\1/;
const STATIC_STR_RE = /\.innerHTML\s*=\s*'[^']*'/;
const STATIC_STR2_RE = /\.innerHTML\s*=\s*"[^"]*"/;
const STATIC_TICK_RE = /\.innerHTML\s*=\s*`[^`$]*`/; // template with no ${
const SAFE_NAME_RE =
  /sanitizeHtml|sanitizeOfficeHtml|sanitizeHtmlDocument|renderMarkdownSafe|escapeHtml|escapeAttr|officeFallbackHtml|sheetToHtml|buildSnippet/;
const SAFE_VAR_RE = /\.innerHTML\s*=\s*(html|clean|out)\b/;

function jsFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function isSafeLine(line) {
  if (CLEAR_RE.test(line)) return true;
  if (STATIC_STR_RE.test(line) || STATIC_STR2_RE.test(line) || STATIC_TICK_RE.test(line)) return true;
  if (SAFE_NAME_RE.test(line)) return true;
  if (SAFE_VAR_RE.test(line)) return true;
  return false;
}

test('js/: innerHTML assignments are cleared, static, escaped, or sanitized', () => {
  const files = jsFiles(JS_DIR);
  assert.ok(files.length > 5, 'expected js modules');

  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!ASSIGN_RE.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (isSafeLine(line)) continue;

      // Multi-line template / expression: look ahead a bit for escape/sanitize
      const window = lines.slice(i, Math.min(lines.length, i + 30)).join('\n');
      if (SAFE_NAME_RE.test(window)) continue;

      const rel = path.relative(path.resolve(JS_DIR, '..'), file);
      offenders.push(`${rel}:${i + 1}: ${trimmed.slice(0, 140)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Unchecked innerHTML assignment(s):\n${offenders.join('\n')}\n` +
      'Use sanitizeHtml / sanitizeOfficeHtml / escapeHtml, assign a static string, or clear with "".'
  );
});
