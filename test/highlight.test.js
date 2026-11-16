import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { highlightBlock } from '../js/highlight.js';

function setDomDocument() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  return { dom, previous };
}

function restoreDomDocument(previous) {
  if (previous === undefined) delete globalThis.document;
  else globalThis.document = previous;
}

test('highlightBlock adds the hljs class and keyword highlighting for JavaScript', () => {
  const { dom, previous } = setDomDocument();
  try {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-javascript';
    code.textContent = 'const a = 1;';
    pre.appendChild(code);

    highlightBlock(code);

    assert.ok(code.classList.contains('hljs'));
    assert.match(code.innerHTML, /hljs-keyword/);
  } finally {
    restoreDomDocument(previous);
    dom.window.close();
  }
});

test('highlightBlock highlights Python keywords in a second block', () => {
  const { dom, previous } = setDomDocument();
  try {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-python';
    code.textContent = 'def f():\n    pass';
    pre.appendChild(code);

    highlightBlock(code);

    assert.match(code.innerHTML, /hljs-keyword/);
  } finally {
    restoreDomDocument(previous);
    dom.window.close();
  }
});
