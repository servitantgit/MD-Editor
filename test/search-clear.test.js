import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import MiniSearch from 'minisearch';
import { SearchIndex } from '../js/search-index.js';
import { createSearchUI } from '../js/search-ui.js';

function fixture() {
  const dom = new JSDOM(
    '<input id="input"><button id="clear" type="button">x</button>'
    + '<span id="status"></span><button id="reindex"></button>'
    + '<div id="tree"><span id="original">original tree row</span></div>'
    + '<div id="results" class="hidden"></div>'
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;
  const input = document.getElementById('input');
  const clearBtn = document.getElementById('clear');
  const tree = document.getElementById('tree');
  const original = document.getElementById('original');
  const results = document.getElementById('results');
  const index = new SearchIndex(MiniSearch);
  index.add('a.md', 'A printer needs maintenance.');
  const opens = [];
  const ui = createSearchUI({
    inputEl: input, clearBtn,
    statusEl: document.getElementById('status'),
    reindexBtn: document.getElementById('reindex'),
    treeEl: tree, resultsEl: results,
    getSync: () => ({ index }),
    onOpenFile: (...args) => opens.push(args),
    onReindex() {}
  });
  return {
    input, clearBtn, tree, original, results, opens, ui,
    type(value) {
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    close() {
      try { ui.destroy(); } finally {
        dom.window.close();
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete globalThis.document;
      }
    }
  };
}

test('Search clear: button visibility follows empty, text and whitespace input', () => {
  const f = fixture();
  try {
    assert.equal(f.clearBtn.hidden, true, 'empty input must hide the button');
    f.type('printer');
    assert.equal(f.clearBtn.hidden, false);
    f.type('');
    assert.equal(f.clearBtn.hidden, true);
    f.type(' ');
    assert.equal(f.clearBtn.hidden, false, 'whitespace is still input to clear');
  } finally { f.close(); }
});

test('Search clear: click immediately clears results, restores original tree and focuses input', () => {
  const f = fixture();
  try {
    f.input.value = 'printer';
    f.ui.renderResults('printer');
    assert.equal(f.results.querySelectorAll('.search-result').length, 1);
    assert.equal(f.tree.classList.contains('hidden'), true);

    f.clearBtn.click();

    assert.equal(f.input.value, '');
    assert.equal(f.results.querySelectorAll('.search-result').length, 0);
    assert.equal(f.results.classList.contains('hidden'), true);
    assert.equal(f.tree.classList.contains('hidden'), false);
    assert.equal(f.tree.querySelector('#original'), f.original);
    assert.equal(document.activeElement, f.input);
    assert.equal(f.clearBtn.hidden, true);
    assert.deepEqual(f.opens, []);
  } finally { f.close(); }
});

test('Search clear: clearing pending debounce prevents the old results from appearing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let f;
  try {
    f = fixture();
    f.type('printer');
    f.clearBtn.click();
    assert.equal(f.input.value, '', 'click must clear before debounce runs');
    mock.timers.tick(1000);
    assert.equal(f.results.querySelectorAll('.search-result').length, 0);
    assert.equal(f.tree.classList.contains('hidden'), false);
    assert.equal(f.ui.isActive(), false);
  } finally {
    if (f) f.close();
    mock.timers.reset();
  }
});
