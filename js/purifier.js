// DOMPurify bound to the page window, created on first use.
// Replaces the old `window.DOMPurify` global (set in js/vendor.js).
// Fail-closed: outside a browser (no window) it throws instead of returning something unsafe.
import createDOMPurify from 'dompurify';

const instances = new WeakMap();

/**
 * @param {Window} [win] defaults to the page window; tests pass a jsdom window
 * @returns {{ sanitize: (html: string, cfg?: object) => string }}
 */
export function getPurifier(win = globalThis.window) {
  if (!win) throw new Error('DOMPurify needs a window: HTML rendering is disabled for safety.');
  let instance = instances.get(win);
  if (!instance) {
    instance = createDOMPurify(win);
    instances.set(win, instance);
  }
  return instance;
}