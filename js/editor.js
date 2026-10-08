// editor.js
// Wrapper around EasyMDE. The most important thing here is correct CodeMirror handling:
// * .refresh() after the container becomes visible and gets its real size
//   (the classic reason the editor "doesn't scroll"/shows 1 line — CodeMirror
//   measured the container height BEFORE it was displayed/got its final layout);
// * previewRender wired via the async pattern documented by EasyMDE itself.

import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { attachResizeHandles, resolveAllImages } from './image-preview.js';
import { kindFromPath } from './file-kind.js';
import { dirnameOf, resolveRelativePath, isExternalOrAnchor, isImagePath } from './paths.js';
import { buildHtmlSrcdoc } from './html-preview.js';

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{marked: any, imageResolver: import('./image-resolver.js').ImageResolver, getCurrentPath: () => string|null, onImageUploadRequest: () => void}} deps
 */
export function createEditor(textareaEl, deps) {
  let previewRenderToken = 0;
  // Per-PANE HTML preview state. EasyMDE's container always holds TWO preview
  // nodes (.editor-preview-side and .editor-preview), and renderActivePreview
  // loops over both: a GLOBAL token would make the second pane's call starve
  // the first one's deferred fill ("renders, then doesn't, then renders" —
  // the alternating bug on Live/Preview switches). Each pane gets its own
  // latest-wins token + serial fill chain; panes never block each other.
  // Keyed by element → collected with the pane itself (no cleanup needed).
  const htmlPaneStates = new WeakMap();
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

      // HTML: sandboxed iframe (filled after EasyMDE writes our return value).
      // Single funnel renderHtmlPreview (below): all parallel triggers queue
      // instead of racing, and the async fill re-attaches the iframe if a
      // stale caller wiped the pane in between. Return null — NOT '' — so
      // EasyMDE's own `if (newValue != null) preview.innerHTML = newValue`
      // and value()'s `!== null` write both skip the pane for this branch.
      if (kind.preview === 'html') {
        // Capture the pane now: toggleSideBySide replaces the preview element
        // on mode switches, and a stale setTimeout closure must not render
        // into the detached node.
        const paneNow = previewEl;
        const textNow = plainText;
        // NO global token guard here: renderActivePreview calls this for EVERY
        // pane in the same tick, and the global token would always cancel all
        // but the last pane (the alternating bug). Staleness is handled per
        // pane inside renderHtmlPreview (latest-wins); timeouts run FIFO, so
        // for one pane the newest text lands last.
        setTimeout(() => {
          if (!paneNow || !paneNow.isConnected) return;
          renderHtmlPreview(paneNow, textNow);
        }, 0);
        return null;
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
      // CM5: instance.constructor is usually the CodeMirror function
      const cand = easyMDE.codemirror.constructor;
      if (cand && typeof cand.defineMode === 'function') {
        globalThis.CodeMirror = cand;
      } else if (cand && cand.Doc && typeof easyMDE.codemirror.getOption === 'function') {
        // Some builds put defineMode only on the library root; still assign constructor
        globalThis.CodeMirror = cand;
      }
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
      base + '/markdown/markdown.min.js',
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
    if (myToken === previewRenderToken) wirePreviewLinks(previewEl);
  }

  /**
   * The single funnel for HTML side-by-side rendering. previewRender AND
   * fillPreviewPane both delegate here, so parallel triggers (EasyMDE 'update'
   * + our forceLayout on layout switches) queue instead of racing: every pass
   * reuses the live iframe and refreshes its srcdoc, none wipes the pane.
   * Returns a promise resolving to the srcdoc (or null when superseded).
   */
  function renderHtmlPreview(previewEl, plainText, { syncSrcdoc = true } = {}) {
    if (!previewEl) return Promise.resolve(null);
    let state = htmlPaneStates.get(previewEl);
    if (!state) {
      state = { token: 0, chain: Promise.resolve() };
      htmlPaneStates.set(previewEl, state);
    }
    const myToken = ++state.token; // per-pane, not global: panes are independent
    const run = (async () => {
      if (!previewEl || !previewEl.isConnected) return null;
      let iframe = previewEl.querySelector('iframe.html-preview-frame');
      if (!iframe || !iframe.isConnected) {
        previewEl.innerHTML = '';
        iframe = document.createElement('iframe');
        iframe.className = 'html-preview-frame';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
        iframe.setAttribute('title', 'HTML preview');
        previewEl.appendChild(iframe);
      } else if (state.renderedText === plainText && iframe.parentElement === previewEl) {
        // FLICKER GUARD: assigning srcdoc is a full iframe navigation — a
        // visible flash. A Live/Preview switch re-runs render (forceLayout ×2
        // + EasyMDE 'update') with UNCHANGED text; touching the srcdoc there
        // reloads the page 2-3 times for nothing. Nothing changed → done.
        // (The set token still supersedes older in-flight passes correctly.)
        return iframe.srcdoc || null;
      }
      const raw = plainText || '<!-- empty -->';
      // Compare before assigning: even an identical value reloads the frame.
      if (syncSrcdoc && iframe.srcdoc !== raw) iframe.srcdoc = raw;
      const path = deps.getCurrentPath ? deps.getCurrentPath() : null;
      let srcdoc;
      try {
        srcdoc = await buildHtmlSrcdoc(plainText || '', path, deps.imageResolver);
      } catch (e) {
        console.error('HTML preview resolve failed:', e);
        return myToken === state.token ? (iframe.srcdoc || null) : null;
      }
      // A newer pass for THIS pane queued meanwhile — it owns the pane now.
      if (myToken !== state.token) return null;
      if (!iframe.isConnected || !previewEl.isConnected) return null;
      // The pane may have been wiped by a stale caller in between (EasyMDE's
      // own `preview.innerHTML = newValue`); re-attach instead of dropping.
      if (iframe.parentElement !== previewEl) previewEl.appendChild(iframe);
      if (iframe.srcdoc !== srcdoc) iframe.srcdoc = srcdoc;
      state.renderedText = plainText; // this text is on screen now (flip-guard)
      return srcdoc;
    })();
    // Chain after the previous pass FOR THIS PANE so fills of one pane never
    // interleave; other panes run in parallel. A rejection must not poison
    // the chain for the next pass.
    state.chain = state.chain.then(() => run, () => run);
    return run;
  }
  function wirePreviewLinks(previewEl) {
    if (!previewEl || previewEl.dataset.linkNav === '1') return;
    previewEl.dataset.linkNav = '1';
    previewEl.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!href || isExternalOrAnchor(href)) return;
      // leave pure image links alone
      if (isImagePath(href.split('?')[0])) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = deps.getCurrentPath ? deps.getCurrentPath() : null;
      let target = href.replace(/^\//, '');
      try {
        if (!href.startsWith('/')) {
          target = resolveRelativePath(dirnameOf(cur || ''), href);
        }
      } catch (_) { /* keep target */ }
      // drop hash/query
      target = target.split('#')[0].split('?')[0];
      if (!target) return;
      if (typeof deps.onOpenInternalLink === 'function') {
        deps.onOpenInternalLink(target);
      }
    });
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

  function onParentMessage(ev) {
    const data = ev && ev.data;
    if (!data || data.type !== 'md-editor-open' || !data.path) return;
    if (typeof deps.onOpenInternalLink === 'function') {
      deps.onOpenInternalLink(String(data.path));
    }
  }
  window.addEventListener('message', onParentMessage);



  // First resize in a quiet window refreshes immediately (unit tests + initial
  // layout). Bursts (opening drawers, split mode) are coalesced to one refresh.
  let resizeLayoutTimer = null;
  let lastResizeRefreshAt = 0;
  const RESIZE_DEBOUNCE_MS = 80;
  const resizeObserver = new ResizeObserver(() => {
    const now = Date.now();
    if (now - lastResizeRefreshAt < RESIZE_DEBOUNCE_MS) {
      clearTimeout(resizeLayoutTimer);
      resizeLayoutTimer = setTimeout(() => {
        lastResizeRefreshAt = Date.now();
        refreshLayout();
      }, RESIZE_DEBOUNCE_MS);
      return;
    }
    lastResizeRefreshAt = now;
    refreshLayout();
  });
  resizeObserver.observe(textareaEl.closest('.editor-area') || document.body);

  function scheduleInlineImages() {
    clearTimeout(inlineImageTimer);
    inlineImageTimer = setTimeout(() => renderInlineImages(), 250);
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
    const isHtmlPreview = kindFromPath(deps.getCurrentPath ? deps.getCurrentPath() : '' || '').preview === 'html';
    for (const preview of list) {
      const html = easyMDE.options.previewRender(plain, preview);
      // HTML returns null (async funnel renderHtmlPreview owns the pane) —
      // skip every sync wipe here unconditionally: null is the protocol.
      if (html === null || (html === '' && isHtmlPreview)) {
        preview.scrollTop = 0;
        continue;
      }
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
    try { window.removeEventListener('message', onParentMessage); } catch (_) {}
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

    const fromIdx = cm.indexFromPos(cm.getCursor(backwards ? 'from' : 'to'));
    let idx;
    if (backwards) {
      idx = lower.lastIndexOf(needle, Math.max(0, fromIdx - 1));
      if (idx < 0) idx = lower.lastIndexOf(needle);
    } else {
      idx = lower.indexOf(needle, fromIdx);
      if (idx < 0) idx = lower.indexOf(needle);
    }
    if (idx < 0) return count;
    const from = cm.posFromIndex(idx);
    const to = cm.posFromIndex(idx + q.length);
    cm.setSelection(from, to);
    cm.scrollIntoView({ from, to }, 80);
    return count;
  }

  /** Replace the current selection if it matches query; otherwise find next and stop. */
  function replaceInFile(query, replacement) {
    const cm = easyMDE.codemirror;
    const q = String(query || '');
    if (!q) return 0;
    const sel = cm.getSelection();
    if (sel && sel.toLowerCase() === q.toLowerCase()) {
      cm.replaceSelection(String(replacement ?? ''), 'around');
    }
    return findInFile(q, { backwards: false });
  }

  /** Replace every occurrence. Returns number of replacements. */
  function replaceAllInFile(query, replacement) {
    const cm = easyMDE.codemirror;
    const q = String(query || '');
    if (!q) return 0;
    const text = cm.getValue();
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    const parts = [];
    let last = 0;
    let pos = 0;
    let n = 0;
    while ((pos = lower.indexOf(needle, pos)) !== -1) {
      parts.push(text.slice(last, pos));
      parts.push(String(replacement ?? ''));
      pos += needle.length;
      last = pos;
      n++;
    }
    if (!n) return 0;
    parts.push(text.slice(last));
    const scroll = cm.getScrollInfo();
    const cursor = cm.getCursor();
    cm.setValue(parts.join(''));
    try {
      cm.setCursor(cursor);
      cm.scrollTo(scroll.left, scroll.top);
    } catch (_) {}
    return n;
  }

  function clearFind() {
    // selection stays
  }

  /** Toggle CodeMirror line wrapping. Returns new state. */
  function toggleLineWrapping() {
    const cm = easyMDE.codemirror;
    const next = !cm.getOption('lineWrapping');
    cm.setOption('lineWrapping', next);
    cm.refresh();
    return next;
  }

  let headingFoldMarks = [];
  let headingsFolded = false;

  /** Fold bodies under ATx headings (collapsed marks). Toggle on repeat. */
  function toggleHeadingFolds() {
    const cm = easyMDE.codemirror;
    for (const m of headingFoldMarks) {
      try { m.clear(); } catch (_) {}
    }
    headingFoldMarks = [];
    if (headingsFolded) {
      headingsFolded = false;
      return false;
    }

    const lineCount = cm.lineCount();
    const headers = [];
    for (let i = 0; i < lineCount; i++) {
      const line = cm.getLine(i) || '';
      const m = /^(#{1,6})\s+\S/.exec(line);
      if (m) headers.push({ line: i, level: m[1].length });
    }
    for (let h = 0; h < headers.length; h++) {
      const start = headers[h].line;
      const level = headers[h].level;
      let end = lineCount - 1;
      for (let j = h + 1; j < headers.length; j++) {
        if (headers[j].level <= level) {
          end = headers[j].line - 1;
          break;
        }
      }
      if (end <= start) continue;
      try {
        const mark = cm.markText(
          { line: start, ch: (cm.getLine(start) || '').length },
          { line: end, ch: (cm.getLine(end) || '').length },
          {
            collapsed: true,
            clearOnEnter: true,
            inclusiveLeft: false,
            inclusiveRight: true,
          }
        );
        headingFoldMarks.push(mark);
      } catch (_) { /* ignore bad ranges */ }
    }
    headingsFolded = headingFoldMarks.length > 0;
    return headingsFolded;
  }

  /**
   * Clear the collapsed mark hiding `line` (if any), so a programmatic jump
   * from the outline lands on visible text instead of inside a fold.
   * Returns true when something was unfolded.
   */
  function unfoldAtLine(line) {
    let unfolded = false;
    headingFoldMarks = headingFoldMarks.filter((m) => {
      let dead = false;
      try {
        const r = m.find();
        if (!r) dead = true;
        else if (line >= r.from.line && line <= r.to.line) {
          m.clear();
          unfolded = true;
          dead = true;
        }
      } catch (_) { dead = true; }
      return !dead;
    });
    if (unfolded && headingFoldMarks.length === 0) headingsFolded = false;
    return unfolded;
  }

  return {
    easyMDE,
    refreshLayout,
    refreshInlineImages,
    createDoc,
    getDoc,
    showDoc,
    renderActivePreview,
    renderHtmlPreview,
    setLanguage,
    setToolbarForKind,
    findInFile,
    replaceInFile,
    replaceAllInFile,
    clearFind,
    toggleLineWrapping,
    toggleHeadingFolds,
    unfoldAtLine,
    destroy,
  };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
