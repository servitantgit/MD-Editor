// print-export.js
// Print the active markdown/HTML page via the browser print dialog
// (user can choose "Save as PDF"). No html2canvas / html2pdf.

import { basenameOf } from './paths.js';
import { renderMarkdownSafe, sanitizeHtmlDocument } from './sanitize-html.js';
import { resolveAllImages } from './image-preview.js';

const PRINT_ROOT_ID = 'print-root';

/**
 * Build a print-only document body, show the system print dialog, then clean up.
 * @param {{
 *   getCurrentPath: () => string|null,
 *   getMarkdownText: () => string,
 *   marked: any,
 *   purifier?: any,
 *   imageResolver: import('./image-resolver.js').ImageResolver,
 *   onStatus: (msg: string, isError: boolean) => void,
 * }} deps
 */
export async function printCurrentPage(deps) {
  const currentPath = deps.getCurrentPath();
  if (!currentPath) return;

  deps.onStatus('Preparing print…', false);

  // Remove any leftover root from a cancelled previous print.
  const existing = document.getElementById(PRINT_ROOT_ID);
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');

  const title = (basenameOf(currentPath) || 'document')
    .replace(/\.(md|markdown|html?|htm)$/i, '');
  const heading = document.createElement('h1');
  heading.className = 'print-doc-title';
  heading.textContent = title;

  const body = document.createElement('div');
  body.className = 'print-doc-body';

  try {
    const text = deps.getMarkdownText();
    const isHtml = /\.(html?|htm)$/i.test(currentPath);
    if (isHtml) {
      body.innerHTML = sanitizeHtmlDocument(text || '<p></p>', deps.purifier);
    } else {
      body.innerHTML = renderMarkdownSafe(text, deps.marked, deps.purifier);
      await resolveAllImages(body, deps.imageResolver, currentPath, () => true);
      body.querySelectorAll('img[data-md-src]').forEach((img) => img.removeAttribute('data-md-src'));
      // Hide editor-only chrome in the print tree.
      body.querySelectorAll('.md-img-resize-handle, .md-img-size-badge').forEach((el) => el.remove());
    }

    root.appendChild(heading);
    root.appendChild(body);
    document.body.appendChild(root);
    document.body.classList.add('md-printing');

    // Let layout settle so images have dimensions before the browser paginates.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    deps.onStatus('Print dialog…', false);

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('afterprint', done);
        resolve();
      };
      window.addEventListener('afterprint', done);
      try {
        window.print();
      } catch (err) {
        done();
        throw err;
      }
      // Some environments never fire afterprint (headless / blocked dialog).
      setTimeout(done, 2000);
    });

    deps.onStatus('Print done', false);
  } catch (e) {
    deps.onStatus('Print error: ' + (e && e.message ? e.message : e), true);
  } finally {
    document.body.classList.remove('md-printing');
    const node = document.getElementById(PRINT_ROOT_ID);
    if (node) node.remove();
  }
}
