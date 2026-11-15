# AGENTS.md

Short version, read this first. Every rule below closes a bug that already happened.
The full story of each (history, commit hashes, baselines, deliberate limits) is in
[`docs/AGENTS-DETAIL.md`](docs/AGENTS-DETAIL.md): open the section you are about to
touch, do not read the whole file. Comments in the code that say "see AGENTS.md"
point to a section of that file.

## What deployment and local checks can and cannot show

- Production is **Cloudflare Pages with Git integration** (`md-edit.pages.dev`), auto-deploy on push to `main`.
  Server code lives in `/functions` (Pages Functions, `onRequestGet`), not Workers. Environment variables are set
  only in the Pages dashboard and apply from the next build. Check which product serves the domain before writing server code.
- `node serve.mjs` is a bare static server: no `/functions`, so no OAuth locally (`npx wrangler pages dev .` for that).
- `e2e_smoke_test.py` mocks `api.github.com` and the CDNs and fakes the session in `sessionStorage`
  (`gh_token`, `gh_owner`, `gh_repo`, `gh_branch`). It cannot see CORS, real OAuth, GitHub caching, rate limits or real network timing.
  Cover such rules with a unit test, and for iframe / `postMessage` / timing bugs check the F12 console on production.

## Rules that must not be broken

**Security**
- Never put unsanitized HTML into the main page (it holds the GitHub token). Markdown goes through `renderMarkdownSafe()`,
  PDF/Office output through `sanitizeOfficeHtml()`, an .html file's PDF through `sanitizeHtmlDocument()`. Fail closed:
  no DOMPurify, no rendering. Guarded by `test/sanitize-html.test.js` and `test/binary-viewer-sanitize.test.js`.
- Sandboxed iframes (HTML preview) never get `allow-same-origin`. Assign `srcdoc` once per render; a second assignment is a full navigation (flicker, blank frame).
- Every pinned CDN library (DOMPurify, html2pdf.js, Mammoth, SheetJS) is pinned in the same three places: URL in the code/`index.html`,
  exact devDependency in `package.json` (no `^`), and the mock in `e2e_smoke_test.py`.

**GitHub API**
- Never add a custom request header to `GitHubClient` (CORS preflight). Cache-bust with a query parameter, never `Cache-Control`.
- Writing several files is ONE commit (`commitTreeChanges`). A late response must never overwrite a newer one.
- `b64ToUtf8` keeps `fatal: true`. An empty file is `size === 0`, never `!b64`.
- The tree can lag behind a write and can be truncated: never delete drafts or index entries because a path is "missing from the tree".

**Editor, tabs, autosave**
- Autosave is hybrid: local draft on idle, GitHub only on Save / Commit. Never push on idle.
- Leave a file with `autosave.release()`, never `destroy()`. `openSeq` guards the slow-open race. Opening the already-open file is a no-op unless `{reload: true}`.
- One CodeMirror `Doc` per tab, swapped with `swapDoc()`; do not load a tab with `value()`.
- `showApp()` is re-entrant: guard listeners with a dataset flag, read session values through getters, rebind object subscriptions by identity.
- Handlers that take a parameter are wrapped (`() => fn()`), never assigned straight to `onclick`.
- Markdown scanning skips fenced code through `js/md-fences.js`; links are parsed in one place (`REF_TOKEN_RE`, `classifyRefMatch()`); a link target is decoded exactly once, by the consumer.
- Anything computed from a note and stored is versioned: bump `INDEX_VERSION` when the code that computes it changes.
- PDF/Office files are view-only: they open in the viewer, never reach CodeMirror, autosave or the working tree.

**Architecture checklist** (full text under "Architecture rules" in the detail file): one commit for many files; late responses ignored;
one set of link rules; failures considered before code (error halfway, two actions at once, ambiguous data, large repo);
a test must be able to fail; a fixed bug leaves a rule; decode once; stored data is versioned; confirm the sent snapshot, not just its path.

## Before a task is done

1. `npm ci && npm test` from scratch. Read `# cancelled`, not only `# fail`: expected `# fail 0` and `# cancelled 0`.
2. If `index.html`, `js/app.js` or login changed: run `e2e_smoke_test.py` (`node serve.mjs &`, then `python3 e2e_smoke_test.py`;
   on Windows set `$env:PYTHONIOENCODING='utf-8'`).
3. Run `node --check <file>` after every edit of a JS file. A module that does not parse breaks the whole app (`#app-main` stays hidden).
4. A test that cannot fail is worse than no test: break the code it guards once and watch it go red.
5. A failing test after your change is caused by your change until shown otherwise; compare counts with the previous run.
6. Report: the `npm test` summary lines (`# tests / # pass / # fail / # cancelled`), the e2e verdict line, `git status --short` and
   `git diff --stat`. Paste full raw output only for a failure, or when asked. Say plainly what was NOT run or verified.
7. Bug fixes: write the test first and show it RED before the fix. New features: tests go with the change, and each new
   assertion is shown able to fail (break the code once). If a task's own step order cannot be followed, stop and ask.
8. Never rewrite or "restore" a whole file by writing it back; check line endings (`git ls-files --eol <file>`) before and after.
9. Files are UTF-8 without BOM, LF endings (`.gitattributes`, `.editorconfig`); `test/encoding.test.js` fails on mojibake or a BOM.
10. Leave no temporary files in the repo (probes, logs, diff dumps go to the OS temp folder).

## Deliberately not handled (see the detail file for each)

Truncated trees (B2), refresh tokens for OAuth, cursor-follow in Live scroll sync (F13), `&` in image names after a resize,
lost-response reconciliation after Commit. Revisit only when the case shows up in practice.
