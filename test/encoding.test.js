import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Source-like extensions we care about (UTF-8, no BOM). */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.html', '.css', '.md', '.json', '.py', '.toml', '.yml', '.yaml',
]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '__pycache__') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function isSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXT.has(ext);
}

test('source files have no UTF-8 BOM', () => {
  const files = walk(ROOT).filter(isSourceFile);
  assert.ok(files.length > 10, 'expected to find source files');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const offenders = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf.length >= 3 && buf.subarray(0, 3).equals(bom)) offenders.push(path.relative(ROOT, f));
  }
  assert.deepEqual(offenders, [], `UTF-8 BOM found in: ${offenders.join(', ')}`);
});

test('source files have no common mojibake markers', () => {
  // Classic UTF-8 misread as Latin-1/CP1251 leftovers that showed up in past bugs
  const BAD = [
    'Ð', 'Ñ', // common UTF-8 Cyrillic mis-decoded
    'Ã©', 'Ã¼', // common Western European mojibake
    '\uFFFD', // replacement character often left after bad decode
  ];
  const files = walk(ROOT).filter(isSourceFile);
  const offenders = [];
  for (const f of files) {
    // skip this test file itself if it mentions the markers as strings
    if (f.endsWith('encoding.test.js')) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const marker of BAD) {
      if (text.includes(marker)) {
        offenders.push(`${path.relative(ROOT, f)} (marker ${JSON.stringify(marker)})`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `Possible mojibake in:\n${offenders.join('\n')}`);
});
