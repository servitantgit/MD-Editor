# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-09-27

### Added
- **GitHub OAuth login** замінює ручне вставляння Personal Access Token — кнопка "Увійти через GitHub" на стартовому екрані (`index.html`, `js/app.js`)
- `functions/auth/login.js`, `functions/auth/callback.js` — Cloudflare Pages Functions, що реалізують Authorization Code flow: anti-CSRF `state` у HttpOnly-cookie, обмін `code` на `access_token` на сервері (Client Secret туди й не заходить), токен передається клієнту через URL fragment (`#gh_token=...`), який ніколи не потрапляє на сервер
- `AGENTS.md` — граблі, знайдені під час впровадження OAuth, щоб їх не наступати повторно

### Changed
- Стартовий екран більше не має поля токена — тільки Owner/Repository і кнопка GitHub
- `js/app.js`: логін переписаний навколо `consumeOAuthRedirect()` / `finishLogin()` замість одного синхронного сабміту форми з токеном
- `e2e_smoke_test.py`: реальний GitHub OAuth неможливо прогнати в CI, тому смоук-тест тепер напряму кладе токен/owner/repo в `sessionStorage` (ті самі ключі, які читає `readSession()`) замість заповнення старої форми з токеном
- Перегенеровано `package-lock.json` — містив неповні stub-записи транзитивних `"*"`-залежностей (`@types/tern`, `typo-js`) і взагалі бракувало `@types/estree`; `npm install` це терпів, `npm ci` у CI — ні

### Removed
- `worker/index.js` і пов'язані правки `wrangler.toml` (`main`, `[assets] binding`) з проміжної ітерації — проєкт деплоїться через Git-інтеграцію Cloudflare Pages, яка Workers `main`-скрипт узагалі не виконує; `wrangler.toml` для поточного способу деплою фактично не використовується

### Docs
- `README-CLOUDFLARE.md` переписаний під реальний деплой (Pages + Pages Functions, змінні оточення в дашборді) замість Workers-флоу через `wrangler deploy`, який не відповідав тому, як проєкт насправді хоститься

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