import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildHtmlSrcdoc } from '../js/html-preview.js';
import { ImageResolver } from '../js/image-resolver.js';

// buildHtmlSrcdoc looks up DOMParser at call time; jsdom provides it.
const { window } = new JSDOM('');
globalThis.DOMParser = window.DOMParser;

async function linkPath(href, currentPath = 'notes/page.html') {
  const out = await buildHtmlSrcdoc(`<a href="${href}">x</a>`, currentPath, null);
  const doc = new window.DOMParser().parseFromString(out, 'text/html');
  return doc.querySelector('a').getAttribute('data-md-path');
}

test('HTML preview: relative link with %20 opens the decoded path', async () => {
  assert.equal(await linkPath('My%20Notes.md'), 'notes/My Notes.md');
});

test('HTML preview: absolute link with %20 opens the decoded path', async () => {
  assert.equal(await linkPath('/a%20b/c.md'), 'a b/c.md');
});

test('HTML preview: encoded %23 stays in the file name, real #anchor is stripped', async () => {
  assert.equal(await linkPath('a%23b.md#sec'), 'notes/a#b.md');
});

test('HTML preview: malformed percent sequence does not break the link (guard)', async () => {
  assert.equal(await linkPath('100%.md'), 'notes/100%.md');
});

test('HTML preview: img src reaches the resolver as written (the resolver decodes)', async () => {
  const calls = [];
  const resolver = {
    async resolve(src, from) {
      calls.push([src, from]);
      return 'data:image/png;base64,AAAA';
    },
  };
  await buildHtmlSrcdoc('<img src="my%20pic.png">', 'notes/page.html', resolver);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'my%20pic.png');
  assert.equal(calls[0][1], 'notes/page.html');
});

// End to end with the real resolver: what the user sees must not change.
function realResolver(calls) {
  return new ImageResolver({
    owner: 'o',
    repo: 'r',
    async getFileAsDataUrl(p) { calls.push(p); return 'data:image/png;base64,AAAA'; },
  });
}

test('HTML preview + real ImageResolver: %20 in img src loads the file with a space (guard)', async () => {
  const calls = [];
  await buildHtmlSrcdoc('<img src="my%20pic.png">', 'notes/page.html', realResolver(calls));
  assert.deepEqual(calls, ['notes/my pic.png']);
});

test('HTML preview + real ImageResolver: %2520 is decoded exactly once (guard)', async () => {
  const calls = [];
  await buildHtmlSrcdoc('<img src="a%2520b.png">', 'notes/page.html', realResolver(calls));
  assert.deepEqual(calls, ['notes/a%20b.png']);
});
