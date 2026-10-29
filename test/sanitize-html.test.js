import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { sanitizeHtml, sanitizeHtmlDocument, renderMarkdownSafe } from '../js/sanitize-html.js';

const purify = createDOMPurify(new JSDOM('').window);

test('sanitize: event handlers and javascript: links are removed from markdown HTML', () => {
  const md = '<div onclick="alert(1)">click</div>\n\n<a href="javascript:alert(2)">link</a>\n\n<details open ontoggle="alert(3)"><summary>s</summary>b</details>\n';
  const html = renderMarkdownSafe(md, marked, purify);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /ontoggle/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /click/);
  assert.match(html, /<details/);
});

test('sanitize: the editor canonical image markup survives (data-md-*, data: pixel, wrapper)', () => {
  const html = renderMarkdownSafe('![a](pic.png)\n', marked, purify);
  assert.match(html, /class="md-img-wrap/);
  assert.match(html, /data-md-src="pic\.png"/);
  assert.match(html, /data-md-line="0"/);
  assert.match(html, /src="data:image\/gif;base64,/);
});

test('sanitize: kbd, details/summary, task checkboxes and image width survive', () => {
  const md = '<kbd>Ctrl</kbd>\n\n<details><summary>S</summary>body</details>\n\n- [ ] task\n\n<img src="a.png" width="300">\n';
  const html = renderMarkdownSafe(md, marked, purify);
  assert.match(html, /<kbd>Ctrl<\/kbd>/);
  assert.match(html, /<summary>S<\/summary>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /width="300"/);
  assert.match(html, /width:\s*300px/);
});

test('sanitize: fail-closed when DOMPurify is not loaded', () => {
  assert.throws(() => sanitizeHtml('<p>x</p>', null), /DOMPurify/);
  assert.throws(() => sanitizeHtml('<p>x</p>', {}), /DOMPurify/);
  assert.throws(() => renderMarkdownSafe('# x', marked, undefined), /DOMPurify/);
});

test('sanitize: plain markdown renders unchanged in substance', () => {
  const html = renderMarkdownSafe('# Title\n\nSome **bold** text and [a link](notes/a.md).\n', marked, purify);
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="notes\/a\.md"/);
});

test('sanitize: a whole HTML document keeps its styles and body, loses scripts and handlers', () => {
  const doc = '<!DOCTYPE html><html><head><style>p{color:red}</style></head>'
    + '<body><p>x</p><img src="a.png" onerror="alert(1)"><script>alert(2)</script></body></html>';
  const out = sanitizeHtmlDocument(doc, purify);
  assert.match(out, /p\{color:red\}/);
  assert.match(out, /<p>x<\/p>/);
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /alert\(2\)/);
});