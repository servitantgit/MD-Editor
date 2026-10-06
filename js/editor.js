// editor.js
// Wrapper around EasyMDE. The most important thing here is correct CodeMirror handling:
// * .refresh() after the container becomes visible and gets its real size
//   (the classic reason the editor "doesn't scroll"/shows 1 line — CodeMirror
//   measured the container height BEFORE it was displayed/got its final layout);
// * previewRender wired via the async pattern documented by EasyMDE itself.

import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { attachResizeHandles, resolveAllImages } from './image-preview.js';

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{marked: any, imageResolver: import('./image-resolver.js').ImageResolver, getCurrentPath: () => string|null, onImageUploadRequest: () => void}} deps
 */
export function createEditor(textareaEl, deps) {
  let previewRenderToken = 0;
  let inlineImageGeneration = 0;
  let inlineImageMarks = [];
  let inlineImageTimer = null;

  const easyMDE = new EasyMDE({
    element: textareaEl,
    spellChecker: false,
    autosave: { enabled: false },
    // Keep side-by-side inside .editor-area so the file tree stays clickable
    // (EasyMDE default is fullscreen fixed overlay that steals all pointer events).
    sideBySideFullscreen: false,
    placeholder: 'Start writing markdown...',
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
      'preview', 'side-by-side', 'fullscreen', '|',
      'guide',
    ],
    status: ['lines', 'words', 'cursor'],
    renderingConfig: { singleLineBreaks: false, codeSyntaxHighlighting: true },
    previewRender(plainText, previewEl) {
      // IMPORTANT: EasyMDE ITSELF runs `previewEl.innerHTML = <what we return here>`
      // right after this function is called — both when toggling Preview/Side-by-side,
      // and on easyMDE.value(...). If we synchronously assign previewEl.innerHTML HERE
      // ourselves, and then (after the network image resolve) asynchronously want to
      // update these elements — it will be too late: EasyMDE will just overwrite the whole
      // innerHTML once more (with the same string), and our <img> will end up in nodes that
      // are no longer attached to the page — the image "loads" forever and invisibly
      // to the user, even though the network request actually finished long ago.
      // So previewRender stays PURELY synchronous and assigns nothing itself —
      // post-processing (scale handles + image resolve) is scheduled on the next
      // tick via setTimeout(0), when EasyMDE has definitely set the final DOM.
      const myToken = ++previewRenderToken;
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

  async function finishPreviewRender(previewEl, myToken) {
    if (myToken !== previewRenderToken) return; // a newer render arrived meanwhile
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
    inlineImageTimer = setTimeout(() => renderInlineImages(), 120);
  }

  async function renderInlineImages() {
    const cm = easyMDE.codemirror;
    const currentPath = deps.getCurrentPath();
    const generation = ++inlineImageGeneration;

    for (const mark of inlineImageMarks) mark.clear();
    inlineImageMarks = [];

    if (!currentPath) return;

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
      });
    }

    for (const item of matches) {
      if (generation !== inlineImageGeneration) return;

      const from = cm.posFromIndex(item.fromIndex);
      const to = cm.posFromIndex(item.toIndex);
      const wrapper = document.createElement('span');
      wrapper.className = 'cm-inline-image';
      wrapper.title = item.src;

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

      const mark = cm.markText(from, to, { replacedWith: wrapper, clearOnEnter: false });
      inlineImageMarks.push(mark);

      try {
        const url = await deps.imageResolver.resolve(item.src, currentPath);
        if (generation !== inlineImageGeneration || mark.find() == null) return;
        img.src = url;
        img.onload = () => loading.remove();
        img.onerror = () => {
          if (mark.find() != null) mark.clear();
        };
        loading.remove();
      } catch (err) {
        if (generation !== inlineImageGeneration || mark.find() == null) return;
        // If GitHub didn't return the file, don't hide the Markdown from the user.
        mark.clear();
        console.warn('Failed to show inline image:', item.src, err);
      }
    }
  }

  function refreshInlineImages() {
    clearTimeout(inlineImageTimer);
    inlineImageTimer = null;
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

  return { easyMDE, refreshLayout, refreshInlineImages, createDoc, getDoc, showDoc, renderActivePreview, destroy };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
