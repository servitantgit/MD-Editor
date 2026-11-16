// highlight.js "common" build (~36 languages). lib/core has NO languages: code blocks would silently lose highlighting.
// Replaces the old `window.hljs` global (set in js/vendor.js). The CSS theme is still imported in js/vendor.js.
import hljs from 'highlight.js/lib/common';

/** Highlights one <code> element in place. Callers keep their own try/catch. */
export function highlightBlock(block) {
  hljs.highlightElement(block);
}
