import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildHtmlSrcdoc } from '../js/html-preview.js';

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

test('HTML preview: img src with %20 reaches the resolver decoded', async () => {
  const calls = [];
  const resolver = {
    async resolve(src, from) {
      calls.push([src, from]);
      return 'data:image/png;base64,AAAA';
    },
  };
  await buildHtmlSrcdoc('<img src="my%20pic.png">', 'notes/page.html', resolver);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'my pic.png');
  assert.equal(calls[0][1], 'notes/page.html');
});