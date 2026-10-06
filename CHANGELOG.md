# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Hybrid Live + Commit / Push / History** — layout modes (Source/Live/Preview), multi-file Commit panel (Git Data API), History with diffs, dirty M/A badges (`js/working-tree.js`, `js/commit-ui.js`, GitHubClient Git Data methods)
- **Hybrid Live layout modes** — Source / Live (side-by-side) / Preview toggle in the header; preference stored in `localStorage` (`md_layout`)
- **Commit panel** — multi-file commits with a message via Git Data API (`commitFiles`: blobs → tree → commit → update ref). Dirty files show **M**/**A** badges in the file tree; header **Commit** button with change count
- **History panel** — recent commits on the current branch, click for per-file unified diff (`listCommits` / `getCommitDetail`)
- `js/working-tree.js` — tracks local dirty state across files/tabs
- `js/commit-ui.js` — Commit + History panel DOM helpers
- `GitHubClient` extensions: `getRefSha`, `createBlob`, `createTree`, `createCommitObject`, `updateRef`, `commitFiles`, `listCommits`, `getCommitDetail`

### Added
- **Tabs: several documents open at once.** Opening a file from the tree or from search adds a tab above the toolbar (or just activates the one that is already open). Each tab keeps its own CodeMirror document, so **text, undo history, cursor and scroll position survive switching away and back**, and a tab that was saved comes back instantly without a request. A dot on a tab means *not on GitHub yet*; × or middle-click closes it, the arrow keys / Home / End move between tabs, and identically named files are told apart by their parent folder (`a/notes.md`, `b/notes.md`). Tabs survive a page reload (`sessionStorage`, like the token) and only the active one is fetched on load. Moving, renaming or deleting a file or folder keeps the tabs consistent with it (`js/tabs.js`, `js/tabs-ui.js`, `js/app.js`)
  - **Nothing is lost by leaving or closing a tab.** Switching away does what switching files always did — the draft is written at once and the commit continues in the background — and closing a tab does the same, including the last one. A tab left with something GitHub did not have yet is re-fetched on return and the usual draft banner offers the local text, because after a background commit only GitHub and the draft store know the truth
  - `Autosave.release()` lets go of the current file without stopping the instance. Closing the last tab or deleting the open file used to `destroy()` it, and a destroyed instance skips the clean-up of a push still in flight — the draft stayed behind and later looked like unsaved work
  - **The Preview pane follows the active tab.** EasyMDE re-renders Preview from `easyMDE.value(text)`, and a tab switch goes around `value()` (it swaps CodeMirror documents), so in Preview mode the tab and the file name changed while the page kept showing the document that was open when Preview was switched on — until a reload. `showDoc()` now re-renders the pane when it is showing (`js/editor.js`). Found after the first tabs build shipped, because no test had Preview switched on while changing tabs: `test/editor.test.js` and e2e scenario G now do
  - Clicking the file that is already open no longer re-opens it. That used to re-fetch the file and reset autosave underneath the editor's text
  - e2e scenario G covers all of it in a real browser: switching back restores text, cursor and scroll with no request; per-tab undo; the dot; close commits a dirty tab (also the last one); reload restores the tabs and loads background ones lazily; a vanished file's tab is not restored; deleting the open file or a background tab's file from the tree closes the right tab; typing into the empty editor commits nothing. Unit tests: `test/tabs.test.js`, `test/tabs-ui.test.js`, three more in `test/autosave.test.js`
- **Two-tier autosave: typing now drafts locally and pushes on its own** — the Save button is no longer the only way to save. Every keystroke is persisted to IndexedDB within 400 ms (the crash-recovery layer), and a commit is pushed to GitHub when the editor has been idle for 10 seconds, when 5 minutes have passed since the file first became dirty (so continuous typing still gets a commit), or when the user clicks Save. Saving is per-file: switching tabs writes the draft at once and lets the commit finish in the background, so switching files stays instant. There is **no merge** — a draft is either kept or discarded by the user (`js/autosave.js`, `js/draft-store.js`, `js/idb-backend.js`, `js/app.js`)
  - **The Save button is now explicit** — it commits immediately, bypasses the idle timer and restarts the 5-minute window, and it is the escape hatch for "I want this on GitHub right now". Its label and id are unchanged, but it is a no-op on a file nobody has touched: committing identical content is noise in the git history. Autosave commits use the same `Update <path>` message as manual ones, so they look the same in `git log`
  - **A status label next to Save** shows the live condition of the open file: `● Unsaved` (orange, work exists locally), `○ Draft saved locally` (grey, waiting for the idle/max window), `⟳ Saving to GitHub…` (grey, in flight), `✓ Saved to GitHub` (green, fades after 4 s) and `⚠ Save failed: <reason>` (red, sticky). The transient `#save-status` line is untouched and still auto-clears after 4 s for moves, deletes and folder operations (`index.html`, `css/app.css`)
  - **Local drafts survive closing the tab.** Reopening a file whose draft is newer than the GitHub `sha` we last saw shows a one-time banner — *"You have unsaved local changes from 3m ago. [Keep local] [Discard]"* — and the user picks a side; nothing is merged automatically. Drafts are keyed `${owner}/${repo}@${branch}:${path}` in their own `md-editor-drafts` database and swept after 30 days or when the path disappears from the repository
  - **Leaving the tab checkpoints instead of losing work:** `visibilitychange` → hidden pushes a dirty draft immediately (no 10-second wait), and `beforeunload` shows the browser's native "changes may not be saved" prompt. Nothing is ever fetched from `beforeunload` — the browser cancels it; the IndexedDB write is what does the saving
  - **A second tab is a 409 story, not a merge story:** the first sha conflict is retried once silently with a freshly read sha, and only a second one in a row offers *"Reload from GitHub / Overwrite"*. New tests pin the whole state machine with fake timers, plus the IndexedDB store (`test/autosave.test.js`, `test/draft-store.test.js`). `e2e_smoke_test.py` drives the same behaviour in a real browser: typing commits nothing and exactly one commit follows the idle window (watched for a few seconds so a duplicate cannot slip past), a draft survives a reload (Keep local), a single scripted 409 is retried silently with a freshly read sha, two in a row raise *Reload / Overwrite*, Overwrite pushes over the fresh sha and Reload pushes nothing. The mock answers PUTs from a scripted status queue (`PUT_STATUS_QUEUE`) so these are real 409 responses, not a check that some buttons exist
- **Full-text search over every `.md` file in the repo** — a search box in the sidebar header (`Ctrl`/`Cmd+K` focuses it from anywhere). Results replace the file tree as you type, each row showing the file path plus a one-line snippet with the matched term highlighted; clicking one opens the note like a normal tree click. Clearing the input brings the tree back exactly as it was (`index.html`, `css/app.css`, `js/search-ui.js`)
  - **Indexed locally, no new backend** — the index is built in the browser from the existing GitHub API reads and persisted in IndexedDB (`md-editor-search`, one record per `${owner}/${repo}@${branch}`, 30-day TTL). Signing back into the same repo reuses it, so only changed files are refetched; `↻` next to the status line forces a full reindex (`js/search-index.js`, `js/search-store.js`, `js/search-sync.js`)
  - Runs entirely in the background after the tree loads — neither the tree nor the editor ever waits for it, and the status line shows `Indexing… 47/342` while it works
  - Degrades to an in-memory index and says *"Search is session-only (storage unavailable)"* when IndexedDB is unavailable (private window / Safari ITP) or the origin quota is exhausted — search keeps working, only persistence is lost
- **New dependency: [`minisearch`](https://github.com/lucaong/minisearch) ^7.2.0** (MIT, ~20KB, zero dependencies), loaded from jsdelivr as a `<script>` tag like `marked`/`html2pdf.js` — still no bundler. `fake-indexeddb` was added as a devDependency for the IndexedDB tests
- Project info on the homepage — the start screen is now a landing card: what the app is ("Browser-based Markdown editor for any GitHub repo"), a feature list (OAuth login without manual tokens, full file/folder CRUD with automatic link rewriting on move, inline image previews via the GitHub API, PDF export, no local clone / no build step) and a link to the repository + author (`index.html`, `css/app.css`)
- A GitHub icon link to the repository in the app header, next to "Sign out"

### Added
- **Files got a context menu** — right-clicking a file in the tree now offers "New file in this folder" / "Rename" / "Delete", the same way folders already did. Renaming a file rewrites every link to it across the repo exactly like a move does (`renameFile()` in `js/file-mover.js`)
- Folders' context menu also gained "New file here" / "New folder here", and both menus now stay on screen when right-clicking near the window edge (`js/file-tree.js`)

### Changed
- **Moving or renaming the open file now rebinds autosave to the new path.** Previously, unless the move happened to rewrite links inside that very file, autosave stayed bound to the old path and the next keystroke would try to commit there. The open file is now always re-opened under its new path
- **Deleting a file no longer flushes it first** — committing to a path that was just deleted is pointless
- **`html2pdf.js` is pinned to exactly `0.10.1` in `package.json`**, the version `index.html` loads from the CDN. It used to read `^0.14.0` there, and since the e2e test serves the library from `node_modules` under the 0.10.1 URL, the PDF checks were exercising a different release than production. The lockfile was regenerated with it (`package.json`, `package-lock.json`). `index.html`, `package.json` and `CDN_MOCKS` in `e2e_smoke_test.py` must be changed together
- **Tests: two files that silently hid failures were repaired, and the gaps behind them closed.** `test/search-store.test.js` and `test/draft-store.test.js` each had a test body cut off mid-way with its tail stranded at the end of the file; `node --check` accepts that (top-level `await` is valid ESM), but every test after the cut was swallowed into the broken one and reported as *cancelled* rather than failed. Always read the `# cancelled` line of `npm test`, not just `# fail`. New `test/search-sync.test.js` covers the sync orchestrator (diffing, skipped files, force reindex, emptied repository, `destroy()` mid-sync). The e2e test gained file/folder creation inside the selected folder, delete via context menu and toolbar (cancelling the confirmation must send nothing), and a per-page "is this PDF page blank" check
- "New file" / "New folder" are created in the **folder selected in the tree** instead of always at the repository root — the folder you last opened or expanded becomes the target, and the sidebar buttons' tooltips say so. The prompt shows where the item will land, and names containing `/` still work and are resolved from the root (`onCreateNewFile()` / `onCreateNewFolder()` in `js/app.js`)

### Fixed
- **UTF-8 conversion used the deprecated `escape`/`unescape`** (Annex B, deprecated since 1999) — `github-client.js` now encodes with `TextEncoder` and decodes with `TextDecoder`. The decoder's `fatal: true` is load-bearing and must not be dropped: `moveToPath()` and `updateReferencesEverywhere()` rely on a thrown error to detect content that is not valid UTF-8 and leave its bytes untouched, whereas the default decoder silently substitutes U+FFFD and would PUT the corrupted text back to GitHub. Pinned against `Buffer` as an independent UTF-8 reference (`js/github-client.js`, new `test/base64-utf8.test.js`, new case in `test/file-mover.test.js`)
- **Closing the tree context menu by clicking away was unreliable** — the dismiss listeners were armed inside a `setTimeout(…, 0)`, leaving a window where the menu was visible but not yet listening, so a click landing there did nothing. That flaked the e2e dismissal check about 1 run in 3. They are registered synchronously again, and the document handler now ignores clicks that land inside the menu (`js/file-tree.js`)
- **Renaming a folder left stale absolute links between its own files** — `moveFile()` only ever reads the `allFiles` snapshot and never updates it, so `renameFolder()` was looping over a list that went stale after the very first move. `updateReferencesEverywhere()` then asked for `Notes/a.md`, got a 404, swallowed it and moved on, leaving root-absolute links inside an already-moved file pointing at a folder that no longer existed (`Docs/a.md` kept `[b](/Notes/b.md)`). The loop now keeps a private copy of the snapshot and repoints each entry as its file moves; relative links were never affected, which is why this only surfaced for `/`-style links (`js/folder-manager.js`, new `test/folder-manager.test.js`)
- **A folder recreated under a just-deleted name started collapsed** — `collapsedFolders` kept the stale path, so the "harmless leftover" reasoning was wrong: the entry becomes live again the moment a folder of that name is recreated, and it then starts collapsed for no visible reason. `setFiles()` now prunes it, deriving both that and the active-folder check from one `collectFolderPaths(files)` helper (`js/file-tree.js`, two new cases in `test/file-tree.test.js`)
- **Creating a file after deleting its folder quietly brought the folder back** — `FileTree.activeFolder` is the "create here" target and outlived the folder it named: `setFiles()` only reassigned `files` and re-rendered, so a deleted (or renamed) target stayed active and the next "new file" PUT into it, resurrecting the folder. `setFiles()` now resets the target to the repository root unless the folder is still in the tree — Git has no real folders, so the set of folder paths implied by the file list is the whole definition of "still there". One check covers both deletion and renaming, since both end in `loadTree()` (`js/file-tree.js`, new case in `test/file-tree.test.js`)
- **`createEditor()` could never be released, and the app could be built twice** — the editor attached a `ResizeObserver`, a `paste` handler and a CodeMirror `change` handler, none of them exposed for teardown, and re-wrapping the shared `<textarea>` would stack a second editor on the first. It now returns a `destroy()` (disconnect, clear timer, detach both handlers, `easyMDE.toTextArea()`), and `showApp()` destroys the previous handle before building. The actual double-build came from `init()` racing itself: `consumeOAuthRedirect()` was never awaited, so an OAuth callback landing on a tab that still held a session ran `showApp()` from both the session branch and `finishLogin()` — two editors, two observers, two paste handlers, the first unreachable. `init()` is now async and returns early when the callback completed the login. Note that logout itself could never leak the editor: it does `location.reload()`, which destroys the whole JS realm (`js/editor.js`, `js/app.js`, new `test/editor.test.js`; the `init()` race has no test — see AGENTS.md)
- **Creating a file or folder from the sidebar buttons put it in `[object PointerEvent]`** — `onCreateNewFile` / `onCreateNewFolder` take a folder path, but they were assigned straight to `onclick`, so the browser passed the click event as `folderPath`. The default parameter (`fileTree.getActiveFolder()`) only applies to `undefined`, so the event flowed into `resolvePathIn()` and the app requested `contents/%5Bobject%20PointerEvent%5D/name.md` — and the prompt read `created in "[object PointerEvent]"`. The buttons now call the handlers through arrow functions, and both functions coerce a non-string argument through `toFolderPath()` — which falls back to the tree's active folder, so even if the wiring regresses the file still lands where the user is looking instead of silently in the repo root (`js/app.js`, regression check in `e2e_smoke_test.py`)
- **PDF export produced a blank, single empty page (~3 KB)** — html2canvas captures the element exactly where it sits, and `#pdf-export-container` was styled `position: fixed; left: -99999px` in `app.css`, so the whole document was rendered outside the captured area. An off-screen transparent holder now carries the positioning and the container stays a neutral block (`css/app.css`, `js/pdf-export.js`); a real export of the test document is now ~4.4 MB instead of 3 KB. This had been fixed once (commit `d3f3017`) and silently reverted by `acbf466`
- **The "file changed on GitHub" banner stayed on screen after a successful Overwrite** — `resolveConflict('overwrite')` commits correctly and the status line reads *Saved to GitHub*, but nothing hid `#draft-banner`, so the user was still asked to choose after the choice had been carried out. The Overwrite handler now hides the banner when the push lands, and leaves it up if the push conflicts again (`js/app.js`). Found by the new 409 scenario in `e2e_smoke_test.py`; reverting the fix makes that scenario fail
- **Search sync counted unreadable files as indexed** — a file that failed to download or was not valid UTF-8 was skipped but still added to the `indexed` figure returned by `SearchSync.run()` and passed to `onDone`. `indexed` now counts only files that really entered the index, while a separate `processed` counter drives the `Indexing… N/M` progress line and the batch persistence, so progress still reaches `M/M` when files are skipped (`js/search-sync.js`, `test/search-sync.test.js`)
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