import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Imported inside every test: until js/link-suggest.js exists each test fails
// on its own (ERR_MODULE_NOT_FOUND) instead of the whole file failing to load.
const load = () => import('../js/link-suggest.js');

test('buildFileLink: a root-absolute link with the .md stripped from the name', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/b.md'), '[b](/Notes/b.md)');
});

test('buildFileLink: a path with spaces goes into angle brackets', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('AI corrected/SSAM 1 - 2/Lasery Hood.md'), '[Lasery Hood](</AI corrected/SSAM 1 - 2/Lasery Hood.md>)');
});

test('buildFileLink: a path with parentheses goes into angle brackets', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/a (1).md'), '[a (1)](</Notes/a (1).md>)');
});

test('buildFileLink: a non-.md file keeps its extension in the name', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/image.png'), '[image.png](/Notes/image.png)');
});

test('rankLinkSuggestions: name prefix, then name contains, then path only; .md first', async () => {
  const { rankLinkSuggestions } = await load();
  const files = ['Archive/pan/notes.md', 'Recipes/pancakes.md', 'Recipes/crepe-pan.md', 'pan.png'];
  assert.deepEqual(rankLinkSuggestions(files, 'pan'), [
    'Recipes/pancakes.md',
    'pan.png',
    'Recipes/crepe-pan.md',
    'Archive/pan/notes.md',
  ]);
});

test('rankLinkSuggestions: ignores case, accepts {path} objects, drops files without a match', async () => {
  const { rankLinkSuggestions } = await load();
  const files = [{ path: 'Notes/Ideas.md', sha: 'x' }, { path: 'Notes/b.md', sha: 'y' }];
  assert.deepEqual(rankLinkSuggestions(files, 'IDEA'), ['Notes/Ideas.md']);
});

test('rankLinkSuggestions: an empty query lists files by the same order, cut to the limit', async () => {
  const { rankLinkSuggestions } = await load();
  const files = ['b/long/path/x.md', 'a.md', 'c.png'];
  assert.deepEqual(rankLinkSuggestions(files, '', 2), ['a.md', 'b/long/path/x.md']);
});

test('rankLinkSuggestions: within the same group a shorter path comes first', async () => {
  const { rankLinkSuggestions } = await load();
  assert.deepEqual(rankLinkSuggestions(['Deep/Folder/note.md', 'note.md'], 'note'), ['note.md', 'Deep/Folder/note.md']);
});

// ---- DOM part: createLinkSuggest (popup while typing [[) ----
// A small CodeMirror stand-in: one line of text, a cursor, key maps, events.
function fakeCm() {
  const handlers = {};
  const fire = (e) => (handlers[e] || []).slice().forEach((f) => f(cm));
  const cm = {
    handlers,
    lines: [''],
    cur: { line: 0, ch: 0 },
    keyMaps: [],
    on(e, f) { (handlers[e] ||= []).push(f); },
    off(e, f) { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
    getCursor() { return { line: this.cur.line, ch: this.cur.ch }; },
    getLine(n) { return this.lines[n]; },
    replaceRange(text, from, to) {
      const end = to || from;
      const l = this.lines[from.line];
      this.lines[from.line] = l.slice(0, from.ch) + text + l.slice(end.ch);
      this.cur = { line: from.line, ch: from.ch + text.length };
      fire('change');
      fire('cursorActivity');
    },
    cursorCoords() { return { left: 10, top: 20, bottom: 36 }; },
    addKeyMap(m) { this.keyMaps.push(m); },
    removeKeyMap(m) { this.keyMaps = this.keyMaps.filter((x) => x !== m); },
    focus() {},
    operation(fn) { return fn(); },
    type(text) { this.replaceRange(text, this.getCursor()); },
    press(key) {
      for (let i = this.keyMaps.length - 1; i >= 0; i--) {
        if (typeof this.keyMaps[i][key] === 'function') return this.keyMaps[i][key](this);
      }
      return 'not handled';
    },
  };
  return cm;
}

const FILES = ['Recipes/pancakes.md', 'Recipes/crepe-pan.md', 'Notes/b.md'];

async function startSuggest() {
  const { createLinkSuggest } = await load();
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const cm = fakeCm();
  const s = createLinkSuggest(cm, { getFiles: () => FILES, document: doc });
  const menu = () => doc.querySelector('.link-suggest-menu');
  const items = () => Array.from(doc.querySelectorAll('.link-suggest-menu .link-suggest-item'));
  return { cm, s, doc, menu, items };
}

test('link suggest DOM: typing [[pan opens a menu with the ranked notes', async () => {
  const { cm, s, menu, items } = await startSuggest();
  cm.type('[[pan');
  assert.ok(menu(), 'the menu must open');
  assert.deepEqual(items().map((i) => i.dataset.path), ['Recipes/pancakes.md', 'Recipes/crepe-pan.md']);
  assert.ok(items()[0].classList.contains('active'), 'the first item is selected');
  s.destroy();
});

test('link suggest DOM: Down and Enter replace [[query with a link to the chosen note', async () => {
  const { cm, s, menu } = await startSuggest();
  cm.type('see [[pan');
  cm.press('Down');
  cm.press('Enter');
  assert.equal(cm.lines[0], 'see [crepe-pan](/Recipes/crepe-pan.md)');
  assert.equal(menu(), null, 'the menu closes after inserting');
  assert.equal(cm.keyMaps.length, 0, 'the key map is removed with the menu');
  s.destroy();
});

test('link suggest DOM: Esc closes the menu, keeps the text and does not reopen for the same [[', async () => {
  const { cm, s, menu } = await startSuggest();
  cm.type('[[pan');
  cm.press('Esc');
  assert.equal(menu(), null);
  assert.equal(cm.lines[0], '[[pan');
  assert.equal(cm.keyMaps.length, 0);
  cm.type('c');
  assert.equal(menu(), null, 'typing on after Esc must not reopen the menu');
  s.destroy();
});

test('link suggest DOM: no menu without [[ or after the link is closed with ]]', async () => {
  const { cm, s, menu } = await startSuggest();
  cm.type('no trigger pan');
  assert.equal(menu(), null);
  cm.type(' and [[pan]] x');
  assert.equal(menu(), null);
  s.destroy();
});

test('link suggest DOM: destroy() removes the menu, the listeners and the key map', async () => {
  const { cm, s, menu } = await startSuggest();
  cm.type('[[pan');
  assert.ok(menu());
  s.destroy();
  assert.equal(menu(), null);
  assert.equal(cm.keyMaps.length, 0);
  assert.ok(Object.values(cm.handlers).every((list) => list.length === 0), 'every listener is removed');
});
