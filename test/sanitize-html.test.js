import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import {
  sanitizeHtml,
  sanitizeHtmlDocument,
  renderMarkdownSafe,
} from '../js/sanitize-html.js';

function makePurifier() {
  const { window } = new JSDOM('');
  return createDOMPurify(window);
}

test('sanitizeHtml: fail-closed when purifier is missing', () => {
  assert.throws(() => sanitizeHtml('<b>x</b>', null), /sanitizer/i);
  assert.throws(() => sanitizeHtml('<b>x</b>', undefined), /sanitizer/i);
  assert.throws(() => sanitizeHtml('<b>x</b>', {}), /sanitizer/i);
});

test('sanitizeHtml: strips script and event handlers', () => {
  const purify = makePurifier();
  const dirty =
    '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">' +
    '<div onclick="alert(3)">click</div>';
  const clean = sanitizeHtml(dirty, purify);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /onclick/i);
  assert.match(clean, /ok/);
});

test('sanitizeHtml: null/undefined become empty string, not "null"', () => {
  const purify = makePurifier();
  assert.equal(sanitizeHtml(null, purify), '');
  assert.equal(sanitizeHtml(undefined, purify), '');
});

test('sanitizeHtmlDocument: fail-closed and keeps document structure option', () => {
  const purify = makePurifier();
  assert.throws(() => sanitizeHtmlDocument('<html></html>', null), /sanitizer/i);
  const doc = sanitizeHtmlDocument(
    '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>hi</p><script>x</script></body></html>',
    purify
  );
  assert.doesNotMatch(doc, /<script/i);
  // body content survives
  assert.match(doc, /hi/);
});

test('renderMarkdownSafe: fail-closed without purifier', () => {
  const fakeRenderer = { parse: (t) => `<p>${t}</p>` };
  assert.throws(
    () => renderMarkdownSafe('# hi', fakeRenderer, null),
    /sanitizer/i
  );
});

test('renderMarkdownSafe: markdown XSS does not survive', () => {
  const purify = makePurifier();
  // marked-like renderer that does NOT sanitize (project rule: marked does not sanitize)
  const fakeRenderer = {
    parse: (t) =>
      String(t).replace(
        /\[xss\]/g,
        '<img src=x onerror="window.__pwned=1">'
      ),
  };
  const clean = renderMarkdownSafe('hello [xss]', fakeRenderer, purify);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /__pwned/);
});
