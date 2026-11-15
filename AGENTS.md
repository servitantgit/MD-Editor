# AGENTS.md

Short version, read this first. Every rule below closes a bug that already happened.
The full story of each (history, commit hashes, baselines, deliberate limits) is in
[`docs/AGENTS-DETAIL.md`](docs/AGENTS-DETAIL.md): open the section you are about to
touch, do not read the whole file. Comments in the code that say "see AGENTS.md"
point to a section of that file.

## What deployment and local checks can and cannot show

- Production is **Cloudflare Pages with Git integration** (`md-edit.pages.dev`), auto-deploy on push to `main`.
  **Build command:** `npm run build`. **Output directory:** `dist`. Server code lives in `/functions`
  (Pages Functions, `onRequestGet`), not Workers — Functions deploy with the project and are not
  inside `dist/`. Environment variables are set only in the Pages dashboard (Production and, if
  needed, Preview) and apply from the next build. Check which product serves the domain before
  writing server code.
- **Local app (editor UI):** `npm ci` then `npx vite` (port 8080). This resolves `js/vendor.js`
  npm imports. `node serve.mjs` is a bare static server — it does **not** resolve those imports
  and will show “Editor failed to load (easymde)”. Do not use it for the full app after the Vite
  migration. OAuth still needs Pages Functions (`npx wrangler pages dev .` or production).
- `e2e_smoke_test.py` mocks `api.github.com` (and optional on-demand CDNs such as Mammoth) and
  fakes the session in `sessionStorage` (`gh_token`, `gh_owner`, `gh_repo`, `gh_branch`). It
  cannot see CORS, real OAuth, GitHub caching, rate limits or real network timing. Cover such
  rules with a unit test; for iframe / `postMessage` / timing bugs check the F12 console on
  production. Run e2e against Vite: `npx vite --port 8080 --strictPort`, then
  `python3 e2e_smoke_test.py`.

## Build and libraries (Vite phase 1)

- Core editor libraries (EasyMDE, CodeMirror 5, marked, DOMPurify, highlight.js, MiniSearch,
  Font Awesome CSS) load via **`js/vendor.js`** from npm and are assigned to the same `window.*`
  globals the rest of `js/` already uses. No file under `js/` except `vendor.js` imports those
  packages. `index.html` loads `./js/vendor.js` then `./js/app.js` (both `type="module"`).
- Production serves **`dist/`** from `vite build`. Dev uses the Vite dev server. Opening
  `index.html` as static files without Vite/build will fail module resolution.
- **Still loaded on demand from CDN** (not in the main bundle): Mammoth, SheetJS, html2pdf when
  the user opens DOCX/XLSX or uses PDF export. Pin each of those in: the URL in the loading
  code, exact version in `package.json` (no `^`), and the e2e route/mock if the test exercises
  that path. Core editor libs are **not** pinned in three places anymore — `package-lock.json`
  is the source of truth.

## Rules that must not be broken

**Security**
- Never put unsanitized HTML into the main page (it holds the GitHub token). Markdown goes through
  `renderMarkdownSafe()`, PDF/Office output through `sanitizeOfficeHtml()`, an .html file's PDF
  through `sanitizeHtmlDocument()`. Fail closed: no DOMPurify, no rendering. Guarded by
  `test/sanitize-html.test.js`, `test/binary-viewer-sanitize.test.js`, and
  `test/no-raw-innerhtml.test.js`.
- Sandboxed iframes (HTML preview) never get `allow-same-origin`. Assign `srcdoc` once per
  render; a second assignment is a full navigation (flicker, blank frame).

**GitHub API**
- Never add a custom request header to `GitHubClient` (CORS preflight). Cache-bust with a query
  parameter, never `Cache-Control`.
- Writing several files is ONE commit (`commitTreeChanges`). A late response must never overwrite
  a newer one.
- `b64ToUtf8` keeps `fatal: true`. An empty file is `size === 0`, never `!b64`.
- The tree can lag behind a write and can be truncated: never delete drafts or index entries
  because a path is missing from one tree response.

**Editor / UI**
- A link target is decoded exactly once, by the consumer.
- Anything computed from a note and stored is versioned: bump `INDEX_VERSION` when the code that
  computes it changes.
- PDF/Office files are view-only: they open in the viewer, never reach CodeMirror, autosave or
  the working tree.

**Architecture checklist** (full text under "Architecture rules" in the detail file): one commit
for many files; late responses ignored; one set of link rules; failures considered before code
(error halfway, two actions at once, ambiguous data, large repo); a test must be able to fail;
a fixed bug leaves a rule; decode once; stored data is versioned; confirm the sent snapshot, not
just its path.

## Before a task is done

1. `npm ci && npm test` from scratch. Read `# cancelled`, not only `# fail`: expected `# fail 0`
   and `# cancelled 0`.
2. If `index.html`, `js/app.js`, `js/vendor.js` or login changed: run e2e against Vite
   (`npx vite --port 8080 --strictPort`, then `python3 e2e_smoke_test.py`; on Windows set
   `$env:PYTHONIOENCODING='utf-8'`).
3. Run `node --check <file>` after every edit of a JS file. A module that does not parse breaks
   the whole app (`#app-main` stays hidden).
4. A test that cannot fail is worse than no test: break the code it guards once and watch it go red.
5. A failing test after your change is caused by your change until shown otherwise; compare counts
   with the previous run.
6. Report: the `npm test` summary lines (`# tests / # pass / # fail / # cancelled`), the e2e
   verdict line, `git status --short` and `git diff --stat`. Paste full raw output only for a
   failure, or when asked. Say plainly what was NOT run or verified.
7. Bug fixes: write the test first and show it RED before the fix. New features: tests go with
   the change, and each new assertion is shown able to fail (break the code once). If a task's
   own step order cannot be followed, stop and ask.
8. Never rewrite or "restore" a whole file by writing it back; check line endings
   (`git ls-files --eol <file>`) before and after.
9. Files are UTF-8 without BOM, LF endings (`.gitattributes`, `.editorconfig`);
   `test/encoding.test.js` fails on mojibake or a BOM.
10. Leave no temporary files in the repo (probes, logs, diff dumps go to the OS temp folder).

## Deliberately not handled (see the detail file for each)

Truncated trees (B2), refresh tokens for OAuth, cursor-follow in Live scroll sync (F13), `&` in
image names after a resize, lost-response reconciliation after Commit. Revisit only when the
case shows up in practice.
