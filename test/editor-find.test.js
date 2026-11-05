import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEditor } from '../js/editor.js';

function fixture() {
  const dom = new JSDOM('<!doctype html><body><textarea id="editor"></textarea></body>');
  const keys = ['document', 'window', 'DOMParser', 'EasyMDE',
    'ResizeObserver', 'requestAnimationFrame'];
  const previous = new Map(keys.map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key)
  ]));
  let value = 'cat CAT cat';
  let selection = { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  const marks = [];
  const handlers = {};
  const input = dom.window.document.createElement('textarea');
  dom.window.document.body.append(input);
  const cm = {
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    off(event, fn) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== fn);
    },
    refresh() {},
    operation(fn) { return fn(); },
    getInputField: () => input,
    getValue: () => value,
    getOption: () => 'gfm',
    getCursor: (which) => which === 'from' ? selection.from : selection.to,
    indexFromPos: (pos) => pos.ch,
    posFromIndex: (ch) => ({ line: 0, ch }),
    getSelection: () => value.slice(selection.from.ch, selection.to.ch),
    setSelection(from, to) { selection = { from, to }; },
    scrollIntoView() {},
    markText(from, to, options) {
      const mark = {
        options, dead: false,
        clear() { this.dead = true; },
        find() { return this.dead ? undefined : { from, to }; }
      };
      marks.push(mark);
      return mark;
    },
    swapDoc(doc) {
      const old = { text: value };
      value = doc.text;
      return old;
    }
  };
  const easyMDE = {
    codemirror: cm,
    value: () => value,
    toTextArea() {},
    isPreviewActive: () => false,
    isSideBySideActive: () => false
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.EasyMDE = function () { return easyMDE; };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // Layout frames are not needed for this DOM-less CodeMirror contract.
  globalThis.requestAnimationFrame = () => 0;
  const findStates = [];
  const editor = createEditor(document.getElementById('editor'), {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => null,
    onImageUploadRequest() {},
    onImagePaste() {},
    onFindStateChange(state) { findStates.push({ ...state }); }
  });
  const searchMarks = () => marks.filter((m) =>
    !m.dead && m.options.className === 'md-find-match');
  return {
    editor, searchMarks, marks, findStates,
    editAndNotify(text) {
      value = text;
      for (const fn of handlers.change || []) fn();
    },
    close() {
      try { editor.destroy(); } finally {
        dom.window.close();
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    }
  };
}

test('Editor Find: findInFile marks every phrase occurrence, not only the selection', () => {
  const f = fixture();
  try {
    assert.equal(f.editor.findInFile('cat'), 3);
    assert.equal(f.searchMarks().length, 3,
      'Editor must delegate highlighting of all occurrences');
  } finally { f.close(); }
});

test('Editor Find: clearFind removes owned search marks', () => {
  const f = fixture();
  try {
    f.editor.findInFile('cat');
    assert.equal(f.searchMarks().length, 3, 'fixture must have search marks');
    f.editor.clearFind();
    assert.equal(f.searchMarks().length, 0);
  } finally { f.close(); }
});

test('Editor Find: showDoc clears search marks from the previous document', () => {
  const f = fixture();
  try {
    f.editor.findInFile('cat');
    assert.equal(f.searchMarks().length, 3, 'fixture must have search marks');
    f.editor.showDoc({ text: 'another document' });
    assert.equal(f.searchMarks().length, 0,
      'search marks must not survive a document switch');
  } finally { f.close(); }
});

async function settleFindTimers() {
  mock.timers.tick(500);
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

test('Editor Find: typing another occurrence refreshes all marks without another Find command', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let f;
  try {
    f = fixture();
    f.editor.findInFile('cat');
    assert.equal(f.searchMarks().length, 3);
    f.editAndNotify('cat CAT cat cat');
    await settleFindTimers();
    assert.equal(f.searchMarks().length, 4);
  } finally {
    if (f) f.close();
    mock.timers.reset();
  }
});

test('Editor Find: restored text refreshes matches after an edit removes and restores an occurrence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let f;
  try {
    f = fixture();
    f.editor.findInFile('cat');
    f.editAndNotify('cat dog cat');
    await settleFindTimers();
    assert.equal(f.searchMarks().length, 2);
    f.editAndNotify('cat CAT cat');
    await settleFindTimers();
    assert.equal(f.searchMarks().length, 3);
  } finally {
    if (f) f.close();
    mock.timers.reset();
  }
});

test('Editor Find: state callback reports current and total after navigation', () => {
  const f = fixture();
  try {
    f.editor.findInFile('cat');
    assert.ok(f.findStates.length > 0, 'Find must publish its state');
    assert.deepEqual(f.findStates.at(-1), {
      mode: 'find', query: 'cat', total: 3, current: 1
    });
    f.editor.findInFile('cat');
    assert.deepEqual(f.findStates.at(-1), {
      mode: 'find', query: 'cat', total: 3, current: 2
    });
  } finally { f.close(); }
});

test('Editor Find: state callback updates after editing and clears with search', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let f;
  try {
    f = fixture();
    f.editor.findInFile('cat');
    const beforeEdit = f.findStates.length;
    f.editAndNotify('cat dog cat');
    await settleFindTimers();
    assert.ok(f.findStates.length > beforeEdit,
      'Debounced refresh must publish the new count');
    assert.deepEqual(f.findStates.at(-1), {
      mode: 'find', query: 'cat', total: 2, current: 0
    });
    f.editor.clearFind();
    assert.deepEqual(f.findStates.at(-1), {
      mode: 'find', query: '', total: 0, current: 0
    });
  } finally {
    if (f) f.close();
    mock.timers.reset();
  }
});
