# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Project info on the homepage** — the start screen is now a landing card: what the app is ("Browser-based Markdown editor for any GitHub repo"), a feature list (OAuth login without manual tokens, full file/folder CRUD with automatic link rewriting on move, inline image previews via the GitHub API, PDF export, no local clone / no build step) and a link to the repository + author (`index.html`, `css/app.css`)
- A GitHub icon link to the repository in the app header, next to "Sign out"

### Added
- **Files got a context menu** — right-clicking a file in the tree now offers "New file in this folder" / "Rename" / "Delete", the same way folders already did. Renaming a file rewrites every link to it across the repo exactly like a move does (`renameFile()` in `js/file-mover.js`)
- Folders' context menu also gained "New file here" / "New folder here", and both menus now stay on screen when right-clicking near the window edge (`js/file-tree.js`)

### Changed
- "New file" / "New folder" are created in the **folder selected in the tree** instead of always at the repository root — the folder you last opened or expanded becomes the target, and the sidebar buttons' tooltips say so. The prompt shows where the item will land, and names containing `/` still work and are resolved from the root (`onCreateNewFile()` / `onCreateNewFolder()` in `js/app.js`)

### Fixed
- **PDF export produced a blank, single empty page (~3 KB)** — html2canvas captures the element exactly where it sits, and `#pdf-export-container` was styled `position: fixed; left: -99999px` in `app.css`, so the whole document was rendered outside the captured area. An off-screen transparent holder now carries the positioning and the container stays a neutral block (`css/app.css`, `js/pdf-export.js`); a real export of the test document is now ~4.4 MB instead of 3 KB. This had been fixed once (commit `d3f3017`) and silently reverted by `acbf466`
- **Images were cut in half by page breaks** — `page-break-inside: avoid` on `.md-img-wrap` plus an explicit `pagebreak.avoid` list makes html2pdf move a whole image to the next page instead of slicing it. Images taller than the printable page are scaled down first (`clampImagesToPage`), because html2pdf refuses to move anything taller than one page
- **Nothing in the tree context menu worked** — clicking Rename/Delete/New file did nothing at all, for the new file menu *and* for the pre-existing folder menu. Refactoring the menu onto one shared helper had made it record the click and then dispatch the action through a `setTimeout(..., 0)` that started **at open time**: the timer fired milliseconds later, long before the user clicked, always read `null`, and the real click was silently dropped. The menu now takes an `onPick` callback invoked straight from the click handler (`js/file-tree.js`). The e2e test only checked that the items *exist* and never clicked one — it now actually picks Delete and requires the confirmation dialog
- Creating or deleting a folder/file did not appear in the tree until the page was reloaded: GitHub caches GET responses (git/trees included), so the tree fetched right after a write could still be the pre-write one. `getTree()` now appends a unique cache-busting query parameter and the newly created folder is expanded so the result is visible immediately (`js/github-client.js`, `js/app.js`)
- The first attempt at the fix above sent `Cache-Control: no-cache` from the browser, which broke **every** GitHub API call with `Request header field cache-control is not allowed by Access-Control-Allow-Headers` — that header is not CORS-safelisted, so it forced a preflight GitHub rejects. The cache bust is now a query parameter, which needs no preflight; `test/github-client.test.js` guards against any non-safelisted header sneaking back in
- Status messages ("Moved: ...", "Saved ✓", "Folder created: ...") stayed on screen forever — `setSaveStatus()` only ever wrote text and nothing ever cleared it, so the last message was still there after a page reload of the workflow. Informational statuses now clear themselves after 4s (a newer status is never wiped), while **errors stay visible** until the next action (`js/app.js`, covered by a new check in `e2e_smoke_test.py`)
- Dragging a file into a folder that already contains a file with the same name failed with the raw GitHub API error `Invalid request. "sha" wasn't supplied.` — the Contents API requires the current `sha` of a file to update it, and `moveFile()` never sent one. Now the collision is detected up front from the file tree, `moveFile()` refuses to replace anything silently and accepts an explicit `{ overwrite: true }` (passing the destination's sha, with a retry on a stale sha), the UI asks for confirmation via `confirm()` and reports the replacement, and `renameFolder()` checks for collisions before moving the first file instead of failing halfway through (`js/file-mover.js`, `js/folder-manager.js`, `js/app.js`, regression tests in `test/file-mover.test.js`)
- Dropping a file into the folder it is already in now says so in the status bar instead of silently doing nothing
- The expand/collapse arrows next to folders in the file tree did nothing when clicked: the folder row's click handler explicitly bailed out on clicks inside `.folder-toggle`, so the arrow — the most obvious thing to click — was inert (only the folder name/icon worked). Now a click anywhere on the row toggles the folder, and the arrow additionally reacts to Enter/Space (`js/file-tree.js`, `css/app.css`, regression test in `test/file-tree.test.js`)
- Pasting a full GitHub link (e.g. `https://github.com/owner/repo.git` from the address bar) into the Owner/Repository field no longer produces a broken `/repos/{owner}/https://github.com/...` API URL (surfaced by the browser as a "CORS policy" error): `onLoginClick()` now detects such a paste in either field and auto-splits it into owner + repo (`js/github-repo-url.js`, covered by `test/github-repo-url.test.js`)

## [2.2.0] - 2026-09-27

### Added
- **GitHub OAuth login** replaces manually pasting a Personal Access Token — a "Sign in with GitHub" button on the start screen (`index.html`, `js/app.js`)
- `functions/auth/login.js`, `functions/auth/callback.js` — Cloudflare Pages Functions implementing the Authorization Code flow: anti-CSRF `state` in an HttpOnly cookie, server-side exchange of `code` for `access_token` (the Client Secret never leaves the server), the token is handed to the client via a URL fragment (`#gh_token=...`), which never reaches a server
- `AGENTS.md` — pitfalls found while building the OAuth flow, so they aren't rediscovered

### Changed
- The start screen no longer has a token field — just Owner/Repository and the GitHub button
- `js/app.js`: login reworked around `consumeOAuthRedirect()` / `finishLogin()` instead of a single synchronous form submit with a token
- `e2e_smoke_test.py`: real GitHub OAuth can't run in CI, so the smoke test now seeds `sessionStorage` directly with a token/owner/repo (the same keys `readSession()` reads) instead of filling the old token form
- Regenerated `package-lock.json` — it had incomplete stub entries for transitive `"*"` dependencies (`@types/tern`, `typo-js`) and was fully missing `@types/estree`; `npm install` tolerated this, `npm ci` in CI did not

### Removed
- `worker/index.js` and the related `wrangler.toml` changes (`main`, `[assets] binding`) from an intermediate iteration — the project deploys via Cloudflare Pages' Git integration, which never executes a Workers `main` script; `wrangler.toml` is effectively unused for the current deployment method

### Docs
- `README-CLOUDFLARE.md` rewritten around the actual deployment (Pages + Pages Functions, dashboard environment variables) instead of a Workers `wrangler deploy` flow that didn't match how the project is actually hosted

## [2.1.0] - 2026-09-27

### Added
- **Folder drag & drop upload** — drag a folder from OS into the sidebar drop zone to recursively upload all files preserving structure (`js/folder-upload.js`)
- **Folder management** — create, rename, delete folders via UI:
  - "+ folder" button in sidebar header creates folder via `.gitkeep`
  - Right-click folder in tree → "Rename" / "Delete"
  - Rename moves all files recursively and updates references in `.md` files
- **Folder context menu** — right-click on folders in file tree for rename/delete actions
- **`js/folder-manager.js`** — pure logic for folder operations (create, rename, delete, list, check empty)
- **`js/folder-upload.js`** — recursive folder upload using `webkitGetAsEntry` File System Access API

### Changed
- Updated README with new features documentation
- File tree now shows folders with context menu support
- Sidebar header includes "+ folder" button alongside "+ file"

## [2.0.0] - 2026-09-24

### Added
- Complete rewrite as ES modules (no build step)
- GitHub REST API integration with Personal Access Token
- EasyMDE/CodeMirror editor with live preview
- Image preview with GitHub API resolution (works with private repos)
- Image resize handles in preview (width saved to markdown)
- Clipboard image paste → auto-upload to repo
- Drag & drop images from OS → auto-upload + relative link insertion
- Smart asset folder detection (`Asset/`, `Images/`, most-images folder, fallback to `<dir>/assets`)
- Drag & drop files between folders in sidebar tree
- Automatic reference rewriting when moving files:
  - Updates moved file's own relative links
  - Updates all other `.md` files referencing the moved file
  - Handles relative, root-relative, images, and plain markdown links
- PDF export via html2pdf.js
- Unit tests for pure logic modules (paths, markdown-tokens, reference-rewriter, file-mover)
- E2E smoke test with Playwright
- GitHub Actions CI workflow (unit tests + browser smoke test)

### Architecture
- Pure functions separated from DOM/network: `paths.js`, `markdown-tokens.js`, `reference-rewriter.js`
- Thin GitHub client (`github-client.js`)
- Modular design: each feature in its own file
- No TypeScript, no bundler — runs directly in browser

## [1.0.0] - 2024-01-15

### Added
- Initial prototype (single-file implementation)
- Basic markdown editing
- Simple file listing

[2.2.0]: https://github.com/USER/MD-Editor/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/USER/MD-Editor/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/USER/MD-Editor/releases/tag/v2.0.0