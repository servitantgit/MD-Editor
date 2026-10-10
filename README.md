# GitHub MD Editor

[![Tests](../../actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
![Deployed on Cloudflare Pages](https://img.shields.io/badge/deployed%20on-Cloudflare%20Pages-F38020?logo=cloudflarepages&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-brightgreen)
![Vanilla JS](https://img.shields.io/badge/vanilla-JS-f7df1e?logo=javascript&logoColor=black)
![Last commit](https://img.shields.io/github/last-commit/servitantgit/MD-Editor)
![Code size](https://img.shields.io/github/languages/code-size/servitantgit/MD-Editor)
![Open issues](https://img.shields.io/github/issues/servitantgit/MD-Editor)
![License](https://img.shields.io/github/license/servitantgit/MD-Editor)

A lightweight browser editor for Markdown and related text files in a GitHub
repository. Sign in with **"Sign in with GitHub"** (OAuth) — the access token
is issued by GitHub and lives only in `sessionStorage`; our server only ever
sees the one-time code-for-token exchange (setup:
[README-CLOUDFLARE.md](./README-CLOUDFLARE.md)).

No build step: plain ES modules. Edit **Markdown**, **HTML**, **JS/CSS** and
other text files with three layouts (**Source / Live / Preview**), multi-tab
editing, full-text search, local drafts (IndexedDB) + explicit Save/Commit to
GitHub, **Commit / History** drawers, find/replace, outline, minimap, and PDF
export.

## Screenshots


<p align="center">
  <img width="1920" height="1199" alt="landpage" src="https://github.com/user-attachments/assets/fc7f14d1-cbbc-4a83-aecc-da1d7d164e52" /><br>
  <sub><b>Sign in with GitHub</b> — OAuth login, no manual token to create or paste.</sub>
</p>


<p align="center">
  <img width="1920" height="1199" alt="landpage" src="https://github.com/user-attachments/assets/251bab67-a94c-416a-a20c-05f9596088a7" /><br>
  <sub>File tree, tabs, live preview and toolbar side by side while editing a note.</sub>
</p>

## Architecture

Plain JavaScript (ES modules), no TypeScript, no bundler — opens directly in
the browser. Code is split by responsibility:

```
index.html              HTML shell, loads CDN libraries and js/app.js
css/app.css              all styles
functions/auth/
  login.js                Cloudflare Pages Function: GET /auth/login — starts OAuth
  callback.js              Cloudflare Pages Function: GET /auth/callback — exchanges
                            code -> access_token, hands the token to the client
js/
  paths.js                pure path-handling functions (no DOM/network)
  markdown-tokens.js       detects images/links in markdown, builds a
                            "canonical" preview HTML (no DOM/network)
  reference-rewriter.js    logic for rewriting links when files move
                            (pure functions, no network)
  github-client.js         thin GitHub REST API client (auth, contents, trees,
                            Git Data API)
  demo-client.js           in-memory GitHubClient stand-in for "Try demo" (local sandbox)

  github-repo-url.js       parses a pasted GitHub repo URL into owner/repo
  file-kind.js             file extension -> kind mapping (md/html/js/css/…)
  image-resolver.js        markdown path -> data: URL via the GitHub API, cached
  file-mover.js            orchestrates moving a file (reads/writes through
                            github-client, uses reference-rewriter)
  folder-manager.js        create/rename/delete folders (via file operations)
  image-preview.js         DOM side of the preview: src substitution, resize handle
  editor.js                wrapper around EasyMDE (setup, preview rendering,
                            correct CodeMirror.refresh(), tab-aware Preview)
  file-tree.js             file tree + drag & drop for files and folders (context menu)
  upload.js                image uploads (OS drag & drop + toolbar button)
  folder-upload.js         folder upload via drag & drop (webkitGetAsEntry)
  pdf-export.js            exports the active page to PDF
  working-tree.js          tracks dirty state across files/tabs for Commit panel
  commit-ui.js             Commit + History panel DOM helpers
  diff-util.js             unified diff helpers for the History panel
  tabs.js                  tab model: ordered paths + active + persistence
  tabs-ui.js               tab strip rendering and click handling
  autosave.js              hybrid autosave: local draft on idle; GitHub on Save/Commit
  draft-store.js           per-repo/branch IndexedDB store for local drafts
  idb-backend.js           generic IndexedDB wrapper (open/degrade/quota/sweep)
  search-index.js           MiniSearch index over repo markdown
  search-store.js          IndexedDB persistence for search index
  search-sync.js           background sync: diff tree, fetch bodies, update index
  search-ui.js             search box + results list DOM helpers
  file-kind.js             extension → language / preview strategy
  html-preview.js          HTML iframe srcdoc + relative assets + link bridge
  minimap.js               canvas document minimap
  commit-ui.js             Commit + History drawers
  working-tree.js          multi-file dirty set for Commit
  diff-util.js             unified diff helpers
  app.js                   assembly point: login (incl. the OAuth redirect),
                            state, wiring up the modules
test/                      unit tests (node:test) for the pure logic
e2e_smoke_test.py          end-to-end browser test (Playwright)
serve.mjs                  minimal local server for development/testing
```

Why it's structured this way: `paths.js`, `markdown-tokens.js` and
`reference-rewriter.js` have ZERO dependency on the DOM or the network — this
is all the "dangerous" logic (link parsing, relative-path rewriting), which
can and should be tested in isolation. That's exactly where real bugs hid in
earlier versions.

## Running it

Browsers won't load `<script type="module">` from `file://` — the page needs
to be served over http(s). Options:

- **Cloudflare Pages** — the current option for real-world use (Git
  integration, auto-deploy on push). This is the **only** option on which
  GitHub OAuth login works — it's implemented as Cloudflare Pages Functions
  (`functions/auth/*`), which neither GitHub Pages nor plain static hosting
  have. Setup instructions in [README-CLOUDFLARE.md](./README-CLOUDFLARE.md).
- **Local development**: `node serve.mjs` (nothing to install, uses Node's
  built-in `http` module) → http://localhost:8080. This is a bare static
  server — it does **not** run `/functions`, so the "Sign in with GitHub"
  button won't work here (you'll get a 404/fallback). To exercise the OAuth
  logic itself locally, run `npx wrangler pages dev .` instead — it emulates
  both the static assets and the Pages Functions.
- Any other static host (GitHub Pages, `npx serve`, etc.) works fine for
  viewing and developing the UI, but without OAuth login — there's simply
  nothing there to authorize GitHub API calls with.

## Testing

### Status

| Check | Status | What it covers |
|---|---|---|
| Unit tests | 🧪 **`npm test`** | paths, markdown-tokens, reference-rewriter, file-mover, autosave state machine, draft/search stores, search sync, tabs (model + strip), editor teardown, git client CORS |
| Browser smoke test | 🧪 **CI** | real Chromium: editing, autosave + 409, tabs, create/delete, search, PDF, images, History toggle, HTML Live preview, Space near inline image |
| GitHub Actions | 🔄 **automatic** | runs both checks on `push` and `pull_request` |

Current CI status is shown by the **Tests** badge at the top of this README.
A red badge means at least one workflow check failed.

Running unit tests locally:

```bash
npm ci
npm test
```

End-to-end browser test (real Chromium, GitHub API replaced with mocked
responses). Runs automatically in CI:

```bash
pip install playwright && playwright install chromium
node serve.mjs &                  # start the app on :8080
python3 e2e_smoke_test.py         # editing, hybrid autosave + 409, tabs, create/delete, search, PDF, images, History/HTML
```

## Features

- **Sign in with GitHub (OAuth)** — no manual Personal Access Token; the
  authorization and any 2FA/mobile confirmation happen on GitHub's side, and
  the app receives a ready-made access token that it keeps only in
  `sessionStorage`.
- **Layout modes** — Source / Live (side-by-side source + preview) / Preview
  (preview only), toggled in the header. Preference is stored in
  `localStorage`.
- **Tabs** — open as many files as you like and switch between them without
  losing your place: each tab keeps its text, undo history, cursor and scroll
  position. The active tab's preview re-renders automatically in Live/Preview
  mode. A dot on a tab means *not on GitHub yet*; closing a tab never loses
  work. Tabs are restored after a reload, and only the active one is fetched
  at startup.
- **Hybrid autosave + local drafts** — typing is persisted to IndexedDB within
  ~400 ms (and again after ~10 s idle) so a crash or reload does not lose work.
  **GitHub is updated only on Save** (current file) or **Commit** (all dirty files).
  Status next to Save: `● Unsaved` / `○ Local only — Save or Commit to push` /
  `⟳ Saving to GitHub…` / `✓ Saved to GitHub` / `⚠ Save failed`. A draft

- **409 conflicts handled gracefully** — the first sha conflict is retried
  silently with a freshly read sha; a second one in a row raises a banner
  offering *Reload from GitHub / Overwrite*.
- **Commit panel** — multi-file commits with a message via the Git Data API
  (blobs → tree → commit → update ref). Dirty files show **M**/**A** badges
  in the file tree; the header **Commit** button shows the number of changes.
- **History panel** — recent commits on the current branch; click a commit
  to see a per-file unified diff.
- **Full-text search** — a search box in the sidebar header (`Ctrl`/`Cmd+K`
  focuses it from anywhere). Results replace the file tree as you type, each
  row showing the file path plus a one-line snippet with the matched term
  highlighted; clicking one opens the note. The index is built in the browser
  and persisted in IndexedDB for 30 days; clearing the input brings the tree
  back exactly as it was.
- **Image previews** — resolved through the GitHub API (works with private
  repos too), not as direct links. This is the editor's own preview, not a
  separate static GitHub Preview.
- **Image resizing** — drag the handle in the bottom-right corner of an image
  in the preview; the width is written straight into the markdown
  (`<img ... width="...">`).
- **Paste images from the clipboard** — a copied image/screenshot from the
  clipboard is uploaded to the repo as a file and immediately inserted into
  the markdown.
- **Drag & drop images** — drop a file into the editor window, or use the
  toolbar upload button. Automatically detects a shared images folder (looks
  for something like `Asset/`/`Images/`, or the folder with the most existing
  images) and inserts a **relative** link, matching the style the rest of the
  notes already use.
- **Drag & drop folders** — drop a folder from your file system onto the
  "Drop a folder here to upload" zone in the sidebar. Recursively uploads all
  files, preserving the folder structure.
- **Drag & drop files between folders** — drag any file onto another folder
  in the tree on the left. Automatically rewrites the moved file's own links
  and fixes links in every other note in the repo that points to it (relative
  links, root-relative `/path` links, images, and plain
  `[text](path)` links alike).
- **Folder management** — the "+ folder" button creates a new folder (via a
  `.gitkeep` file); right-click a folder in the tree → "Rename" / "Delete".
  Renaming updates references in `.md` files. Files also have a right-click
  menu: *New file here* / *Rename* / *Delete*.
- **File and folder context menus** — right-click any file or folder in the
  tree to create, rename, or delete. The menu survives edge clicks and closes
  on Escape.
- **PDF export** — the "📄 PDF" button renders the active page with images
  resolved in place. Large images are scaled to avoid page-break splits.

## Known limitations

- **No refresh-token for the OAuth session** — if "Expire user access tokens"
  is enabled on the GitHub OAuth App, the token dies after roughly 8 hours and
  the user is simply logged out (they need to click "Sign in with GitHub"
  again). This option is kept off by default — see `README-CLOUDFLARE.md`.
- Toolbar icons (Font Awesome) load from a CDN — if the network is
  unavailable, only the icon glyphs disappear; functionality is unaffected.
- Reference rewriting handles markdown images, markdown links, and raw
  `<img>` tags; links like `onenote:...` and other external schemes are
  deliberately left untouched.
- PDF export depends on `html2pdf.js` (html2canvas) — very large images can
  slow generation down.
- Full-text search degrades to session-only when IndexedDB is unavailable
  (private window, Safari ITP, storage disabled) or the origin quota is
  exceeded; search still works, but results are not persisted.
