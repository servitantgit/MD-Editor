// editor-engine.js
// Experimental engine is URL-only so Classic (default) never sticks via localStorage.
// Enable:  /?editor=cm6   or   /cm6.html
// Disable: any URL without editor=cm6 (normal bookmarks stay on EasyMDE).

export const ENGINE_CLASSIC = 'easymde';
export const ENGINE_CM6 = 'cm6';

/** @returns {boolean} true only when the page was opened for the CM6 experiment */
export function isCm6Url() {
  try {
    const q = new URLSearchParams(location.search).get('editor');
    if (q === ENGINE_CM6 || q === 'codemirror6') return true;
    // Optional path-based entry (cm6.html may rewrite to ?editor=cm6).
    if (/\/cm6\.html?$/i.test(location.pathname)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

export function getEditorEngine() {
  return isCm6Url() ? ENGINE_CM6 : ENGINE_CLASSIC;
}
