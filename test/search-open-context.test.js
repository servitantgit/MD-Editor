import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import MiniSearch from 'minisearch';
import { SearchIndex } from '../js/search-index.js';
import { createSearchUI } from '../js/search-ui.js';

function fixture() {
  const dom = new JSDOM(
    '<input id="input"><span id="status"></span><button id="reindex"></button>'
    + '<div id="tree"></div><div id="results"></div>'
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;
  const index = new SearchIndex(MiniSearch);
  index.add('Notes/example.md', 'A printing machine needs maintenance.');
  const calls = [];
  const input = document.getElementById('input');
  const results = document.getElementById('results');
  const ui = createSearchUI({
    inputEl: input,
    statusEl: document.getElementById('status'),
    reindexBtn: document.getElementById('reindex'),
    treeEl: document.getElementById('tree'),
    resultsEl: results,
    getSync: () => ({ index }),
    onOpenFile: (...args) => calls.push(args),
    onReindex() {}
  });
  return {
    index, calls, input, results, ui,
    close() {
      try { ui.destroy(); } finally {
        dom.window.close();
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete globalThis.document;
      }
    }
  };
}

test('Search open: clicking a result passes actual match metadata with the path', () => {
  const f = fixture();
  try {
    f.input.value = 'print';
    f.ui.renderResults('print');
    const hit = f.index.query('print')[0];
    assert.deepEqual(hit.terms, ['printing'], 'fixture must be a prefix match');
    const row = f.results.querySelector('.search-result');
    assert.ok(row, 'fixture must render a result');
    row.querySelector('.search-result-snippet').click();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], 'Notes/example.md');
    assert.deepEqual(f.calls[0][1], {
      query: 'print',
      terms: hit.terms,
      queryTerms: hit.queryTerms,
      match: hit.match
    });
  } finally { f.close(); }
});

test('Search open: result keeps its rendered query when the input changes before repaint', () => {
  const f = fixture();
  try {
    f.input.value = 'print';
    f.ui.renderResults('print');
    const hit = f.index.query('print')[0];
    // Input has changed, but its debounce has not repainted these rows yet.
    f.input.value = 'maintenance';
    const row = f.results.querySelector('.search-result');
    assert.ok(row, 'fixture must retain the rendered result');
    row.querySelector('.search-result-path').click();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], [
      'Notes/example.md',
      {
        query: 'print',
        terms: hit.terms,
        queryTerms: hit.queryTerms,
        match: hit.match
      }
    ]);
  } finally { f.close(); }
});
