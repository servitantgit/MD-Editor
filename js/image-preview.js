// image-preview.js
// DOM-частина роботи з картинками в прев'ю: підстановка реального src замість
// прозорого пікселя-заглушки, і drag-resize ручка в правому нижньому куті.

import { setImageAttrsInLine } from './markdown-tokens.js';

/**
 * Підвантажує реальні джерела для всіх .md-img-wrap у previewEl.
 * @param {HTMLElement} previewEl
 * @param {import('./image-resolver.js').ImageResolver} resolver
 * @param {string|null} currentFilePath
 * @param {() => boolean} stillCurrent  callback: чи ще актуальний цей рендер (захист від "гонки")
 * @returns {Promise<number>} кількість зображень, які не вдалося завантажити
 */
export async function resolveAllImages(previewEl, resolver, currentFilePath, stillCurrent) {
  const wraps = Array.from(previewEl.querySelectorAll('.md-img-wrap'));
  let failCount = 0;

  await Promise.all(
    wraps.map(async (wrap) => {
      const img = wrap.querySelector('img');
      const placeholder = wrap.querySelector('.md-img-placeholder-text');
      const orig = img.getAttribute('data-md-src');
      try {
        const url = await resolver.resolve(orig, currentFilePath);
        if (!stillCurrent()) return;
        img.src = url;
        wrap.classList.remove('loading');
      } catch (err) {
        if (!stillCurrent()) return;
        failCount++;
        console.warn('Не вдалося завантажити зображення прев’ю:', orig, err);
        wrap.classList.remove('loading');
        wrap.classList.add('broken');
        img.alt = '⚠ не вдалося завантажити: ' + orig;
        if (placeholder) placeholder.textContent = `⚠ ${orig}\n${err.message}`;
      }
    })
  );

  return failCount;
}

/** Вішає drag-to-resize на ручку кожного .md-img-wrap; при відпусканні пише нову ширину в CodeMirror. */
export function attachResizeHandles(previewEl, codemirror) {
  previewEl.querySelectorAll('.md-img-wrap').forEach((wrap) => {
    const img = wrap.querySelector('img');
    const handle = wrap.querySelector('.md-img-resize-handle');
    const badge = wrap.querySelector('.md-img-size-badge');
    if (!handle || handle.dataset.wired) return;
    handle.dataset.wired = '1';

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = img.getBoundingClientRect().width;
      wrap.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const w = Math.max(20, Math.round(startWidth + (ev.clientX - startX)));
        img.style.width = w + 'px';
        img.style.height = 'auto';
        if (badge) badge.textContent = w + 'px';
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        wrap.classList.remove('resizing');
        const finalWidth = Math.max(20, Math.round(img.getBoundingClientRect().width));
        commitImageWidth(codemirror, img, finalWidth);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

function commitImageWidth(codemirror, imgEl, width) {
  const lineIndex = parseInt(imgEl.getAttribute('data-md-line'), 10);
  const occIndex = parseInt(imgEl.getAttribute('data-md-occ'), 10);
  const src = imgEl.getAttribute('data-md-src') || '';
  const alt = imgEl.getAttribute('alt') || '';

  const line = codemirror.getLine(lineIndex);
  if (line === undefined) return;
  const newLine = setImageAttrsInLine(line, occIndex, { src, alt, width });
  if (newLine !== line) {
    codemirror.replaceRange(newLine, { line: lineIndex, ch: 0 }, { line: lineIndex, ch: line.length });
  }
}
