import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/** Records what it was asked to do, and — like the real thing — stops firing once
 *  disconnected, which is exactly the property the test needs to prove. */
class FakeResizeObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
    this.observed = [];
    FakeResizeObserver.instances.push(this);
  }
  observe(el) { this.observed.push(el); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  /** Simulates a resize. A real observer never calls the callback after disconnect(). */
  fireResize() { if (!this.disconnected) this.cb([]); }
}

function installEnvironment(dom, { text = () => '' } = {}) {
  const codemirror = {
    handlers: {},
    on(event, fn) { (this.handlers[event] ||= []).push(fn); },
    off(event, fn) { this.handlers[event] = (this.handlers[event] || []).filter((f) => f !== fn); },
    refreshes: 0,
    refresh() { this.refreshes++; },
    getInputField: () => inputField,
    getValue: text,
    markText: () => ({ clear() {}, find: () => true }),
  };
  const inputField = dom.window.document.createElement('textarea');
  dom.window.document.body.appendChild(inputField);
  const easyMDE = {
    codemirror,
    toTextAreaCalls: 0,
    toTextArea() { this.toTextAreaCalls++; },
    value: () => '',
  };
  globalThis.EasyMDE = function () { return easyMDE; };
  globalThis.ResizeObserver = FakeResizeObserver;
  // editor.js calls the bare global, not window.requestAnimationFrame, so jsdom's
  // window is not enough here.
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  return { easyMDE, codemirror, inputField };
}

test('destroy() disconnects the ResizeObserver and detaches every handler createEditor added', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { easyMDE, codemirror, inputField } = installEnvironment(dom);
  const { createEditor } = await import('../js/editor.js');
  const pastes = [];
  const textarea = dom.window.document.createElement('textarea');

  const handle = createEditor(textarea, {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => null,
    onImageUploadRequest: () => {},
    onImagePaste: (f) => pastes.push(f),
  });

  const observer = FakeResizeObserver.instances.at(-1);
  assert.equal(observer.observed.length, 1, 'the editor should observe something');
  assert.equal(codemirror.handlers.change.length, 1, 'a change handler should be attached');

  const pasteEvent = () => {
    const e = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    e.clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'a.png' }) }] };
    inputField.dispatchEvent(e);
    return e;
  };

  // Alive: the observer drives layout, the paste handler intercepts images.
  const before = codemirror.refreshes;
  observer.fireResize();
  assert.ok(codemirror.refreshes > before, 'observer should trigger a layout refresh');
  pasteEvent();
  assert.equal(pastes.length, 1, 'paste handler should be live before destroy');

  handle.destroy();

  assert.equal(observer.disconnected, true, 'ResizeObserver was never disconnected');
  const after = codemirror.refreshes;
  observer.fireResize();
  assert.equal(codemirror.refreshes, after, 'a disconnected observer must stop refreshing');
  pasteEvent();
  assert.equal(pastes.length, 1, 'paste handler must be detached by destroy');
  assert.equal(codemirror.handlers.change.length, 0, 'change handler must be detached by destroy');
  assert.equal(easyMDE.toTextAreaCalls, 1, 'the textarea must be handed back so it can be re-wrapped');

  // Teardown must be safe to repeat — cleanup code should never be the thing that throws.
  handle.destroy();
  handle.destroy();
});

test('switching files mid-render leaves no orphaned inline-image marks behind', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const TWO_IMAGES = '![a](a.png)\n\n![b](b.png)\n';
  const ONE_IMAGE = '![a](a.png)\n';
  let currentPath = null; // nothing open while createEditor() runs its own first render
  const pending = [];
  const created = [];

  const { codemirror } = installEnvironment(dom, {
    text: () => (currentPath === 'A.md' ? TWO_IMAGES : ONE_IMAGE),
  });
  codemirror.posFromIndex = (i) => ({ ch: i, line: 0 });
  codemirror.markText = () => {
    const m = { cleared: false, clear() { this.cleared = true; }, find() { return this.cleared ? null : {}; } };
    created.push(m);
    return m;
  };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    // Each resolve() parks until the test releases it, so the two renders
    // genuinely overlap instead of finishing one after another.
    imageResolver: { resolve: () => new Promise((r) => pending.push(r)) },
    getCurrentPath: () => currentPath,
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));

  // A.md: run 1 marks the first image, then parks on resolve().
  currentPath = 'A.md';
  handle.refreshInlineImages();
  await settle();
  assert.equal(created.length, 1, 'run 1 should have marked A.md’s first image');
  const firstMark = created[0];

  // The user opens B.md before run 1 finished.
  currentPath = 'B.md';
  handle.refreshInlineImages();
  await settle();
  assert.equal(created.length, 2, 'run 2 should have marked B.md’s image');
  assert.equal(firstMark.cleared, true, 'run 2 must clear the marks of the previous file');

  // Let run 2 finish completely, then resume run 1 at its parked await.
  pending[1]('blob:b');
  await settle();
  pending[0]('blob:a');
  await settle();

  // A.md has TWO images, so a run 1 that ignored the generation guard would have
  // created its second mark here — after run 2 had already reset the registry.
  assert.equal(created.length, 2, 'the superseded run must not create further marks');
  assert.equal(created[0].cleared, true);
  assert.equal(created[1].cleared, false, 'the live run’s mark must survive');
});