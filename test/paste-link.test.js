import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded inside each test: until the module exists every test fails by its own
// name (RED), instead of the whole file failing to load.
const load = () => import('../js/paste-link.js');
const URL1 = 'https://a.com/x';

test('paste link: a URL over selected text makes [text](url)', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: URL1 }), '[docs](https://a.com/x)');
});

test('paste link: spaces and a line break around the URL are trimmed', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: '  ' + URL1 + '\n' }), '[docs](https://a.com/x)');
});

test('paste link: a URL with parentheses is wrapped in angle brackets', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'w', clipboardText: 'https://a.com/(x)' }), '[w](<https://a.com/(x)>)');
});

test('paste link: without a selection it is a normal paste', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: '', clipboardText: URL1 }), null);
});

test('paste link: a selection across lines is a normal paste', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'a\nb', clipboardText: URL1 }), null);
});

test('paste link: text that only contains a URL is a normal paste', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: 'see ' + URL1 }), null);
});

test('paste link: replacing a selected URL with another URL is a normal paste', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'https://old.com', clipboardText: URL1 }), null);
});

test('paste link: a selection with [ or ] is left alone', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: '[a] b', clipboardText: URL1 }), null);
  assert.equal(linkFromPaste({ selection: 'a]', clipboardText: URL1 }), null);
});

test('paste link: inside code it is a normal paste', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: URL1, inCode: true }), null);
});

test('paste link: only http and https URLs', async () => {
  const { linkFromPaste } = await load();
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: 'ftp://a.com/x' }), null);
  assert.equal(linkFromPaste({ selection: 'docs', clipboardText: 'mailto:a@b.c' }), null);
});

test('paste link: isInsideCode sees fenced and inline code, and nothing else', async () => {
  const { isInsideCode } = await load();
  const text = 'a `x y` b\n```\ncode\n```\nend';
  assert.equal(isInsideCode(text, text.indexOf('x')), true, 'inline code');
  assert.equal(isInsideCode(text, text.indexOf('code')), true, 'fenced code');
  assert.equal(isInsideCode(text, 0), false, 'plain text');
  assert.equal(isInsideCode(text, text.indexOf('end')), false, 'after the fence');
});
