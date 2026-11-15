// Office files are untrusted input (anyone can commit one) and their HTML goes
// into the MAIN page, which holds the GitHub token. These tests run the real
// libraries (Mammoth, SheetJS) and the real DOMPurify on jsdom.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { sanitizeOfficeHtml } from '../js/binary-viewer.js';

const win = new JSDOM('').window;
const purify = createDOMPurify(win);
const doc = win.document;
const clean = (html) => sanitizeOfficeHtml(html, purify, doc);

test('office html: javascript: link loses its href, http link opens safely', () => {
  const out = clean('<p><a href="javascript:window.__pwned=1">bad</a> <a href="https://example.com/x">ok</a></p>');
  assert.ok(!/javascript:/i.test(out), out);
  assert.match(out, /<a>bad<\/a>/);
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /target="_blank"/);
});

test('office html: event handlers and script are stripped', () => {
  const out = clean('<img src="x" onerror="alert(1)"><script>alert(2)</script><p onclick="x()">t</p>');
  assert.ok(!/onerror|onclick|<script/i.test(out), out);
  assert.match(out, /<p>t<\/p>/);
});

test('office html: fail-closed when DOMPurify is missing', () => {
  assert.throws(() => sanitizeOfficeHtml('<p>x</p>', null, doc), /DOMPurify/);
  assert.throws(() => sanitizeOfficeHtml('<p>x</p>', {}, doc), /DOMPurify/);
});

test('real DOCX with a javascript: hyperlink (Mammoth -> sanitize) keeps the text, drops the href', async () => {
  const buffer = fs.readFileSync(new URL('./fixtures/evil-link.docx', import.meta.url));
  const raw = (await mammoth.convertToHtml({ buffer })).value;
  assert.match(raw, /javascript:/i, 'fixture must really carry the javascript: link before sanitizing');
  const out = clean(raw);
  assert.ok(!/javascript:/i.test(out), out);
  assert.match(out, /CLICKME/);
});

test('real spreadsheet cell with <img onerror> (SheetJS -> sanitize) never becomes an element', () => {
  const ws = XLSX.utils.aoa_to_sheet([['<img src=x onerror=alert(1)>', 'plain']]);
  const raw = XLSX.utils.sheet_to_html(ws, { editable: false });
  const out = clean(raw);
  const probe = doc.createElement('div');
  probe.innerHTML = out;
  assert.equal(probe.querySelectorAll('img').length, 0, out);
  const handlers = [...probe.querySelectorAll('*')].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith('on')));
  assert.deepEqual(handlers, [], out);
  assert.equal(probe.querySelector('td').textContent, '<img src=x onerror=alert(1)>', 'the cell text stays visible, as text');
  assert.match(out, /plain/);
});

test('binary-viewer.js: no Mammoth / SheetJS output reaches innerHTML unsanitized', () => {
  const src = fs.readFileSync(new URL('../js/binary-viewer.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/result\.value/g)) {
    const around = src.slice(Math.max(0, m.index - 80), m.index + 80);
    assert.match(around, /sanitizeOfficeHtml/, `raw result.value: ${around}`);
  }
  const sheetCalls = [...src.matchAll(/sheet_to_html\(/g)];
  assert.ok(sheetCalls.length >= 1);
  for (const m of sheetCalls) {
    const around = src.slice(Math.max(0, m.index - 60), m.index + 60);
    assert.match(around, /sanitizeOfficeHtml/, `raw sheet_to_html: ${around}`);
  }
});

test('Mammoth and SheetJS: CDN URL version equals the pinned devDependency', () => {
  const src = fs.readFileSync(new URL('../js/binary-viewer.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const m = src.match(/mammoth@([\d.]+)\//);
  const x = src.match(/xlsx@([\d.]+)\//);
  assert.equal(pkg.devDependencies.mammoth, m && m[1]);
  assert.equal(pkg.devDependencies.xlsx, x && x[1]);
});
