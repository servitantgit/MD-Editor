// html-preview.js
// Build a self-contained srcdoc for the HTML Live/Preview iframe:
// relative <img src>, <link href>, <script src> are resolved against the open
// file path via the same ImageResolver / Contents API used for markdown images.

import { dirnameOf, resolveRelativePath, isExternalOrAnchor } from './paths.js';

/**
 * @param {string} html
 * @param {string|null} currentPath
 * @param {{ resolve: (src: string, fromPath: string|null) => Promise<string> }} resolver
 * @returns {Promise<string>} srcdoc HTML
 */
export async function buildHtmlSrcdoc(html, currentPath, resolver) {
  const raw = String(html || '');
  if (typeof DOMParser === 'undefined') return raw;

  let doc;
  try {
    doc = new DOMParser().parseFromString(raw, 'text/html');
  } catch (_) {
    return raw;
  }

  const base = currentPath || '';

  const rewriteAttr = async (el, attr) => {
    const val = el.getAttribute(attr);
    if (!val || isExternalOrAnchor(val) || val.startsWith('data:') || val.startsWith('blob:')) return;
    if (!resolver || typeof resolver.resolve !== 'function') return;
    try {
      const url = await resolver.resolve(val, base);
      el.setAttribute(attr, url);
    } catch (_) {
      // leave original; broken asset stays visible in the iframe
    }
  };

  const jobs = [];
  doc.querySelectorAll('img[src]').forEach((el) => jobs.push(rewriteAttr(el, 'src')));
  doc.querySelectorAll('script[src]').forEach((el) => jobs.push(rewriteAttr(el, 'src')));
  doc.querySelectorAll('link[href]').forEach((el) => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    if (rel.includes('stylesheet') || rel.includes('icon')) {
      jobs.push(rewriteAttr(el, 'href'));
    }
  });
  doc.querySelectorAll('source[src], video[src], audio[src]').forEach((el) => {
    jobs.push(rewriteAttr(el, 'src'));
  });

  await Promise.all(jobs);

  // Hint for relative <a href="note.md"> — show resolved path in title
  const dir = dirnameOf(base);
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || isExternalOrAnchor(href)) return;
    try {
      const abs = resolveRelativePath(dir, href);
      a.setAttribute('title', abs);
    } catch (_) { /* ignore */ }
  });

  // Ensure a charset meta so Cyrillic/etc. render correctly in srcdoc
  if (doc.head && !doc.head.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.insertBefore(meta, doc.head.firstChild);
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
