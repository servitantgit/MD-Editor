// pdf-export.js
// Export the active page to PDF: render markdown into a hidden "paper"
// container, wait for all images to actually load, hand it to html2pdf.js.

import { basenameOf } from './paths.js';
import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { resolveAllImages } from './image-preview.js';

// Printable height of one A4 page at 96dpi, minus the 10mm margins configured
// below: (297 - 2*10) mm * 96/25.4 px/mm = ~1046px.
const PAGE_HEIGHT_PX = Math.floor(((297 - 2 * 10) * 96) / 25.4);

/**
 * Scales down images that would not fit on a single page.
 *
 * html2pdf's pagebreak plugin only moves an element to the next page when it is
 * at most one page tall (`nPages <= 1` in its source). So it is not enough to
 * clamp the <img>: the wrapper's margins and border count too, and a wrapper
 * even 1px over the page height gets sliced through the middle instead of
 * being moved. Measure the wrapper's whole box and shrink the image to fit.
 * @param {HTMLElement} container
 */
function clampImagesToPage(container) {
  container.querySelectorAll('.md-img-wrap').forEach((wrap) => {
    const img = wrap.querySelector('img');
    if (!img) return;

    const cs = getComputedStyle(wrap);
    const num = (v) => parseFloat(v) || 0;
    const chrome = num(cs.marginTop) + num(cs.marginBottom)
                 + num(cs.borderTopWidth) + num(cs.borderBottomWidth);

    const imgH = img.getBoundingClientRect().height;
    const budget = PAGE_HEIGHT_PX - chrome;
    if (imgH > budget) {
      img.style.height = Math.floor(budget) + 'px';
      img.style.width = 'auto';
      img.style.maxWidth = '100%';
    }
  });
}

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

    // Images must be measured after they load, otherwise every height reads 0.
    clampImagesToPage(container);

    const filename = (basenameOf(currentPath) || 'document').replace(/\.md$/i, '') + '.pdf';

    await window.html2pdf().set({
      margin: 10,
      filename,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      // 'css' honours page-break-inside: avoid (set on .md-img-wrap in app.css),
      // 'avoid' additionally names the selector explicitly so the behaviour does
      // not depend on the browser reporting the computed break-inside value.
      pagebreak: {
        mode: ['css', 'legacy'],
        avoid: ['.md-img-wrap', 'table', 'tr', 'pre'],
      },
    }).from(container).save();

    deps.onStatus('PDF exported ✓', false);
  } catch (e) {
    deps.onStatus('PDF error: ' + e.message, true);
  } finally {
    holder.remove();
  }
}
