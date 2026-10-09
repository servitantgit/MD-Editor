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
  // html-preview.js needs DOMParser to inject the height/link bridge into srcdoc
  globalThis.DOMParser = dom.window.DOMParser;
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

  // A.md: run 1 marks both images immediately, then the resolves park.
  currentPath = 'A.md';
  handle.refreshInlineImages();
  await settle();
  assert.equal(created.length, 2, 'run 1 should have marked A.md’s both images');
  const firstMark = created[0];
  const secondMark = created[1];

  // The user opens B.md before any resolve fires.
  currentPath = 'B.md';
  handle.refreshInlineImages();
  await settle();
  assert.equal(created.length, 3, 'run 2 should have marked B.md’s image');
  assert.equal(firstMark.cleared, true, 'run 2 must clear the marks of the previous file');
  assert.equal(secondMark.cleared, true, 'run 2 must clear every mark of the previous file');

  // Let run 2 finish completely, then resume run 1 at its parked awaits.
  pending[1]('blob:b');
  await settle();
  pending[0]('blob:a');
  await settle();

  // A.md has TWO images, so a run 1 that ignored the generation guard would have
  // created further marks here — after run 2 had already reset the registry.
  assert.equal(created.length, 3, 'the superseded run must not create further marks');
  assert.equal(firstMark.cleared, true);
  assert.equal(secondMark.cleared, true);
  assert.equal(created[2].cleared, false, 'the live run’s mark must survive');
});

test('Source shows each image as a LINK with filename and location, never as a picture', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const DOC = 'intro\n\n![diagram](../img/flow.png)\n\n![logo](https://cdn.example.com/assets/logo.svg)\n';
  let currentPath = null; // nothing open while createEditor() runs its own first render
  const { codemirror } = installEnvironment(dom, { text: () => DOC });
  const widgets = [];
  codemirror.posFromIndex = (i) => ({ line: 0, ch: i });
  codemirror.markText = (from, to, opts) => {
    if (opts && opts.replacedWith) widgets.push(opts.replacedWith);
    return { clear() {}, find() { return true; } };
  };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    imageResolver: { resolve: async (src) => (src.startsWith('http') ? src : 'data:image/png;base64,QUJD') },
    getCurrentPath: () => currentPath,
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });

  currentPath = 'docs/guide/readme.md';
  handle.refreshInlineImages();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(widgets.length, 2, 'both images must be replaced by widgets');
  for (const w of widgets) {
    assert.equal(w.querySelector('img'), null, 'Source must not render a picture');
  }

  const [internal, external] = widgets;
  const inLink = internal.querySelector('a.cm-inline-image-link');
  assert.ok(inLink, 'the repo image must render as a link');
  assert.equal(inLink.querySelector('.cm-inline-image-filename').textContent, 'flow.png',
    'the link must show the file name');
  assert.equal(inLink.querySelector('.cm-inline-image-path').textContent, 'docs/img/flow.png',
    'the link must show where the file lives (resolved against the open file)');
  assert.equal(inLink.getAttribute('href'), 'data:image/png;base64,QUJD',
    'the processed URL must land in the href');

  const exLink = external.querySelector('a.cm-inline-image-link');
  assert.ok(exLink, 'the external image must render as a link');
  assert.equal(exLink.querySelector('.cm-inline-image-filename').textContent, 'logo.svg');
  assert.equal(exLink.querySelector('.cm-inline-image-path').textContent,
    'https://cdn.example.com/assets/logo.svg');

  handle.destroy();
});

test('showDoc() swaps the document, refreshes layout, and re-renders the Preview pane when it is showing', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  let shown = 'FIRST DOCUMENT';
  const { easyMDE, codemirror } = installEnvironment(dom, { text: () => shown });

  const previewEl = dom.window.document.createElement('div');
  previewEl.className = 'editor-preview editor-preview-active';
  previewEl.innerHTML = '<p>FIRST DOCUMENT</p>';
  previewEl.scrollTop = 400;
  const wrapper = dom.window.document.createElement('div');
  wrapper.appendChild(previewEl);

  class FakeDoc { constructor(text) { this.text = text; } }
  Object.defineProperty(codemirror, 'constructor', { value: { Doc: FakeDoc } });
  codemirror.getOption = () => 'gfm';
  codemirror.getWrapperElement = () => wrapper;
  const swaps = [];
  codemirror.swapDoc = (doc) => { swaps.push(doc); shown = doc.text; return { text: 'old' }; };

  let previewActive = true;
  easyMDE.isPreviewActive = () => previewActive;
  easyMDE.value = () => shown;
  const rendered = [];
  easyMDE.options = { previewRender: (text) => { rendered.push(text); return `<p>${text}</p>`; } };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => null,
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });

  const doc = handle.createDoc('SECOND DOCUMENT');
  assert.ok(doc instanceof FakeDoc, 'createDoc builds a CodeMirror Doc');
  assert.equal(doc.text, 'SECOND DOCUMENT');

  const refreshesBefore = codemirror.refreshes;
  const previous = handle.showDoc(doc);
  assert.deepEqual(swaps, [doc]);
  assert.deepEqual(previous, { text: 'old' }, 'the document that was showing is handed back to the caller');
  assert.ok(codemirror.refreshes > refreshesBefore, 'layout is refreshed after the swap');
  assert.equal(previewEl.innerHTML, '<p>SECOND DOCUMENT</p>',
    'Preview kept showing the previous document: tab switching never reached it');
  assert.equal(previewEl.scrollTop, 0, 'a new document starts at the top of the preview');
  assert.deepEqual(rendered, ['SECOND DOCUMENT']);

  // With Preview off nothing is rendered or touched: the editor itself shows the doc.
  previewActive = false;
  previewEl.innerHTML = '<p>untouched</p>';
  handle.showDoc(handle.createDoc('THIRD DOCUMENT'));
  assert.equal(previewEl.innerHTML, '<p>untouched</p>');
  assert.deepEqual(rendered, ['SECOND DOCUMENT']);

  handle.destroy();
});

test('HTML preview fills BOTH panes on every render pass (no alternating starve)', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { easyMDE, codemirror } = installEnvironment(dom);

  // Real EasyMDE layout: .CodeMirror wrapper + TWO preview nodes under
  // .EasyMDEContainer — .editor-preview-side (Live/Preview visible pane) and
  // .editor-preview (full-preview pane). renderActivePreview loops over BOTH
  // in one tick; a global render token used to let only the LAST pane win and
  // starve the first one — the "renders once, then not, then renders again"
  // cycle on Live/Preview switches.
  const container = dom.window.document.createElement('div');
  container.className = 'EasyMDEContainer';
  const cmWrap = dom.window.document.createElement('div');
  cmWrap.className = 'CodeMirror';
  const sidePane = dom.window.document.createElement('div');
  sidePane.className = 'editor-preview-side';
  const fullPane = dom.window.document.createElement('div');
  fullPane.className = 'editor-preview';
  container.appendChild(cmWrap);
  container.appendChild(sidePane);
  container.appendChild(fullPane);
  dom.window.document.body.appendChild(container);
  codemirror.getWrapperElement = () => cmWrap;

  const htmlDoc = '<h1>Hello HTML</h1><p>HTML_PAGE_OK</p>';
  easyMDE.isSideBySideActive = () => true;
  easyMDE.isPreviewActive = () => false;
  easyMDE.value = () => htmlDoc;
  // renderActivePreview calls easyMDE.options.previewRender — capture the real
  // options object createEditor passes to `new EasyMDE(...)` (the fake
  // constructor ignores it by default) and replay it onto the fake.
  easyMDE.options = {};
  let capturedPreviewRender = null;
  const origEasyMDE = globalThis.EasyMDE;
  globalThis.EasyMDE = function (opts) {
    capturedPreviewRender = opts && opts.previewRender;
    return origEasyMDE();
  };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => 'Notes/page.html',
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });
  // Point the fake at the real previewRender built inside createEditor.
  easyMDE.options.previewRender = capturedPreviewRender;
  globalThis.EasyMDE = origEasyMDE;
  assert.equal(typeof easyMDE.options.previewRender, 'function', 'harness must capture the real previewRender');

  const settle = async () => {
    // previewRender defers the iframe to the next tick; buildHtmlSrcdoc's
    // .then lands a tick or two later.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 20));
  };
  const srcdocOf = (pane) => {
    const f = pane.querySelector('iframe.html-preview-frame');
    return f ? (f.srcdoc || '') : null;
  };

  // One production render pass: EasyMDE calls previewRender for EVERY pane in
  // the same tick (renderActivePreview / sideBySideRenderingFunction), then
  // (for HTML) our async funnel fills the iframes.
  const renderPass = async () => {
    handle.renderActivePreview();
    await settle();
  };

  // Pass 1: both panes start empty and must BOTH end up holding the page.
  await renderPass();
  assert.ok((srcdocOf(sidePane) || '').includes('HTML_PAGE_OK'),
    'visible side pane is empty after the first render (token starve)');
  assert.ok((srcdocOf(fullPane) || '').includes('HTML_PAGE_OK'),
    'full preview pane is empty after the first render');

  // Pass 2: the alternating bug showed on the SECOND switch — re-render must
  // keep both panes alive, not leave one behind.
  await renderPass();
  assert.ok((srcdocOf(sidePane) || '').includes('HTML_PAGE_OK'),
    'side pane went empty on the second render pass (the alternating bug)');
  assert.ok((srcdocOf(fullPane) || '').includes('HTML_PAGE_OK'),
    'full pane went empty on the second render pass');

  // Hammer: five rapid passes, as when flipping Live/Preview quickly.
  for (let i = 0; i < 5; i++) await renderPass();
  assert.ok((srcdocOf(sidePane) || '').includes('HTML_PAGE_OK'),
    'side pane lost content after rapid Live/Preview flips');
  assert.ok((srcdocOf(fullPane) || '').includes('HTML_PAGE_OK'),
    'full pane lost content after rapid Live/Preview flips');

  // EasyMDE's own single-pane update path (sideBySideRenderingFunction) does
  // preview.innerHTML = return directly — for HTML the return must be null so
  // the wipe is SKIPPED. Simulate the exact EasyMDE line:
  //   var newValue = previewRender(...); if (newValue != null) preview.innerHTML = newValue;
  const ret = easyMDE.options.previewRender(htmlDoc, sidePane);
  if (ret != null) sidePane.innerHTML = ret; // EasyMDE's own write, verbatim
  await settle();
  assert.ok((srcdocOf(sidePane) || '').includes('HTML_PAGE_OK'),
    'EasyMDE-style write must not wipe the HTML pane (previewRender must return null for HTML)');

  handle.destroy();
});

test('Live/Preview switching with unchanged text NEVER reloads the HTML iframe (flicker)', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { easyMDE, codemirror } = installEnvironment(dom);

  const container = dom.window.document.createElement('div');
  container.className = 'EasyMDEContainer';
  const cmWrap = dom.window.document.createElement('div');
  cmWrap.className = 'CodeMirror';
  const sidePane = dom.window.document.createElement('div');
  sidePane.className = 'editor-preview-side';
  const fullPane = dom.window.document.createElement('div');
  fullPane.className = 'editor-preview';
  container.appendChild(cmWrap);
  container.appendChild(sidePane);
  container.appendChild(fullPane);
  dom.window.document.body.appendChild(container);
  codemirror.getWrapperElement = () => cmWrap;

  let htmlDoc = '<h1>Hello HTML</h1><p>HTML_PAGE_OK</p>';
  easyMDE.isSideBySideActive = () => true;
  easyMDE.isPreviewActive = () => false;
  easyMDE.value = () => htmlDoc;
  easyMDE.options = {};
  let capturedPreviewRender = null;
  const origEasyMDE = globalThis.EasyMDE;
  globalThis.EasyMDE = function (opts) {
    capturedPreviewRender = opts && opts.previewRender;
    return origEasyMDE();
  };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => 'Notes/page.html',
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });
  easyMDE.options.previewRender = capturedPreviewRender;
  globalThis.EasyMDE = origEasyMDE;

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 20));
  };
  const renderPass = async () => { handle.renderActivePreview(); await settle(); };
  const srcdocOf = (pane) => {
    const f = pane.querySelector('iframe.html-preview-frame');
    return f ? (f.srcdoc || '') : null;
  };

  // First render fills the pane (this one may reload — the pane was empty).
  await renderPass();
  const first = srcdocOf(sidePane);
  assert.ok((first || '').includes('HTML_PAGE_OK'), 'precondition: first render must fill the side pane');

  // Count every srcdoc assignment on the LIVE iframe. Each assignment is a
  // full iframe navigation → a visible flash in the preview.
  let sets = 0;
  const frame = sidePane.querySelector('iframe.html-preview-frame');
  const proto = Object.getOwnPropertyDescriptor(dom.window.HTMLIFrameElement.prototype, 'srcdoc');
  assert.ok(proto && typeof proto.set === 'function', 'jsdom must expose srcdoc accessor');
  Object.defineProperty(frame, 'srcdoc', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { sets++; proto.set.call(this, v); },
  });

  // Simulate Live/Preview toggles: renderActivePreview fires (EasyMDE update,
  // forceLayout nudge) several times per click — text is UNCHANGED, so the
  // iframe must not be touched at all. Production flashes 2-3 times here.
  for (let i = 0; i < 3; i++) await renderPass();
  assert.equal(sets, 0,
    `iframe reloaded ${sets}x on Live/Preview toggles with unchanged text — that's the visible flicker`);
  assert.ok((srcdocOf(sidePane) || '').includes('HTML_PAGE_OK'),
    'content must survive the toggles');

  // Real content change must still reach the iframe.
  htmlDoc = '<h1>Changed</h1><p>SECOND_VERSION</p>';
  await renderPass();
  assert.ok(sets >= 1, 'an edited document must reload the iframe');
  assert.ok((srcdocOf(sidePane) || '').includes('SECOND_VERSION'),
    'edited content must be shown after the reload');

  handle.destroy();
});

test('height handshake: md-editor-frame-height sizes the HTML iframe (single pane scrollbar)', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { easyMDE, codemirror } = installEnvironment(dom);

  const container = dom.window.document.createElement('div');
  container.className = 'EasyMDEContainer';
  const cmWrap = dom.window.document.createElement('div');
  cmWrap.className = 'CodeMirror';
  const sidePane = dom.window.document.createElement('div');
  sidePane.className = 'editor-preview-side';
  const fullPane = dom.window.document.createElement('div');
  fullPane.className = 'editor-preview';
  container.appendChild(cmWrap);
  container.appendChild(sidePane);
  container.appendChild(fullPane);
  dom.window.document.body.appendChild(container);
  codemirror.getWrapperElement = () => cmWrap;

  const htmlDoc = '<h1>Hello HTML</h1><p>HTML_PAGE_OK</p>';
  easyMDE.isSideBySideActive = () => true;
  easyMDE.isPreviewActive = () => false;
  easyMDE.value = () => htmlDoc;
  easyMDE.options = {};
  let capturedPreviewRender = null;
  const origEasyMDE = globalThis.EasyMDE;
  globalThis.EasyMDE = function (opts) {
    capturedPreviewRender = opts && opts.previewRender;
    return origEasyMDE();
  };

  const { createEditor } = await import('../js/editor.js');
  const handle = createEditor(dom.window.document.createElement('textarea'), {
    marked: {},
    imageResolver: { resolve: async () => '' },
    getCurrentPath: () => 'Notes/page.html',
    onImageUploadRequest: () => {},
    onImagePaste: () => {},
  });
  easyMDE.options.previewRender = capturedPreviewRender;
  globalThis.EasyMDE = origEasyMDE;

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 20));
  };

  handle.renderActivePreview();
  await settle();
  const frame = sidePane.querySelector('iframe.html-preview-frame');
  assert.ok(frame, 'iframe must be created in the side pane');
  const srcdoc = frame.srcdoc || '';
  // The parent cannot measure an opaque-origin sandboxed frame, so the frame
  // reports its own document height — the bridge below is what schedules the
  // postMessage that the parent listener (onParentMessage) reacts to.
  assert.ok(srcdoc.includes('md-editor-frame-height'),
    'srcdoc bridge must report the document height — a sandboxed frame (opaque origin) cannot be measured from the parent');
  assert.ok(srcdoc.includes('__mdPostHeight'),
    'bridge script must POST the document height (load + ResizeObserver + immediate)');

  // Emulate what a real browser does with srcdoc: the frame posts its height
  // from its own window, the parent handler matches it by contentWindow and
  // grows the iframe so the preview PANE scrolls the whole document (one
  // scrollbar, like markdown — no inner frame scrollbar).
  const frameWin = frame.contentWindow;
  assert.ok(frameWin, 'iframe must have a contentWindow');
  // Optional second arg = MessageEvent.source. Defaults to this frame's window.
  // A foreign/null source must be ignored by onParentMessage (contentWindow match).
  const postHeight = (height, source = frameWin) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'md-editor-frame-height', height },
      source,
    }));
  };

  // The frame grows to its document; the PANE then scrolls it — one scrollbar
  // (like markdown), and the minimap's preview-pane tracking works unchanged.
  postHeight(2400);
  assert.equal(frame.style.getPropertyValue('height'), '2400px',
    'frame-height message must size the iframe so the pane scrolls the whole document');
  assert.equal(frame.style.getPropertyPriority('height'), 'important',
    'inline height must be !important — app.css sets height:100%!important and would win the cascade otherwise');

  // Garbage / foreign posts must not resize our frame.
  postHeight(0);
  postHeight('x');
  postHeight(-5);
  postHeight(1e12); // above the 1e6 hard cap in onParentMessage
  assert.equal(frame.style.getPropertyValue('height'), '2400px',
    'invalid heights must not resize the frame');
  // Explicit foreign source — previously postHeight ignored the 2nd arg, so
  // this still arrived as source:frameWin and legitimately set 9999px.
  postHeight(9999, null);
  assert.equal(frame.style.getPropertyValue('height'), '2400px',
    'messages from other sources must be ignored');
  postHeight(8888, {}); // object that is not this frame's contentWindow
  assert.equal(frame.style.getPropertyValue('height'), '2400px',
    'messages from non-matching sources must be ignored');

  handle.destroy();
});


