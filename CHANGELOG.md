# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.1.0]: https://github.com/USER/MD-Editor/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/USER/MD-Editor/releases/tag/v2.0.0