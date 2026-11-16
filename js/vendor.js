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

// CodeMirror 5: editor.js reads globalThis.CodeMirror and CodeMirror.Doc.
import CodeMirror from 'codemirror';
window.CodeMirror = CodeMirror;

// marked 18: named export is the marked parser (used as deps.marked → marked parse).

// Library CSS (loaded in this order so the cascade matches the old CDN <link> order:
// easymde.css + material-darker theme + fontawesome, then nothing else until app.css in index.html).
import 'easymde/dist/easymde.min.css';
import 'codemirror/theme/material-darker.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import 'highlight.js/styles/github-dark.min.css';
