# AGENT.md — rules for working with the MD-Editor project

This file is a quick-reference / cheat-sheet for AI assistants (or new developers)
working on this repository in future sessions. It covers: technologies, architecture
conventions, what is already implemented, what is planned, and — most importantly —
the real pitfalls learned from past experience, so we don't step on them again.

---

## 1. About the project

A lightweight **editor for `.md` files in a GitHub repository** that runs entirely
in the browser. It talks to the GitHub REST API using a **Personal Access Token
(PAT)**, which is stored **only** in `sessionStorage`. No backend, no build step,
no Electron — it runs as a static site (GitHub Pages / plain `node serve.mjs`).

**The "no build" guarantee is a fundamental rule.** Do not introduce TypeScript,
bundlers, preprocessors, or a backend without explicit user agreement.

## 2. Tech stack

| What | How it's loaded |
|---|---|
| Plain JS (ES modules, `type="module"`) | Our code lives in `js/*.js` — no build, the browser parses it as-is |
| **EasyMDE** (based on CodeMirror 5) | CDN (`easymde.min.js/css`) |
| **marked** (markdown -> HTML) | CDN (global `window.marked`) |
| **html2pdf.js** v0.14.0 (html2canvas + jsPDF) | CDN — for PDF export |
| **Font Awesome** | CDN — toolbar icons |

GitHub REST API: `https://api.github.com${path}` with headers
`Authorization: Bearer <token>` and `X-GitHub-Api-Version: 2022-11-28`.

## 3. Run and test

```bash
node serve.mjs            # local server -> http://localhost:8080 (port: process.env.PORT)
npm install               # install dev-dependencies for tests (jsdom, marked, ...)
npm test                  # node --test test/*.test.js — 34 unit tests
```
- Browsers won't load `<script type="module">` from `file://` — the page must be
  served over http(s).
- E2E: `pip install playwright && playwright install chromium`, then
  `node serve.mjs &`, then `python3 e2e_smoke_test.py` (mocks the GitHub API,
  real Chromium).

Tests that pull in libraries (`image-preview`, `markdown-tokens`) need `npm install`
first (they require `jsdom` and `marked`). If `node_modules` is missing they fail
with "module not found" — that's an environment issue, not your code.

## 4. Project structure

```
index.html               HTML skeleton; loads the CDN libs and js/app.js
css/app.css              all styles
AGENT.md                 this file
doc/future.md            ideas/plans for the near future
serve.mjs                minimal local server (Node built-in http)
js/
  paths.js               pure path/encoding helpers (no DOM, no network)
  markdown-tokens.js     image/link recognition, "canonical" HTML (no DOM, no network)
  reference-rewriter.js  relative-link recomputation on move (no network)
  github-client.js       thin GitHub REST API client
  image-resolver.js      markdown path -> data: URL via the API, with cache
  file-mover.js          file-move orchestration + auto reference update
  image-preview.js       DOM: preview images, resize handle
  editor.js              EasyMDE wrapper (previewRender, refresh, inline images)
  file-tree.js           file tree + drag&drop
  upload.js              image upload (OS drag&drop + clipboard + toolbar button)
  pdf-export.js          export the active page to PDF
  app.js                 wiring point, state, DOM event handlers
test/*.test.js           34 unit tests (node:test)
e2e_smoke_test.py        end-to-end browser test (Playwright)
```

`.kilo/` is workspace/support dump — **don't touch it and don't commit it**.

## 5. Architecture principles

1. **Keep logic separated from the UI.** `paths.js`, `markdown-tokens.js` and
   `reference-rewriter.js` must have **ZERO** dependency on DOM/`document` or the
   network (`fetch`). Keep all "dangerous" logic (parsing, path recomputation)
   isolated so it can be unit-tested in Node without a browser. Follow this — don't
   drag `document`/`fetch` into those modules.
2. Modules communicate via **dependency injection** (deps objects; the renderer is
   passed in from outside) — this makes it easy to swap in mocks for tests.
3. All comments and user-facing messages are in **Ukrainian** (the repo standard).
4. No global state changes unless necessary.

## 6. Key gotchas (learned the hard way — IMPORTANT)

### 6.1 CSS cascade order
Load `css/app.css` **AFTER** `easymde.min.css` and Font Awesome.
If `app.css` loads earlier, `easymde.min.css` overrides our `display:flex` on
`.EasyMDEContainer`, and CodeMirror stops being height-limited ("doesn't scroll,
shows the whole text as one block"). This is also commented in `index.html`.

### 6.2 EasyMDE `previewRender` must stay synchronous
In `editor.js` the preview renderer must **not assign anything** to `previewEl`
itself. EasyMDE itself runs `previewEl.innerHTML = ...` after calling it. All
post-processing (resize handles + image resolving) is scheduled on the next tick
via `setTimeout(0)`, protected from races with the `previewRenderToken` counter
(a newer render arriving means the older async result is dropped).

### 6.3 Call CodeMirror.refresh() after showing / resizing
CodeMirror can measure the container height *before* it actually gets its real size
(flex layouts, temporarily hidden parents) and get stuck. So when a file opens or
the size changes we call `refresh()` — both immediately and again on the next frame
(`requestAnimationFrame`). There's also a `ResizeObserver` on `.editor-area`.

### 6.4 Live inline image preview in CodeMirror
In `editor.js`, markdown images (`![alt](path)`) are visually replaced by the real
image right inside the code via `cm.markText(..., { replacedWith })`. The original
`.md` text is unchanged — GitHub still stores the original. Clipboard paste of
images is also handled. Only markdown image links.

### 6.5 PDF export (REPEATED GOTCHA — REMEMBER THIS!)
html2pdf.js (html2canvas) **clones** the element into its own container and renders it.
- **Do NOT put `position: fixed`, a negative `z-index`, `opacity`, `transform`, or
  `left: -99999px` on the element passed to `.from()`** — otherwise the canvas
  renders blank and the PDF comes out as a **blank page**.
- The correct pattern (already implemented in `pdf-export.js`): a neutral container
  (no positioning in the CSS) plus a **transparent holder**
  (`position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-9999;`)
  that wraps the container. Pass only the neutral `container` to `.from(container)`;
  html2canvas never sees the holder.
- Plugin version: `html2pdf.js@0.14.0`, must match `package.json`.

### 6.6 base64 with Cyrillic / emoji
`btoa`/`atob` don't work with UTF-8 (Cyrillic, emoji). Always use
`utf8ToB64`/`b64ToUtf8` (built on `encodeURIComponent`/`decodeURIComponent`).

### 6.7 GitHub Contents API ~1MB limit
`getFileB64` first tries the Contents API; on failure it falls back to the Git
Blobs API (covers larger files). Don't drop to the limit without that fallback.

### 6.8 Token security
The token lives only in **`sessionStorage`** (not `localStorage`); cleared on log-out.

## 7. Already implemented (v2.0.0)
- Authentication via PAT + repo validation (`getRepoInfo`).
- File tree + drag&drop of files between folders, with automatic recomputation of
  own and other links (relative, root-relative `/path`, `<img>`, `[text](path)`).
- Editing markdown via EasyMDE; creating new `.md` files.
- Images: shown in the preview **and live right in CodeMirror**, resizable by a
  handle (width written into `<img width>`), insert from clipboard (screenshot) and
  OS drag&drop, auto-uploaded to the repo with relative links.
- Image cache (`ImageResolver`).
- PDF export of the active page (html2pdf.js, with images included).

## 8. Plans (see `doc/future.md`)
**OAuth login via GitHub** without a hand-typed PAT ("sign in with your account",
2FA on the phone). ⚠ GitHub OAuth does NOT support PKCE and requires a
`client_secret` to exchange the code for a token ⇒ a **mini-backend/proxy** (Node or
serverless) is needed. The detailed options (mini-Node, serverless functions,
Device Flow, hybrid with PAT) are in `doc/future.md` — along with the list of
touch points in `app.js` / `index.html` / `github-client.js` / `serve.mjs`.

## 9. Working rules / checklist
1. **Before changing something**, read the relevant module and `AGENT.md`
   (especially Section 6).
2. Verify you haven't broken the "pure layer" (no `document`/`fetch` in
   `paths.js`, `markdown-tokens.js`, `reference-rewriter.js`).
3. After CSS changes, check the cascade (Section 6.1); for PDF changes see Section 6.5.
4. Run `npm test` (34 tests). If `image-preview`/`markdown-tokens` fail without
   `node_modules`, that's the environment, not your code.
5. After editor/preview changes, run `e2e_smoke_test.py`.
6. Don't edit or commit files under `.kilo/`.
7. Write code comments in Ukrainian.