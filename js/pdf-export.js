// pdf-export.js
// Export the active page to PDF: render markdown into a hidden "paper"
// container, wait for all images to actually load, hand it to html2pdf.js.

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

  deps.onStatus('Preparing PDF...', false);

  // html2canvas renders the element where it actually sits. Positioning the container
  // itself (`position: fixed; left: -99999px` in app.css) made html2pdf.js capture a
  // blank canvas — a 3 KB, one empty page PDF. So the container stays a neutral block
  // and the off-screen part lives on this throwaway wrapper instead.
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
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

    deps.onStatus('PDF exported ✓', false);
  } catch (e) {
    deps.onStatus('PDF error: ' + e.message, true);
  } finally {
    holder.remove();
  }
}
