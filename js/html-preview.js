// html-preview.js
// Build a self-contained srcdoc for the HTML Live/Preview iframe:
// relative <img src>, <link href>, <script src> are resolved against the open
// file path via the same ImageResolver / Contents API used for markdown images.
// Relative <a href> to repo files post a message to the parent so the app can open them.

import { dirnameOf, resolveRelativePath, isExternalOrAnchor } from './paths.js';

/**
 * @param {string} html
 * @param {string|null} currentPath
 * @param {{ resolve: (src: string, fromPath: string|null) => Promise<string> }} resolver
 * @returns {Promise<string>} srcdoc HTML
 */
export async function buildHtmlSrcdoc(html, currentPath, resolver) {
  const raw = String(html || '');
  // Prefer the global constructor; in unit tests jsdom exposes it on window only.
  const Parser = (typeof DOMParser !== 'undefined' && DOMParser)
    || (typeof globalThis !== 'undefined' && globalThis.DOMParser)
    || (typeof window !== 'undefined' && window.DOMParser)
    || null;
  if (!Parser) return raw;

  let doc;
  try {
    doc = new Parser().parseFromString(raw, 'text/html');
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

  // Relative links → open in the parent editor (not navigate the iframe)
  const dir = dirnameOf(base);
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || isExternalOrAnchor(href)) return;
    let abs = href.replace(/^\//, '');
    try {
      if (!href.startsWith('/')) abs = resolveRelativePath(dir, href);
    } catch (_) { /* keep abs */ }
    abs = String(abs || '').split('#')[0].split('?')[0];
    if (!abs) return;
    a.setAttribute('data-md-path', abs);
    a.setAttribute('title', abs);
    a.setAttribute('href', '#md-open');
  });

  // Ensure a charset meta so Cyrillic/etc. render correctly in srcdoc
  if (doc.head && !doc.head.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.insertBefore(meta, doc.head.firstChild);
  }

  // The bridge must run when the frame is parsed. A document without a <body>
  // (e.g. a freshly built, empty srcdoc — plain === '') has no place for the
  // script, so give it a body first. Without this, the frame posts nothing
  // and the preview pane keeps the old frame height (an extra scrollbar).
  if (!doc.body) {
    const body = doc.createElement('body');
    doc.documentElement.appendChild(body);
  }

  // Bridge: clicks on data-md-path links ask the parent to open that path,
  // and the frame reports its own document height — the parent cannot measure
  // it (sandbox without allow-same-origin = opaque origin), yet the preview
  // pane must know how tall to grow the iframe so THE PANE scrolls the whole
  // document (one scrollbar, like markdown) instead of an inner frame scrollbar.
  const bridge = doc.createElement('script');
  bridge.textContent = [
    'document.addEventListener("click",function(e){',
    '  var a=e.target&&e.target.closest&&e.target.closest("a[data-md-path]");',
    '  if(!a)return;',
    '  e.preventDefault();',
    '  try{parent.postMessage({type:"md-editor-open",path:a.getAttribute("data-md-path")},"*");}catch(_){}',
    '},true);',
    'function __mdPostHeight(){try{',
    '  var d=document.documentElement,b=document.body;',
    '  var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);',
    '  if(h>0)parent.postMessage({type:"md-editor-frame-height",height:h},"*");',
    '}catch(_){}}',
    'try{if(window.ResizeObserver){new ResizeObserver(__mdPostHeight).observe(document.documentElement);}}catch(_){}',
    'window.addEventListener("load",__mdPostHeight);',
    '__mdPostHeight();',
    // The parent-side 'message' listener (onParentMessage in editor.js) is
    // registered inside createEditor(), which can race the immediate posting
    // above when srcdoc loads (deterministic in demo mode). Post again after
    // short delays so at least one lands once the listener is up. The parent
    // handler is idempotent — assigning the same height is a CSS no-op.
    'setTimeout(__mdPostHeight,50);',
    'setTimeout(__mdPostHeight,200);',
    'setTimeout(__mdPostHeight,500);',
  ].join('');

  // Attach the bridge where the frame will actually parse it: right after the
  // <head> if present, otherwise into the <body> (created above if missing).
  const head = doc.querySelector('head');
  if (head) head.appendChild(bridge);
  else doc.body.appendChild(bridge);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
