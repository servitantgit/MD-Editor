// js/vendor.js
//
// The editor libraries that index.html used to load from a CDN are imported here from npm
// and assigned to window under the exact same globals the code in js/ already uses.
// No file in js/ is rewritten to imports: this is the only module that touches window.*
// for these libraries, and it must run BEFORE ./js/app.js (see the script order in index.html).
//
// Globals set here and the js/ files that use them:
//   window.CodeMirror   — js/editor.js (globalThis.CodeMirror, CodeMirror.Doc via constructor)
//   window.EasyMDE      — js/app.js (typeof check), js/editor.js (new EasyMDE(...))
//   window.marked       — js/app.js (passed as deps.marked), js/editor.js via renderMarkdownSafe()
//   window.DOMPurify    — js/app.js (passed as deps.purifier), js/sanitize-html.js (via deps)
//   window.hljs         — js/app.js (globalThis.hljs.highlightElement), js/editor.js (highlightElement)
//   window.MiniSearch   — js/app.js (window.MiniSearch.getDefault, constructor, typeof check)

// CodeMirror 5: editor.js reads globalThis.CodeMirror and CodeMirror.Doc.
import CodeMirror from 'codemirror';
window.CodeMirror = CodeMirror;

// EasyMDE 2 (bundles CodeMirror 5 internally — same build as the old CDN file).
import EasyMDE from 'easymde';
window.EasyMDE = EasyMDE;

// marked 18: named export is the marked parser (used as deps.marked → marked.parse).
import { marked } from 'marked';
window.marked = marked;

// DOMPurify 3: createDOMPurify(window) installs itself on the given window.
import createDOMPurify from 'dompurify';
window.DOMPurify = createDOMPurify(window);

// highlight.js 11: the "common" build (~36 languages), the same set the CDN file highlight.min.js shipped.
// lib/core has NO languages: fenced code blocks would silently lose highlighting.
import hljs from 'highlight.js/lib/common';
window.hljs = hljs;

// MiniSearch 7: default export is the MiniSearch constructor (getDefault is a static on it).
import MiniSearch from 'minisearch';
window.MiniSearch = MiniSearch;

// Library CSS (loaded in this order so the cascade matches the old CDN <link> order:
// easymde.css + material-darker theme + fontawesome, then nothing else until app.css in index.html).
import 'easymde/dist/easymde.min.css';
import 'codemirror/theme/material-darker.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import 'highlight.js/styles/github-dark.min.css';
