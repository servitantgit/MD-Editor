// pdf-export.js
// Експорт активної сторінки в PDF: рендеримо markdown у прихований "паперовий"
// контейнер, чекаємо реального завантаження всіх зображень, віддаємо html2pdf.js.

import { basenameOf } from './paths.js';
import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { resolveAllImages } from './image-preview.js';

/**
 * @param {{
 *   getCurrentPath: () => string|null,
 *   getMarkdownText: () => string,
 *   marked: any,
 *   imageResolver: import('./image-resolver.js').ImageResolver,
 *   onStatus: (msg: string, isError: boolean) => void,
 * }} deps
 */
export async function exportCurrentPageToPdf(deps) {
  const currentPath = deps.getCurrentPath();
  if (!currentPath) return;

  deps.onStatus('Підготовка PDF...', false);

  // Ховаємо контейнер від очей ЗОВНИ (opacity:0 + z-index:-9999 на holder).
  // HTML2PDF.js клонує саме `container` і малює її через html2canvas — тож сам
  // контейнер мусить бути нейтральним блоком без position:fixed/z-index/opacity
  // (будь-яке позиціонування збиває canvas -> порожня сторінка PDF). Holder
  // html2canvas не бачить, бо ми віддаємо .from(container), а не holder.
  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:0;top:0;width:1000px;height:1000px;overflow:hidden;' +
    'opacity:0;pointer-events:none;z-index:-9999;';
  document.body.appendChild(holder);

  const container = document.createElement('div');
  container.id = 'pdf-export-container';
  holder.appendChild(container);

  try {
    const text = deps.getMarkdownText();
    container.innerHTML = markdownToCanonicalHtml(text, deps.marked);

    await resolveAllImages(container, deps.imageResolver, currentPath, () => true);
    container.querySelectorAll('img[data-md-src]').forEach((img) => img.removeAttribute('data-md-src'));

    const filename = (basenameOf(currentPath) || 'document').replace(/\.md$/i, '') + '.pdf';

    await window.html2pdf().set({
      margin: 10,
      filename,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(container).save();

    deps.onStatus('PDF експортовано ✓', false);
  } catch (e) {
    deps.onStatus('Помилка PDF: ' + e.message, true);
  } finally {
    holder.remove();
  }
}
