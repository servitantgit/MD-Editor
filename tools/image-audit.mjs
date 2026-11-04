// tools/image-audit.mjs
// Image audit report for a repository checked out next to MD-Editor.
// Reads the tree and the notes from git HEAD (never the disk: no encoding,
// OneDrive or case-insensitivity surprises). All rules live in
// js/image-audit.js (tests: test/image-audit.test.js).
//
// HOW TO USE (rarely needed; an in-app panel is deliberately postponed)
//
// 1. Before: in the notes repository commit or discard local changes and
//    pull. The tool refuses a dirty checkout and one that differs from its
//    upstream (it runs git fetch itself).
//
// 2. Run from the MD-Editor root (PowerShell):
//      $root = Join-Path (Split-Path $PWD.Path -Parent) 'Gillette'
//      $out  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'image-audit-report.txt'
//      node tools/image-audit.mjs $root --out $out
//    Without --out the report goes to the console. Exit code: 0 valid
//    report, 2 invalid report (unused list withheld), 1 stopped.
//
// 3. Read the report:
//    - "valid false": something is unclear (a note could not be read, an
//      ![[embed]] or [[x.png]], an HTML file pointing at a picture). The
//      reasons are listed and NO unused pictures are shown. Fix or accept
//      the cause first; never delete from an invalid report.
//    - UNUSED: no note shows the picture. "= copy of X" means the same
//      bytes stay in X, so deleting loses nothing.
//    - BROKEN: a note links to a picture that does not exist. Fix the
//      note; "[exists as ...]" means only the letter case differs.
//    - DUPLICATES: same bytes under several names. "used 2/2" can only be
//      cleaned by rewriting links; this tool does not do that.
//
// 4. Delete (the tool itself never deletes): put the reviewed paths in a
//    UTF-8 text file, one repo path per line (Asset/x.jpg, without the size
//    tail), then in the notes repository make ONE commit:
//      git -C $root --literal-pathspecs rm --pathspec-from-file=<list>
//      git -C $root commit -m "Delete N unused images" -m "restore: git checkout <old-sha> -- <path>"
//      git -C $root push
//    <old-sha> is the HEAD printed at the top of the report. Run the audit
//    again afterwards: unused 0, broken 0.
//
// 5. Restore a deleted picture:
//      git -C $root checkout <old-sha> -- Asset/x.jpg
//    then commit it. Not "git show ... > file": PowerShell 5.1 re-encodes the bytes and breaks the picture.
//    (Gillette: the 83 pictures deleted in 5f57fdf come back from 6b276be.)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { auditImages } from '../js/image-audit.js';

const args = process.argv.slice(2);
const repo = args[0];
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const stop = (m) => { console.log('STOPPED: ' + m); process.exit(1); };
if (!repo || repo.startsWith('--')) stop('usage: node tools/image-audit.mjs <repo-dir> [--out <file>]');

const git = (a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const gs = (a) => git(a).toString('utf8').trim();

if (gs(['status', '--porcelain']) !== '') stop('working tree of ' + repo + ' is not clean');
git(['fetch', '--quiet']);
const head = gs(['rev-parse', 'HEAD']);
let upstream = '';
try { upstream = gs(['rev-parse', '@{u}']); } catch (_) { stop('no upstream branch'); }
if (head !== upstream) stop('HEAD ' + head.slice(0, 7) + ' != upstream ' + upstream.slice(0, 7) + ' (pull or push first)');

const files = git(['ls-tree', '-r', '-l', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean).map((line) => {
  const tab = line.indexOf('\t');
  const [mode, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
  return { mode, type, sha, size: Number(size) || 0, path: line.slice(tab + 1) };
}).filter((e) => e.type === 'blob');

const texts = new Map();
for (const f of files) {
  if (!/\.(md|html?)$/i.test(f.path)) continue;
  try { texts.set(f.path, git(['cat-file', 'blob', f.sha]).toString('utf8')); } catch (_) { texts.set(f.path, null); }
}

const r = auditImages({ files, texts });
const info = new Map(files.map((f) => [f.path, f]));
const kb = (n) => Math.round(n / 1024) + ' KB';
const usedBySha = new Map();
for (const g of r.duplicates) usedBySha.set(g.sha, g.paths.filter((p) => r.used.has(p)));

const L = [];
L.push('Image audit of ' + basename(repo));
L.push('HEAD ' + head);
L.push('valid ' + r.valid + ' | used ' + r.used.size + ' | broken ' + r.broken.length
  + ' | unused ' + r.unused.length + ' | duplicate groups ' + r.duplicates.length
  + ' | extra copies ' + r.duplicates.reduce((a, g) => a + g.paths.length - 1, 0));
if (!r.valid) {
  L.push('');
  L.push('REPORT INVALID - unused list withheld. Reasons:');
  r.reasons.forEach((x) => L.push('  ' + x));
}
if (r.valid) {
  const total = r.unused.reduce((a, p) => a + info.get(p).size, 0);
  L.push('');
  L.push('UNUSED (' + r.unused.length + ', ' + kb(total) + ')');
  for (const p of r.unused) {
    const twins = usedBySha.get(info.get(p).sha) || [];
    L.push('  ' + p + '  (' + kb(info.get(p).size) + ')' + (twins.length ? '  = copy of ' + twins[0] : ''));
  }
}
L.push('');
L.push('BROKEN (' + r.broken.length + ')');
r.broken.forEach((b) => L.push('  ' + b.from + ' -> ' + b.target + (b.caseHint ? '  [exists as ' + b.caseHint + ']' : '')));
L.push('');
L.push('DUPLICATES (' + r.duplicates.length + ' groups)');
for (const g of r.duplicates) {
  L.push('  ' + g.sha.slice(0, 10) + '  used ' + g.usedCount + '/' + g.paths.length);
  g.paths.forEach((p) => L.push('    ' + p + (r.used.has(p) ? '  [used x' + r.used.get(p) + ']' : '  [unused]')));
}
const report = L.join('\n') + '\n';
if (outFile) writeFileSync(outFile, report, 'utf8'); else process.stdout.write(report);
console.log(L[2]);
if (outFile) console.log('report written: ' + outFile);
process.exit(r.valid ? 0 : 2);
