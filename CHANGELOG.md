# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  - "+ папка" button in sidebar header creates folder via `.gitkeep`
  - Right-click folder in tree → "Перейменувати" / "Видалити"
  - Rename moves all files recursively and updates references in `.md` files
- **Folder context menu** — right-click on folders in file tree for rename/delete actions
- **`js/folder-manager.js`** — pure logic for folder operations (create, rename, delete, list, check empty)
- **`js/folder-upload.js`** — recursive folder upload using `webkitGetAsEntry` File System Access API

### Changed
- Updated README with new features documentation
- File tree now shows folders with context menu support
- Sidebar header includes "+ папка" button alongside "+ файл"

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