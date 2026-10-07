// editor.js
// Wrapper around EasyMDE. The most important thing here is correct CodeMirror handling:
// * .refresh() after the container becomes visible and gets its real size
//   (the classic reason the editor "doesn't scroll"/shows 1 line — CodeMirror
//   measured the container height BEFORE it was displayed/got its final layout);
// * previewRender wired via the async pattern documented by EasyMDE itself.

import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { attachResizeHandles, resolveAllImages } from './image-preview.js';
import { kindFromPath } from './file-kind.js';

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{marked: any, imageResolver: import('./image-resolver.js').ImageResolver, getCurrentPath: () => string|null, onImageUploadRequest: () => void}} deps
 */
export function createEditor(textareaEl, deps) {
  let previewRenderToken = 0;
  let inlineImageGeneration = 0;
  let inlineImageMarks = [];
  let inlineImageTimer = null;
  let lastInlineImageKey = '';

  const easyMDE = new EasyMDE({
    element: textareaEl,
    spellChecker: false,
    autosave: { enabled: false },
    // Keep side-by-side inside .editor-area so the file tree stays clickable
    // (EasyMDE default is fullscreen fixed overlay that steals all pointer events).
    sideBySideFullscreen: false,
    placeholder: 'Start writing…',
    // Layout (Source / Live / Preview) is owned by the app header — do NOT put
    // EasyMDE's preview / side-by-side here: they fight our modes and only work
    // cleanly in Source. Fullscreen stays; F9/F10 EasyMDE shortcuts are disabled.
    toolbar: [
      'bold', 'italic', 'heading', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'link',
      {
        name: 'image',
        action: () => deps.onImageUploadRequest(),
        className: 'fa fa-image',
        title: 'Add an image to the repository',
      }, '|',
      'fullscreen', '|',
      'guide',
    ],
    shortcuts: {
      toggleSideBySide: null,
      togglePreview: null,
      // keep toggleFullScreen default (F11 / toolbar button)
    },
    status: ['lines', 'words', 'cursor'],
    renderingConfig: { singleLineBreaks: false, codeSyntaxHighlighting: true },
    previewRender(plainText, previewEl) {
      // IMPORTANT: EasyMDE ITSELF runs `previewEl.innerHTML = <what we return here>`
      // right after this function is called. Post-processing runs on the next tick.
      const myToken = ++previewRenderToken;
      const path = deps.getCurrentPath ? deps.getCurrentPath() : null;
      const kind = kindFromPath(path || '');

      // HTML: sandboxed iframe (filled after EasyMDE writes our return value)
      if (kind.preview === 'html') {
        setTimeout(() => {
          if (myToken !== previewRenderToken || !previewEl) return;
          const iframe = document.createElement('iframe');
          iframe.className = 'html-preview-frame';
          iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
          iframe.setAttribute('title', 'HTML preview');
          iframe.srcdoc = plainText || '<!-- empty -->';
          previewEl.innerHTML = '';
          previewEl.appendChild(iframe);
        }, 0);
        return '';
      }

      // Code / plain text: highlighted read-only view
      if (kind.preview === 'code') {
        const lang = kind.ext || 'txt';
        const body = escapeHtml(plainText || '');
        const html = `<pre class="code-preview"><code class="language-${escapeHtml(lang)}">${body}</code></pre>`;
        setTimeout(() => {
          if (myToken !== previewRenderToken || !previewEl) return;
          try {
            if (typeof globalThis.hljs !== 'undefined') {
              previewEl.querySelectorAll('pre code').forEach((block) => {
                try { globalThis.hljs.highlightElement(block); } catch (_) {}
              });
            }
          } catch (_) {}
        }, 0);
        return html;
      }

      // Markdown (default)
      let html;
      try {
        html = markdownToCanonicalHtml(plainText, deps.marked);
      } catch (e) {
        console.error('Preview render error:', e);
        return `<div class="render-error"><strong>⚠ Preview render error</strong><br>${escapeHtml(e.message)}</div>`;
      }
      setTimeout(() => finishPreviewRender(previewEl, myToken), 0);
      return html;
    },
  });


  // Expose EasyMDE's CodeMirror so optional mode scripts can register
  try {
    if (typeof globalThis.CodeMirror === 'undefined' && easyMDE.codemirror) {
      globalThis.CodeMirror = easyMDE.codemirror.constructor;
    }
  } catch (_) { /* ignore */ }

  // Lazy-load common CodeMirror modes once (Notepad++ language pack feel)
  let modesLoadStarted = false;
  function ensureCodeMirrorModes() {
    if (modesLoadStarted || typeof globalThis.CodeMirror === 'undefined') return;
    modesLoadStarted = true;
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode';
    const files = [
      base + '/xml/xml.min.js',
      base + '/javascript/javascript.min.js',
      base + '/css/css.min.js',
      base + '/htmlmixed/htmlmixed.min.js',
      base + '/python/python.min.js',
      base + '/shell/shell.min.js',
      base + '/yaml/yaml.min.js',
    ];
    for (const src of files) {
      if (document.querySelector(`script[data-cm-mode="${src}"]`)) continue;
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.cmMode = src;
      document.head.appendChild(s);
    }
  }

  async function finishPreviewRender(previewEl, myToken) {
    if (myToken !== previewRenderToken) return; // a newer render arrived meanwhile
    // Notepad++-style readability: highlight fenced code in the rendered preview
    try {
      if (typeof globalThis.hljs !== 'undefined' && previewEl) {
        previewEl.querySelectorAll('pre code').forEach((block) => {
          try { globalThis.hljs.highlightElement(block); } catch (_) { /* ignore single block */ }
        });
      }
    } catch (_) { /* hljs optional */ }
    attachResizeHandles(previewEl, easyMDE.codemirror);

    const failCount = await resolveAllImages(previewEl, deps.imageResolver, deps.getCurrentPath(), () => myToken === previewRenderToken);
    if (myToken === previewRenderToken && failCount > 0 && deps.onImageResolveFailures) {
      deps.onImageResolveFailures(failCount);
    }
  }

  /**
   * CodeMirror sometimes measures the container height before it gets its final
   * size (flex layout, hidden parents, etc.) and gets "stuck" with
   * wrong internal geometry — hence the impression that the editor doesn't scroll
   * or shows only part of the text. .refresh() forces a full recalculation.
   * We call it both immediately and once more on the next frame (for absolute reliability).
   */
  function refreshLayout() {
    easyMDE.codemirror.refresh();
    requestAnimationFrame(() => easyMDE.codemirror.refresh());
  }

  // Pasting images from the clipboard: the browser passes screenshots/copied pictures
  // as ClipboardItem/Files. We don't intercept text pasting.
  const inputField = easyMDE.codemirror.getInputField();
  const onPaste = (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;

    event.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) deps.onImagePaste(file);
    }
  };
  inputField.addEventListener('paste', onPaste);

  // React to window/container resizing — the same class of problems.
  // Live Preview right in the text field: the Markdown image link
  // stays in the document but is visually replaced in CodeMirror by the real
  // picture. This doesn't change the text that will be saved to GitHub.
  //
  // `deps.onChange` is the autosave hook. It runs AFTER the inline-image render
  // is scheduled, and it does nothing but arm its own timers, so the two
  // concerns stay independent — neither one delays the other.
  const onChange = () => {
    scheduleInlineImages();
    if (deps.onChange) deps.onChange(easyMDE.codemirror.getValue());
  };
  easyMDE.codemirror.on('change', onChange);

  const resizeObserver = new ResizeObserver(() => refreshLayout());
  resizeObserver.observe(textareaEl.closest('.editor-area') || document.body);

  function scheduleInlineImages() {
    clearTimeout(inlineImageTimer);
    inlineImageTimer = setTimeout(() => renderInlineImages(), 200);
  }

  async function renderInlineImages() {
    const cm = easyMDE.codemirror;
    const currentPath = deps.getCurrentPath();

    if (!currentPath) {
      for (const mark of inlineImageMarks) {
        try { mark.clear(); } catch (_) {}
      }
      inlineImageMarks = [];
      lastInlineImageKey = '';
      return;
    }

    const text = cm.getValue();
    const re = /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)/g;
    const matches = [];
    let match;
    while ((match = re.exec(text))) {
      matches.push({
        fromIndex: match.index,
        toIndex: match.index + match[0].length,
        alt: match[1] || '',
        src: match[2],
        raw: match[0],
      });
    }

    // Key by image *content*, not absolute indices. CodeMirror marks already
    // track document edits; rebuilding on every Space/Backspace (index shift)
    // was jumping the viewport to the end of the page.
    const key = matches.map((m) => m.raw).join('\0');
    if (key === lastInlineImageKey && inlineImageMarks.length === matches.length) {
      const alive = inlineImageMarks.every((m) => {
        try { return m.find() != null; } catch (_) { return false; }
      });
      if (alive) return;
    }

    const scroll = typeof cm.getScrollInfo === 'function' ? cm.getScrollInfo() : null;
    const selections = typeof cm.listSelections === 'function' ? cm.listSelections() : null;
    const generation = ++inlineImageGeneration;
    lastInlineImageKey = key;

    for (const mark of inlineImageMarks) {
      try { mark.clear(); } catch (_) {}
    }
    inlineImageMarks = [];

    const restoreView = () => {
      try {
        if (selections && selections.length && typeof cm.setSelections === 'function') {
          cm.setSelections(selections);
        }
        if (scroll && typeof cm.scrollTo === 'function') {
          cm.scrollTo(scroll.left, scroll.top);
        }
      } catch (_) { /* ignore */ }
    };

    for (const item of matches) {
      if (generation !== inlineImageGeneration) return;

      const from = typeof cm.posFromIndex === 'function' ? cm.posFromIndex(item.fromIndex) : { line: 0, ch: item.fromIndex };
      const to = typeof cm.posFromIndex === 'function' ? cm.posFromIndex(item.toIndex) : { line: 0, ch: item.toIndex };
      const wrapper = document.createElement('span');
      wrapper.className = 'cm-inline-image';
      wrapper.title = item.src;
      wrapper.style.display = 'inline-block';
      wrapper.style.verticalAlign = 'middle';
      wrapper.style.minHeight = '24px';

      const img = document.createElement('img');
      img.alt = item.alt;
      img.className = 'cm-inline-image-img';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '420px';
      img.style.height = 'auto';
      img.style.display = 'block';

      const loading = document.createElement('span');
      loading.className = 'cm-inline-image-loading';
      loading.textContent = '⏳';
      wrapper.append(img, loading);

      let mark;
      try {
        mark = cm.markText(from, to, {
          replacedWith: wrapper,
          clearOnEnter: false,
          atomic: true,
          handleMouseEvents: true,
        });
      } catch (_) {
        continue;
      }
      inlineImageMarks.push(mark);

      Promise.resolve()
        .then(() => deps.imageResolver.resolve(item.src, currentPath))
        .then((url) => {
          if (generation !== inlineImageGeneration) return;
          try { if (!mark.find()) return; } catch (_) { return; }
          img.src = url;
          img.onload = () => {
            try { loading.remove(); } catch (_) {}
            // Image height change must not yank the viewport
            restoreView();
          };
          img.onerror = () => {
            try { if (mark.find()) mark.clear(); } catch (_) {}
          };
        })
        .catch((err) => {
          if (generation !== inlineImageGeneration) return;
          try { if (mark.find()) mark.clear(); } catch (_) {}
          console.warn('Failed to show inline image:', item.src, err);
        });
    }

    restoreView();
    requestAnimationFrame(restoreView);
  }

  function refreshInlineImages() {
    clearTimeout(inlineImageTimer);
    inlineImageTimer = null;
    lastInlineImageKey = ''; // force rebuild (tab switch / explicit refresh)
    renderInlineImages();
  }

  refreshInlineImages();

  // ---- One CodeMirror document per open tab -------------------------------
  // `easyMDE.value(text)` would REPLACE the text of the single document, which
  // throws away undo history, cursor and scroll position — exactly what a tab is
  // supposed to keep. Each tab owns its own Doc instead and the editor merely
  // shows one of them. swapDoc() does not fire 'change', so switching tabs is not
  // mistaken for typing; the caller still guards programmatic edits itself.

  /** A fresh, empty-history document holding `text` (not attached to the editor). */
  function createDoc(text) {
    const cm = easyMDE.codemirror;
    const Doc = cm.constructor && cm.constructor.Doc;
    if (typeof Doc !== 'function') throw new Error('CodeMirror.Doc is not available');
    return new Doc(text, cm.getOption('mode'));
  }

  /** The document the editor is showing right now. */
  function getDoc() {
    return easyMDE.codemirror.getDoc();
  }

  /**
   * Shows `doc` in the editor and returns the document that was showing before.
   * Inline image previews belong to the document they were drawn in, so they are
   * rebuilt for the new one (and the old marks cleared, not left behind).
   */
  function showDoc(doc) {
    const previous = easyMDE.codemirror.swapDoc(doc);
    refreshLayout();
    renderActivePreview();
    refreshInlineImages();
    return previous;
  }

  /**
   * `easyMDE.value(text)` re-renders the Preview pane when it is showing; swapDoc()
   * goes around value(), so without this Preview keeps displaying the document that
   * was open when it was switched on: the tab and the file name change, the page
   * does not. (Side-by-side re-renders itself from CodeMirror's 'update' event.)
   * This mirrors what EasyMDE's own value() does for the full Preview pane.
   */
  /**
   * EasyMDE puts the full-preview pane as a SIBLING of .CodeMirror inside
   * .EasyMDEContainer (class .editor-preview / .editor-preview-active), NOT as
   * CodeMirror's lastChild. Writing into lastChild left the visible pane empty.
   */
  function findPreviewElements() {
    const wrap = easyMDE.codemirror && easyMDE.codemirror.getWrapperElement
      ? easyMDE.codemirror.getWrapperElement()
      : null;
    if (!wrap) return [];

    const sel = '.editor-preview-active, .editor-preview-active-side, .editor-preview-side, .editor-preview';
    // Real EasyMDE: preview is a sibling of .CodeMirror under .EasyMDEContainer
    const root = (typeof wrap.closest === 'function' && wrap.closest('.EasyMDEContainer'))
      || wrap.parentElement
      || null;
    if (root) {
      const fromRoot = Array.from(root.querySelectorAll(sel));
      if (fromRoot.length) return fromRoot;
    }
    // Unit test / alternate layout: preview is a child of the CodeMirror wrapper
    const fromWrap = Array.from(wrap.querySelectorAll(sel));
    if (fromWrap.length) return fromWrap;
    // Last-resort legacy: whatever is lastChild of the wrapper
    if (wrap.lastChild && wrap.lastChild.nodeType === 1) return [wrap.lastChild];
    return [];
  }

  function renderActivePreview() {
    // Trust EasyMDE flags only. The unit test keeps class "editor-preview-active"
    // on the node while isPreviewActive() is false — class must not override the flag.
    const sideOn = typeof easyMDE.isSideBySideActive === 'function' && easyMDE.isSideBySideActive();
    const prevOn = typeof easyMDE.isPreviewActive === 'function' && easyMDE.isPreviewActive();
    if (!sideOn && !prevOn) return;

    const list = findPreviewElements();
    if (!list.length) return;

    const plain = easyMDE.value();
    for (const preview of list) {
      const html = easyMDE.options.previewRender(plain, preview);
      if (html !== null && html !== undefined) preview.innerHTML = html;
      preview.scrollTop = 0;
    }
  }

  /**
   * Releases everything createEditor() attached. Without it there is no way to
   * get rid of this instance: the ResizeObserver keeps observing, the paste and
   * 'change' handlers keep running, and `new EasyMDE({element: textareaEl})` on
   * an already-wrapped textarea would stack a second editor on top of the first.
   *
   * Idempotent, and safe to call without a matching createEditor having ever
   * run — teardown code should never be the thing that throws.
   */
  function destroy() {
    resizeObserver.disconnect();
    clearTimeout(inlineImageTimer);
    inlineImageTimer = null;
    inputField.removeEventListener('paste', onPaste);
    easyMDE.codemirror.off('change', onChange);
    for (const mark of inlineImageMarks) mark.clear();
    inlineImageMarks = [];
    // Hand the plain textarea back so a fresh createEditor() can wrap it cleanly.
    try {
      easyMDE.toTextArea();
    } catch (_) {
      // EasyMDE already tore itself down — nothing left to restore.
    }
  }

  /**
   * Switch CodeMirror mode for the open file (Notepad++ language-from-extension).
   * Modes must be registered on the same CodeMirror build EasyMDE uses; unknown
   * modes fall back silently to plain text.
   */
  function setLanguage(modeName) {
    try {
      ensureCodeMirrorModes();
      const cm = easyMDE.codemirror;
      const mode = modeName && modeName !== 'null' ? modeName : 'text/plain';
      const resolved = mode === 'gfm' || mode === 'markdown' ? 'gfm' : mode;
      cm.setOption('mode', resolved);
      // Modes may still be downloading — retry once after a short delay
      setTimeout(() => {
        try {
          cm.setOption('mode', resolved);
          cm.refresh();
        } catch (_) {}
      }, 400);
      cm.refresh();
    } catch (_) { /* mode not loaded — plain text still works */ }
  }

  /**
   * Markdown-only toolbar actions (bold, headings, image, guide) are useless or
   * harmful in HTML/JS/CSS. Disable them when the open file is not markdown.
   */
  function setToolbarForKind(kind) {
    const isMd = !kind || kind.kind === 'markdown';
    const toolbar = document.querySelector('.editor-toolbar');
    if (!toolbar) return;
    const mdOnly = new Set([
      'bold', 'italic', 'heading', 'quote', 'unordered-list', 'ordered-list',
      'link', 'image', 'guide',
    ]);
    toolbar.querySelectorAll('button').forEach((btn) => {
      const name = btn.className || '';
      // EasyMDE buttons: class contains the action name, e.g. "bold", "fa fa-bold"
      let action = null;
      for (const a of mdOnly) {
        if (name.split(/\s+/).includes(a) || btn.title && btn.title.toLowerCase().includes(a)) {
          action = a;
          break;
        }
      }
      // Match by title keywords EasyMDE uses
      const title = (btn.title || '').toLowerCase();
      const isMdBtn =
        /bold|italic|heading|quote|list|link|image|guide|markdown/i.test(title) &&
        !/fullscreen|full screen/i.test(title);
      if (!isMdBtn) return; // fullscreen etc. stay active
      if (isMd) {
        btn.classList.remove('disabled');
        btn.removeAttribute('disabled');
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
      } else {
        btn.classList.add('disabled');
        btn.setAttribute('disabled', 'disabled');
        btn.style.opacity = '0.35';
        btn.style.pointerEvents = 'none';
      }
    });
  }

  /** Simple in-file find (no addon dependency). Returns match count. */
  function findInFile(query, { backwards = false } = {}) {
    const cm = easyMDE.codemirror;
    const q = String(query || '');
    if (!q) return 0;
    const text = cm.getValue();
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    let count = 0;
    let pos = 0;
    while ((pos = lower.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    if (count === 0) return 0;

    const cur = cm.getCursor();
    const fromIdx = cm.indexFromPos(cur);
    let idx;
    if (backwards) {
      // search before selection start
      const start = cm.indexFromPos(cm.getCursor('from'));
      idx = lower.lastIndexOf(needle, Math.max(0, start - 1));
      if (idx < 0) idx = lower.lastIndexOf(needle);
    } else {
      idx = lower.indexOf(needle, fromIdx + (cm.somethingSelected() ? 1 : 0));
      if (idx < 0) idx = lower.indexOf(needle);
    }
    if (idx < 0) return count;
    const from = cm.posFromIndex(idx);
    const to = cm.posFromIndex(idx + q.length);
    cm.setSelection(from, to);
    cm.scrollIntoView({ from, to }, 80);
    return count;
  }

  function clearFind() {
    // selection stays; nothing to clear without search overlays
  }

  return {
    easyMDE,
    refreshLayout,
    refreshInlineImages,
    createDoc,
    getDoc,
    showDoc,
    renderActivePreview,
    setLanguage,
    setToolbarForKind,
    findInFile,
    clearFind,
    destroy,
  };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
