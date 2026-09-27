# GitHub MD Editor

[![Tests](../../actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)

A lightweight browser editor for `.md` files in a GitHub repository. The
editor talks to the GitHub REST API after signing in with **"Sign in with
GitHub"** (OAuth) — the access token is issued by GitHub and lives only in
`sessionStorage`; our server only ever sees the one-time code-for-token
exchange (details and setup in [README-CLOUDFLARE.md](./README-CLOUDFLARE.md)).

Works with no backend and no build step: renders and edits Markdown, resolves
images in the preview, supports drag & drop for files and images,
**folder management**, and exports the active page to PDF.

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/d86d4d1d-4472-40e0-b778-76da0290da4c" alt="GitHub MD Editor — sign-in screen" width="460"><br>
  <sub><b>Sign in with GitHub</b> — OAuth login, no manual token to create or paste.</sub>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/f4949051-31fd-4fca-acf3-c976a22b9685" alt="GitHub MD Editor — main editing view" width="900"><br>
  <sub>File tree, live preview and toolbar side by side while editing a note.</sub>
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
  github-client.js         thin GitHub REST API client (auth, contents, trees)
  image-resolver.js        markdown path -> data: URL via the GitHub API, cached
  file-mover.js            orchestrates moving a file (reads/writes through
                            github-client, uses reference-rewriter)
  folder-manager.js        create/rename/delete folders (via file operations)
  image-preview.js         DOM side of the preview: src substitution, resize handle
  editor.js                wrapper around EasyMDE (setup, preview rendering,
                            correct CodeMirror.refresh())
  file-tree.js             file tree + drag & drop for files and folders (context menu)
  upload.js                image uploads (OS drag & drop + toolbar button)
  folder-upload.js         folder upload via drag & drop (webkitGetAsEntry)
  pdf-export.js            exports the active page to PDF
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
| Unit tests | 🧪 **34 tests** | paths, markdown-tokens, reference-rewriter, file-mover, image-preview via jsdom |
| Browser smoke test | 🧪 **CI** | real Chromium: editing, document/preview scrolling, image previews |
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
python3 e2e_smoke_test.py         # checks editing, scrolling, image previews
```

## Features

- **Sign in with GitHub (OAuth)** — no manual Personal Access Token; the
  authorization and any 2FA/mobile confirmation happen on GitHub's side, and
  the app receives a ready-made access token that it keeps only in
  `sessionStorage`.
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
  Renaming updates references in `.md` files.
- **PDF export** — the "📄 PDF" button renders the active page with images
  resolved in place.

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
