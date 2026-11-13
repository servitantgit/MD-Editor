// editor-cm6.js
// Experimental CodeMirror 6 editor. Loaded ONLY via dynamic import when ?editor=cm6.
// Classic EasyMDE path never imports this module.

/**
 * @returns {Promise<{ EditorView: any, EditorState: any, basicSetup: any }>}
 */
async function loadCm6Modules() {
  // esm.sh (jsdelivr +esm for codemirror@6 returns 404).
  const mod = await import('https://esm.sh/codemirror@6');
  const stateMod = await import('https://esm.sh/@codemirror/state@6');
  const EditorView = mod.EditorView;
  const basicSetup = mod.basicSetup;
  const EditorState = stateMod.EditorState;
  if (!EditorView || !EditorState || !basicSetup) {
    throw new Error('CodeMirror 6 modules incomplete from CDN');
  }
  return { EditorView, EditorState, basicSetup };
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} deps same shape as createEditor deps (onChange, …)
 */
export async function createCm6Editor(hostEl, deps) {
  const { EditorView, EditorState, basicSetup } = await loadCm6Modules();

  hostEl.innerHTML = '';
  hostEl.hidden = false;

  let suppressChange = false;
  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || suppressChange) return;
    if (typeof deps.onChange === 'function') {
      try { deps.onChange(update.state.doc.toString()); } catch (_) { /* ignore */ }
    }
  });

  function makeState(text) {
    return EditorState.create({
      doc: text == null ? '' : String(text),
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
            backgroundColor: '#0d1117',
            color: '#e6edf3',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          },
          '.cm-content': { caretColor: '#e6edf3' },
          '&.cm-focused .cm-cursor': { borderLeftColor: '#e6edf3' },
          '.cm-gutters': {
            backgroundColor: '#0d1117',
            color: '#7d8590',
            border: 'none',
          },
        }, { dark: true }),
        updateListener,
      ],
    });
  }

  const view = new EditorView({
    state: makeState(''),
    parent: hostEl,
  });

  /** @type {WeakMap<object, string>} */
  const docText = new WeakMap();

  function getValue() {
    return view.state.doc.toString();
  }

  function setValue(text) {
    const next = text == null ? '' : String(text);
    if (getValue() === next) return;
    suppressChange = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    } finally {
      suppressChange = false;
    }
  }

  function refreshLayout() {
    try { view.requestMeasure(); } catch (_) { /* ignore */ }
  }

  function createDoc(text) {
    const doc = { __cm6: true, text: text == null ? '' : String(text) };
    docText.set(doc, doc.text);
    return doc;
  }

  function getDoc() {
    return createDoc(getValue());
  }

  function showDoc(doc) {
    let text = '';
    if (doc && typeof doc === 'object' && doc.__cm6) {
      text = docText.has(doc) ? docText.get(doc) : (doc.text || '');
    } else if (doc && typeof doc.getValue === 'function') {
      try { text = doc.getValue(); } catch (_) { text = ''; }
    } else if (typeof doc === 'string') {
      text = doc;
    }
    setValue(text);
    refreshLayout();
  }

  // Minimal CM5-shaped adapter so existing call sites don't throw.
  const codemirror = {
    getValue,
    setValue,
    getDoc,
    swapDoc(doc) {
      const prev = createDoc(getValue());
      showDoc(doc);
      return prev;
    },
    refresh: refreshLayout,
    focus() { view.focus(); },
    getCursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number - 1, ch: head - line.from };
    },
    setCursor(pos) {
      try {
        const line = view.state.doc.line((pos.line || 0) + 1);
        const ch = Math.min(pos.ch || 0, line.length);
        const head = line.from + ch;
        view.dispatch({ selection: { anchor: head, head } });
      } catch (_) { /* ignore */ }
    },
    lineCount() { return view.state.doc.lines; },
    getLine(i) {
      try { return view.state.doc.line(i + 1).text; } catch (_) { return ''; }
    },
    somethingSelected() {
      return view.state.selection.main.from !== view.state.selection.main.to;
    },
    getWrapperElement() { return hostEl; },
    getScrollerElement() { return view.scrollDOM; },
    getInputField() { return hostEl; },
    on() {},
    off() {},
    addKeyMap() {},
    removeKeyMap() {},
    setOption() {},
    getOption() { return null; },
    operation(fn) { return fn(); },
  };

  const easyMDE = {
    codemirror,
    value(v) {
      if (arguments.length === 0) return getValue();
      setValue(v);
      return undefined;
    },
    options: { previewRender() { return null; } },
    isSideBySideActive() { return false; },
    isPreviewActive() { return false; },
    toggleSideBySide() {},
    togglePreview() {},
    toTextArea() {},
  };

  function noopFindState() {
    return { mode: 'find', query: '', total: 0, current: 0 };
  }

  return {
    engine: 'cm6',
    easyMDE,
    view,
    refreshLayout,
    refreshInlineImages() {},
    createDoc,
    getDoc,
    showDoc,
    renderActivePreview() {},
    renderHtmlPreview() { return Promise.resolve(null); },
    setLanguage() {},
    setToolbarForKind() {},
    findInFile() { return noopFindState(); },
    findFromSearch() { return noopFindState(); },
    nextFind() { return noopFindState(); },
    getFindState: noopFindState,
    setFindQuery() { return noopFindState(); },
    replaceInFile() { return noopFindState(); },
    replaceAllInFile() { return noopFindState(); },
    clearFind() {},
    getFindMapState() { return { lines: [], currentLine: null }; },
    toggleLineWrapping() { return true; },
    toggleHeadingFolds() { return false; },
    unfoldAtLine() {},
    destroy() {
      try { view.destroy(); } catch (_) { /* ignore */ }
      hostEl.innerHTML = '';
    },
  };
}
