// sanitize-html.js
// Every HTML string that goes into innerHTML of the MAIN page (markdown preview,
// PDF export) must pass through here. The main page holds the GitHub token in
// sessionStorage, so an attribute like onerror= or ontoggle= in a note, a pasted
// snippet or a saved web page would run with full access to it. marked does not
// sanitize. HTML FILES in the preview are safe already (sandboxed iframe without
// allow-same-origin) - but the PDF export renders them in the main page.
//
// The purifier (DOMPurify) is injected like `marked`, so tests run the real
// library on jsdom. Fail-closed: no purifier -> throw, never render raw HTML.
// Default DOMPurify config on purpose: it keeps data-* attributes, data: image
// URIs, style attributes, kbd/details/summary/input - everything the notes and
// the editor's canonical image markup use.

import { markdownToCanonicalHtml } from './markdown-tokens.js';

function requirePurifier(purifier) {
  if (!purifier || typeof purifier.sanitize !== 'function') {
    throw new Error('HTML sanitizer (DOMPurify) is not loaded - rendering is disabled for safety. Allow cdn.jsdelivr.net and reload.');
  }
  return purifier;
}

/** Sanitize an HTML fragment (markdown output). */
export function sanitizeHtml(html, purifier) {
  return requirePurifier(purifier).sanitize(String(html == null ? '' : html));
}

/**
 * Sanitize a whole HTML document (an .html file printed to PDF). WHOLE_DOCUMENT
 * keeps <head> content such as <style>, so the printed page keeps its look.
 */
export function sanitizeHtmlDocument(html, purifier) {
  return requirePurifier(purifier).sanitize(String(html == null ? '' : html), { WHOLE_DOCUMENT: true });
}

/** Markdown -> canonical HTML -> sanitized HTML. Use this for anything that reaches innerHTML. */
export function renderMarkdownSafe(text, renderer, purifier, opts) {
  return sanitizeHtml(markdownToCanonicalHtml(text, renderer, opts), purifier);
}