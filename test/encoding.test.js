// Replaces the manual PowerShell check that used to live in AGENTS.md: a Windows
// editor that re-encodes a file (cp1250) turns dashes and arrows into mojibake.
// The patterns are built from char codes so this file itself cannot be mangled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'screenshots', 'assets', 'fixtures']);
const SKIP_FILES = new Set(['AGENTS.md', 'AGENTS-DETAIL.md', 'encoding.test.js']);
const EXT = /\.(js|mjs|ts|html|css|md|json|py|ps1|txt|toml|yml|yaml)$/;
const PATTERNS = [
  String.fromCharCode(0xE2, 0x20AC),
  String.fromCharCode(0xE2, 0x2020),
  String.fromCharCode(0xC3),
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else if (EXT.test(e.name) && !SKIP_FILES.has(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

test('no text file has mojibake or a BOM', () => {
  const bad = [];
  for (const file of walk(root)) {
    const buf = fs.readFileSync(file);
    const rel = path.relative(root, file);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bad.push(rel + ': BOM');
    const text = buf.toString('utf8');
    for (const p of PATTERNS) {
      const i = text.indexOf(p);
      if (i >= 0) bad.push(rel + ': mojibake near ' + JSON.stringify(text.slice(Math.max(0, i - 20), i + 20)));
    }
  }
  assert.deepEqual(bad, []);
});
