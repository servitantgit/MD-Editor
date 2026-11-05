# AGENTS.md

Short version: if you're about to touch deployment, login, tests or GitHub API
calls in this project — read this first. Everything below documents real
pitfalls already hit while implementing GitHub OAuth (September 2026) and the
GitHub API client — don't repeat them.

## How this project is actually deployed

- **Cloudflare Pages with Git integration** — auto-deploy on push to `main`/`master`.
  Live domain: `https://md-edit.pages.dev`.
- `wrangler.toml` in the repo root — **leftover from a failed first attempt**
  to do OAuth via a separate Cloudflare Worker (`main = "worker/index.js"` +
  `[assets]`). Pages Git deploy **never reads** `wrangler.toml` at all — any
  `main` script there simply never runs. If you ever want to
  switch to `wrangler pages deploy` as a CLI deploy method — then `wrangler.toml`
  becomes relevant again, otherwise treat it as dead.
- Server logic (currently — only GitHub OAuth) lives in `/functions` as
  **Cloudflare Pages Functions**: file `functions/auth/callback.js`
  automatically becomes route `GET /auth/callback`, `functions/auth/login.js` —
  `GET /auth/login`. Handler format — `export async function onRequestGet({ request, env })`.
  This is a **different API** than Cloudflare Workers (`export default { fetch(request, env, ctx) }`) —
  don't mix them up when copying code examples from the Workers docs.

**The main takeaway, which cost a whole extra iteration here:** before writing
server code for a specific Cloudflare product, check where the live domain is
actually served from (Cloudflare dashboard, or just the URL shape: `*.pages.dev`
→ Pages, `*.workers.dev`/custom domain without `.pages.dev` → Workers). Here a
Worker was first fully implemented (`worker/index.js` + `wrangler.toml main`),
and it simply never ran in prod because prod lives on a different product.

## OAuth: how it works and what is deliberately missing

- Flow: `/auth/login` → redirect to `github.com/login/oauth/authorize` (with
  anti-CSRF `state` in an HttpOnly cookie) → GitHub login and 2FA on GitHub's side →
  `/auth/callback` exchanges `code` for `access_token` (Client Secret
  is used only here, on the server) → the token is handed to the client via
  `#gh_token=...` in the URL fragment — a fragment never reaches the server/logs —
  → `js/login-ui.js` (`consumeOAuthRedirect()`) picks it up from `location.hash` and
  stores it in `sessionStorage`, just like the manually pasted PAT used to be stored there.
- **No refresh token.** The GitHub OAuth App has an "Expire user access
  tokens" checkbox — it must stay **unchecked**, otherwise the token dies after ~8h
  with no auto-refresh (the session simply resets, the user clicks "Sign in" again).
  If a longer session without re-login is ever needed — add a
  `grant_type=refresh_token` exchange in `functions/auth/callback.js` (and elsewhere),
  that code doesn't exist right now.
- Owner/Repository don't travel through the OAuth round-trip to GitHub itself (GitHub
  doesn't know about them at all) — they are put into `sessionStorage`
  (`gh_pending_owner`/`gh_pending_repo`) right before the redirect and picked back
  up after `/auth/callback` in `consumeOAuthRedirect()` (`js/login-ui.js`). If you
  ever rework the login form — don't forget that this key pair must survive
  the full trip to github.com and back (same tab, sessionStorage
  persists).
- `readSession()` in `js/login-ui.js` expects exactly four sessionStorage keys:
  `gh_token`, `gh_owner`, `gh_repo`, `gh_branch`. This is the same contract the
  e2e test uses (see below) — change one, sync the other.
- Redirect URI/callback in the GitHub OAuth App must match character-for-character:
  `https://md-edit.pages.dev/auth/callback`. In the new UI GitHub calls this field
  "Redirect URI", not "Authorization callback URL" — same thing.

## Environment variables — only via the Cloudflare Pages dashboard, not wrangler

`GITHUB_CLIENT_ID` (Type: **Text**) and `GITHUB_CLIENT_SECRET` (Type: **Secret**)
are set in Cloudflare dashboard → Workers & Pages → project → Settings →
Environment variables, separately for Production and Preview.
**`wrangler secret put` doesn't work here** — that's a command for Worker
projects, not for Pages Git deploys. Environment variable changes only take
effect on the **next build** — after saving, redeploy once more (empty push or
"Retry deployment" in the dashboard), otherwise the app will keep seeing the
old/missing values.

## Local development does NOT see /auth/*

`node serve.mjs` is a bare static file server, it executes nothing from
`/functions`. The "Sign in with GitHub" button on `localhost:8080` will hit a
404 or an unstyled `index.html` fallback (that's exactly how it was first
discovered — an unstyled login screen at `/auth/login`, because CSS is linked
via the relative path `./css/app.css`, which breaks when the current URL isn't
`/`). To actually run the OAuth flow locally — serve via `npx wrangler pages dev .`
(emulates both static assets and Pages Functions), not `node serve.mjs`.

## package-lock.json — a silent npm ci trap

`npm install` locally may say "up to date" and change nothing, while `npm ci`
in GitHub Actions fails with `EUSAGE: Missing: ... from lock file`. The cause
found here: the lock file had incomplete "stub" entries for transitive `"*"`
dependencies (`@types/tern`, `typo-js` — pulled in via
easymde/codemirror-spell-checker) without `resolved`/`integrity`, and was fully
missing the `@types/estree` entry. `npm install --package-lock-only` doesn't fix
this if the local npm cache is already "satisfied" with the old state.

**Before any push that touches `package.json`, or just whenever in doubt** — run
`npm ci` itself locally, don't rely on CI to discover it first:

```bash
rm -rf node_modules package-lock.json
npm install
rm -rf node_modules
npm ci      # must pass without EUSAGE
npm test
```

## GitHub API calls from the browser — CORS safelist and response caching

Two things bit us here and both are invisible to the e2e test (see below):

- **Never add a custom request header to `GitHubClient`.** The CORS-safelisted
  request headers are only `Accept`, `Accept-Language`, `Content-Language`,
  `Content-Type`, `Range` — anything else turns a simple `GET` into a preflight
  (`OPTIONS`). GitHub answers preflight with `Access-Control-Allow-Headers:
  authorization, x-github-api-version`, so e.g. `Cache-Control: no-cache` kills
  **every** API call with:
  `Request header field cache-control is not allowed by Access-Control-Allow-Headers
  in preflight response` — the app can't even load the repo. The `Authorization`
  header is itself non-safelisted and only works because GitHub allows it
  explicitly, so "we already send one custom header" is not a precedent.
- **GitHub caches GET responses**, including `git/trees`. Fetch the tree right
  after a write and you can get the pre-write tree back, which looks exactly like
  "create/delete doesn't show up until you reload the page". `getTree()` appends a
  unique cache-busting **query parameter** (`?cb=<timestamp>-<random>`) — a unique
  URL is a different cache key and, unlike a header, needs no preflight. Don't
  "optimize" that back into a `Cache-Control` header.
- Guard both with `test/github-client.test.js`: it asserts `getTree()` sends no
  header outside the safelist + GitHub's allowed list, and that two consecutive
  tree loads don't share a cache key.

## e2e_smoke_test.py mocks api.github.com, so it cannot catch CORS problems

`handle_github_api()` fulfils every `https://api.github.com/*` request via
Playwright's `page.route`, so those requests never hit the real CORS machinery
of the browser — no preflight, no `Access-Control-Allow-Headers` check. The
`Cache-Control` header above passed the entire e2e suite locally and in CI and
only failed in production. That's the same class of blind spot as the OAuth one
below: anything enforced by the real network or by GitHub itself is untested
locally, so cover such rules with a plain unit test instead.

## e2e_smoke_test.py does not test the real OAuth

The test can't go through real GitHub OAuth — there are no live credentials in
CI, and even locally `node serve.mjs` doesn't serve `/functions`. So the test
immediately puts a fake token/owner/repo directly into `sessionStorage` (the
same four keys from `readSession()` (`js/login-ui.js`), see above) and reloads
the page — this simulates the "already signed in" state, not the login process
itself. `/auth/login` and `/auth/callback` are not covered by this test at all.
If you ever need to really verify the OAuth round-trip itself — that's a
separate scenario with `wrangler pages dev` and a test GitHub OAuth App (or a
mocked `github.com`); such a thing doesn't exist here yet.

## PDF export: never position #pdf-export-container itself

This regressed twice, so the rule is worth writing down. html2canvas (inside
html2pdf.js) renders the element **where it actually sits**. As long as
`#pdf-export-container` had `position: fixed; left: -99999px` in `app.css`, the
document rendered outside the captured area and `html2pdf().from(container)`
saved a ~3 KB, one-empty-page PDF — no error, just a blank file. It was fixed
once (`d3f3017`, an off-screen transparent holder) and silently reverted by
`acbf466` when the positioning moved into CSS.

So: the container is a **neutral block** (width/background/padding only), and
`js/pdf-export.js` wraps it in a throwaway `position: fixed; opacity: 0;
z-index: -9999` holder that is removed in `finally`. Don't "simplify" the
holder back into a CSS rule on the container.

`e2e_smoke_test.py` guards it three ways: it records the container's computed
`position` while exporting (must be `static`), asserts the downloaded PDF is
larger than 50 KB (a blank export is ~3 KB, a real one is hundreds of KB), and
decodes every page and requires some non-white pixels on it. The size of a JPEG
stream proves nothing — a blank page compresses to a few KB too — so do not
replace the pixel check with a byte-length one.

**The html2pdf.js version is pinned in three places that must agree:** the CDN
URL in `index.html`, the devDependency in `package.json` (exact version, no
`^`), and `CDN_MOCKS` in `e2e_smoke_test.py`. The e2e test serves the library
from `node_modules` under the URL it mocks, so a mismatch means the PDF checks
run against a different release than production does.

## PDF export: images must never be split across pages

html2pdf's pagebreak plugin (see `pagebreaks.js` in the bundle) honours
`page-break-inside: avoid` on an element and inserts a padding div in front of
it so the element lands whole on the next page. **But** it only does that when
the element is at most one page tall — `nPages <= 1` — otherwise it leaves it to
be sliced.

That single condition is the whole trap. Clamping the `<img>` to the page height
is *not* enough: `.md-img-wrap` also has `margin: 12px auto` and a border, so the
wrapper ends up taller than the page, `nPages > 1`, and the image gets cut
anyway. `clampImagesToPage()` therefore measures the wrapper's margins and
border and shrinks the image to fit inside that budget.

`e2e_smoke_test.py` checks this for real, not by inspecting CSS: the test
document contains a solid **red** image taller than a page, positioned to
straddle a break. Every page of the exported PDF is a `DCTDecode` JPEG, so the
test decodes each one in the browser and counts red pixels. A split shows a
large red block on one page plus red starting at row 0 of the next. Verified to
fail when the fix is removed.

## Diagnosing sandboxed iframes (HTML preview, PDF export)

Two HTML-preview bugs — the height-handshake race (`d6d7fcc`) and the
blank-frame-on-large-files bug (`7cb7555`) — took ~3 hours to diagnose, mostly
because the obvious tools give false comfort. The lessons are general: they
apply anywhere the app touches a sandboxed iframe, a race, or parent↔child
`postMessage`. Read this before the next one and it should be a 20-minute fix.

**Why parent-side inspection is limited.** The preview iframe is created with
`sandbox="allow-scripts allow-forms allow-modals"` — deliberately **without**
`allow-same-origin`. That gives the frame an *opaque origin*, so from the parent
`iframe.contentDocument` is `null` and `iframe.contentWindow` is the only
handle. This is by design and must stay: adding `allow-same-origin` would let
the sandboxed script reach the parent's cookies/storage and defeat the whole
point of sandboxing untrusted HTML. html2canvas (PDF export) cannot capture the
iframe interior for the same reason — it can capture the pane element
(parent-side chrome), which proves the *positioning*, but not that the inner
document painted. So render success must be inferred from **indirect signals
readable from the parent window**.

Reliable parent-side signals (all proven today):

| Signal | What it means |
|---|---|
| `iframe.offsetHeight` | Exceeds the pane fallback (~500–600px) **only** after the height handshake completes with the real content height. Stuck at the fallback ⇒ handshake never fired. |
| `iframe.style.getPropertyPriority('height') === 'important'` | Set **only** by the handshake handler (`onParentMessage` in `editor.js`), never by CSS. Present ⇒ a real `postMessage` landed and was applied. |
| `postMessage` traffic of type `md-editor-frame-height` within a time window | Install a temporary `window.addEventListener('message', …)`, filter by `ev.source === iframe.contentWindow`. Presence ⇒ the bridge script ran inside the frame. |
| `iframe.srcdoc` length + substring check for `__mdPostHeight` | Proves the bridge was injected into the document that was actually assigned. A short/srcdoc-less frame ⇒ the assignment that carried the bridge never happened. |

**The three visual tests.** When metrics give ambiguous answers, isolate the
cause visually. Create side-by-side test iframes appended to `document.body`
with `position: fixed`:

- **Red** — copy the production iframe's `srcdoc` and use the **same** sandbox
  attributes (`allow-scripts allow-forms allow-modals`). Reproduces the production
  case.
- **Orange** — same srcdoc but add `allow-same-origin`. Confirms whether the
  sandbox is the issue (and, once you can read `contentDocument`, lets you inspect
  the parsed DOM).
- **Lime** — a tiny known-good HTML string with the same sandbox. Confirms the
  sandbox itself works at all.

Compare visually. **If all three render but the production iframe stays blank,
the issue is NOT sandbox, NOT size, NOT content — it is lifecycle**: multiple
`srcdoc` assignments, DOM manipulation during render, etc. That is exactly how
`7cb7555` was pinned down: three identical-sandbox test frames rendered fine, so
the production frame's double `srcdoc` assignment (not the 3.7MB size) was the
culprit.

**Prototype-level `srcdoc` instrumentation.** To catch *every* `srcdoc`
assignment, patch the prototype rather than a single iframe instance — the
preview iframe is recreated on each render (`previewEl.innerHTML = ''` + fresh
`createElement`), so an instance-level patch is gone the moment the frame is
rebuilt:

```js
const proto = HTMLIFrameElement.prototype;
const desc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
Object.defineProperty(proto, 'srcdoc', {
  configurable: true,
  get() { return desc.get.call(this); },
  set(v) {
    if (this.classList.contains('html-preview-frame')) {
      console.log('srcdoc set:', v.length, new Error().stack);
    }
    desc.set.call(this, v);
  }
});
// Always restore:
Object.defineProperty(proto, 'srcdoc', desc);
```

This caught the double assignment (raw, then resolved ~40ms later) that
per-instance patching missed. Leave the prototype patched only while debugging.

**Why Playwright is not enough.** `e2e_smoke_test.py` mocks `cdn.jsdelivr.net`
from local `node_modules`, which **changes timing**. Race conditions that
trigger in production (slow CDN, multi-MB content, real network latency) may not
reproduce under Playwright at all. For HTML-preview, sandbox, or `postMessage`
bugs, open the **F12 Console on the actual production site** before concluding
anything. Reference `7cb7555`: Playwright said PASS and pixel analysis in the
demo said PASS, but a 3.7MB file (`WinLase.html`) broke in production in a way
neither test could see.

**The "no placeholder" rule for async rendering.** If placeholder content
arrives less than ~100ms before the real content, **do not render a placeholder
at all.** On small payloads the user never sees it; on large payloads the second
assignment interrupts the parser and may leave the frame in a broken state
(blank). Prefer a **single render after the async step completes**, with an
explicit loading state (empty frame or spinner) during the wait. This is
precisely what `renderHtmlPreview` does now: it `await`s `buildHtmlSrcdoc()` and
assigns `srcdoc` exactly once.

## Never assign a handler with a parameter straight to `onclick`

`els.btnNewFile.onclick = onCreateNewFile;` looks fine and is a classic JS idiom
— until the handler has a **path** parameter. The browser calls the handler with
the `MouseEvent`/`PointerEvent`, so `folderPath` became the event object, the
`= fileTree.getActiveFolder()` default never applied (defaults only fire on
`undefined`), and the app asked GitHub for
`contents/%5Bobject%20PointerEvent%5D/name.md`. The user saw the prompt say
`created in "[object PointerEvent]"`.

Only `onCreateNewFile` / `onCreateNewFolder` (now in `js/file-ops.js`) take an
argument — every other `onclick` assignment in `js/app.js` points at a zero-arg
handler, which is why only these two broke. Two rules follow from it:

1. Wrap such handlers in `() => fn()`.
2. Make the function itself defensive, and fall back to the **active folder**,
   not to the repo root: `toFolderPath(value)` returns `value` when it is a
   string, otherwise `fileTree.getActiveFolder()`. Returning `''` for an event
   would be "safe" (no `[object PointerEvent]` in the path) yet silently drop
   the user's intent — the file would land in the root while they were looking
   at a folder. Only an *explicit* empty string should mean the repo root.

`e2e_smoke_test.py` clicks both buttons, answers the prompt, and asserts the
resulting `/contents/...` request URL contains no `object`/`PointerEvent`
**and** points at the tree's active folder. That second assertion is what makes
the check meaningful: verified to fail if the file lands in the root instead.

## Folder operations: ONE atomic commit (commitTreeChanges)

`renameFolder` and `deleteFolder` (`js/folder-manager.js`) never write file by
file. They used to: one PUT + DELETE commit per file, so an error halfway
(network, rate limit, 409) left the folder split in two or half-deleted, the
links not rewritten, and the editor still holding tabs and drafts of deleted
files. Now both collect every change first and send it as ONE commit through
`client.commitTreeChanges(branch, message, changes)` (`js/github-client.js`:
ref -> parent commit -> blobs for new content -> tree -> commit -> ref update).
The branch moves only after the tree and the commit exist: all or nothing.
`onRenameFolder` and `onMoveFolder` both go through `renameFolder`. Moving or
renaming a single FILE still uses the Contents API (`moveToPath`: PUT + DELETE,
then a link pass); only folder operations are atomic.

Rules:

- `options.branch` is required (`file-ops.js` passes `deps.getState().branch`);
  without it both functions throw before any request.
- Read before write. A `.md` inside the folder is read, and its own relative
  links plus links to its moved neighbours are rewritten
  (`rewriteOwnRelativeLinks` + `updateReferencesInFile`); a read failure there
  aborts BEFORE the commit, so GitHub is untouched.
- Any other file (pictures, `.gitkeep`) is NOT read: it moves as
  `{ path: newPath, sha }` with the sha from the tree, no re-upload.
- Notes outside the folder are read for links; an unreadable one goes to
  `failedFiles` and does not stop the rename.
- Change shapes: `{ path, contentB64 }` new content, `{ path, sha }` an existing
  blob under a new path, `{ path, sha: null }` delete.
- The demo client (`js/demo-client.js`) has an in-memory `commitTreeChanges`
  with the same contract. Keep it in step, or folder operations break in demo mode.

The old stale-snapshot problem (a loop of `moveFile` calls reading an `allFiles`
list that no longer matched GitHub) is gone with the loop: the old -> new path
mapping is built once, before anything is read or written, and name collisions
are checked from it.

Tests: `test/folder-manager.test.js` (one commit on the given branch, a picture
moves by its sha and is not read, a read failure changes nothing, a failed
delete commit leaves every file), `test/github-client.test.js` (blob reuse, a
blob only for new content, a failed tree means no branch update), and the fake
clients in `test/file-ops.test.js` and `test/link-failures.test.js`.
`e2e_smoke_test.py` answers the Git Data API (`GIT_TREES`, `GIT_BLOBS`,
`GIT_REF_UPDATES`); scenario I asserts one tree, one ref update, the exact tree
entries (new path with the old sha, old path with `null`), no new blob and no
contents PUT/DELETE. The old per-file way fails every one of those lines. A new
e2e scenario that renames, moves or deletes a folder must check the same way.

## Drag-and-drop move: never block the tree on link rewriting

**Symptom (hit more than once):** drag a file to another folder → GitHub
PUT+DELETE succeed and a full page reload shows the new location, but the
sidebar still shows the *old* path until F5. Create/delete look fine. Easy to
mis-diagnose as "tree lag" or "collapsed folders".

**Root cause (two layers):**

1. `moveToPath` does `putFile(new)` + `deleteFile(old)`, then
   `updateReferencesEverywhere` — a sequential GET (+ optional PUT) for **every**
   `.md` in the repo. On a real knowledge base that is hundreds of requests and
   can take **minutes**. Until that loop finishes, `onMoveFile` never reaches
   `loadTree` / `setFiles`, so the UI looks frozen even though the blob already
   moved on GitHub.
2. Even after the loop, `client.getTree()` (recursive git tree) can still list the
   *pre-move* paths for a few seconds. A bare `loadTree()` then **overwrites** any
   optimistic local patch with the stale remote list — same visual as (1).

**Required shape (do not "simplify"):**

```js
await putFile(newPath, …)
await deleteFile(oldPath, …)
// UI refresh MUST happen here — not after updateReferencesEverywhere
await options.onMoved?.({ oldPath, newPath })  // → loadTree({ rewritePath, expandFolder })
const updated = await updateReferencesEverywhere(…)  // may take a long time
```

- `loadTree({ rewritePath: { from, to }, expandFolder })` applies the local
  old→new rename **after** the GitHub tree response and **before** `setFiles`,
  so a lagging recursive tree cannot resurrect the old path.
- `expandFolderChain` opens the destination and every ancestor (leaf-only expand
  still hides the file under a collapsed parent).
- Status text: `Moved: … (updating links…)` during the rewrite pass, then the
  final count when it finishes.

Create/delete only need a normal `loadTree()` because a single Contents write
usually shows up in the next tree response; move is put+delete plus optional
mass link edits — different failure mode.

**Regression check:** drag `Notes/a.md` → `Notes/Other/` on a repo with many
`.md` files. The row must leave the source folder within ~1–2s of the DELETE
(200), *without* waiting for the link-rewrite storm to finish. F5 must not be
required. Console (optional): PUT 201 → DELETE 200 → soon after, `git/trees` GET
and a DOM update; reference GETs may continue in the background.

Related: `js/file-mover.js` (`onMoved`), `js/file-ops.js` (`onMoveFile` /
`onRenameFile`), `js/app.js` (`loadTree` rewritePath), `js/file-tree.js`
(`expandFolderChain`).

## The active folder must be re-validated on every tree load

`FileTree.activeFolder` is the "create here" target, and it outlives the folder
it names. Deleting or renaming that folder reloads the tree, but `setFiles()`
used to only assign `files` and re-render — nothing noticed the stored path was
gone. The next `onCreateNewFile()` (in `js/file-ops.js`) then PUT into it and
silently resurrected a folder the user had just deleted.

`setFiles()` now drops the target to the repository root when the folder is no
longer in the tree, and prunes `collapsedFolders` at the same time. Both come
from one `collectFolderPaths(files)` helper, because Git has no real folders —
they exist only as path prefixes, so the set of folder paths implied by the file
list *is* the definition of "which folders exist". One check therefore covers
`onDeleteFolder` *and* `onRenameFolder`, since both end in `loadTree()`.

The `collapsedFolders` half used to be dismissed as harmless, and that was
wrong: a stale entry is not inert, it becomes live again the moment a folder of
that name is recreated, and the new folder then starts collapsed for no visible
reason. Note this also means a folder *created* after the first render starts
expanded — `render()`'s "collapse everything" block runs once only, guarded by
`treeInitialized`. That is intended, not a bug.

`setActiveFolder()` is only ever called with a folder path and always *after*
`loadTree()`, so a folder that was just created is never caught by the pruning.
`test/file-tree.test.js` covers delete, rename, the still-exists case, the
root-is-always-valid case, and the recreate-after-delete case; verified to fail
without the fix (`actual: 'Notes/deep'`, and `▸` where `▾` was expected).

## The context menu dismisses on an outside click — register synchronously

The obvious way to make the menu survive a click on its own buttons is to defer
the dismiss listener with `setTimeout(…, 0)`. **Do not.** It leaves a window in
which the menu is on screen but not yet armed, and a click landing in that
window does nothing at all. That was not theoretical: it made the e2e dismissal
check flaky (roughly 1 run in 3), because `wait_for_selector` returns as soon as
the menu is attached — possibly before the timer fired — and the test's next
click then landed in the gap.

The listeners are registered synchronously and the document handler ignores
clicks inside the menu (`menu.contains(e.target)`). That removes the race and
makes the code correct even if the menu is ever opened from a plain left click
(a "⋯" button), where the opening click would otherwise still be bubbling and
would close the menu before anyone could pick from it. `closeMenu()` removes both
listeners instead of relying on `{ once: true }`, because a click inside the
menu must NOT consume the dismiss handler.

`e2e_smoke_test.py` asserts the menu really detaches on Escape and on an outside
click. It failed with the `setTimeout` version; 6/6 consecutive runs pass with
the synchronous one.

## b64ToUtf8 must keep `fatal: true`

`escape`/`unescape` are Annex B (deprecated since 1999); `github-client.js` now
uses `TextEncoder`/`TextDecoder`. The subtle part is the decoder's `fatal` flag,
and it is easy to remove by accident:

```js
new TextDecoder('utf-8', { fatal: true }).decode(bytes)
```

`moveToPath()` only rewrites the text of `.md` files, and it uses a thrown error
as the signal to leave the original bytes alone (see its `catch` in
`file-mover.js`). The **default** `TextDecoder` never throws — it substitutes
U+FFFD — so a binary blob sitting under a `.md` extension would be decoded into
replacement characters and PUT straight back to GitHub.
`updateReferencesEverywhere()` relies on the same throw.

`test/base64-utf8.test.js` pins both halves against `Buffer` as an independent
UTF-8 reference, and `test/file-mover.test.js` pins the end-to-end consequence:
verified to fail without `fatal`, with the mangled payload visible
(`'aO+/vWk='` instead of `'aIBp'`).

One deliberate behaviour change: `utf8ToB64` used to throw a `URIError` on a
lone surrogate (`encodeURIComponent` did); `TextEncoder` substitutes U+FFFD
instead. Strings arriving from a textarea are well-formed, so this should not be
reachable in practice.

## Empty files: `!x` is true for an empty string

GitHub returns `content: ""` for a 0-byte file (every `.gitkeep` the app
creates). `getFileB64()` used `if (!b64)` as "content missing / file too large",
so an empty file threw `Empty contents or file too large` and aborted the whole
folder move. It now returns `{ b64: '' }` when `data.size === 0`, before the
blob fallback. Check `size === 0` explicitly; never treat an empty string as a
failure. `getBlobB64()` has the same `size === 0` check (history restore of an
empty version). Pinned by `test/github-client.test.js`.

## inlineImageMarks: the generation guard is what stops orphaned marks

A stale-mark leak here is easy to *claim* and hard to *believe*, so read
`renderInlineImages()` before changing it. What it draws in Source is a file
LINK (name + location) — the picture itself belongs to the Live/Preview panes
(`markdown-tokens.js`). The invariant is not the generation guard on its own —
it is the combination of three things:

- `markText()` and `inlineImageMarks.push(mark)` (editor.js) run **synchronously**
  in the same turn, *before* the `await` that resolves the image;
- every run clears the registry at its top, so a newer run always clears the
  marks an older one already pushed;
- both the pre-creation guard and the post-await guard `return` when
  `generation !== inlineImageGeneration`.

Consequence: a superseded run can never push a mark after a newer run reset the
array, because the only way to reach the next loop iteration is to survive the
post-await guard. That is why a fixture using only one image per file proves
nothing — it cannot tell "the guard fired" from "the loop had ended anyway".

`test/editor.test.js` ("switching files mid-render…") drives this with two
parked resolvers and a two-image file, so the superseded run *would* create a
second mark if the guard were gone. Verified to fail without the guard
(`actual: 3` — the old file's second mark survives).

**Removing only ONE of the two guards does not fail the test**, and that is
expected, not a gap: they are redundant with each other for this scenario.
Removing both produces the orphan (`resolve#3 … marks=3`). So keep them both —
they cost nothing and each covers a path the other does not: the pre-creation
guard avoids building DOM that would be discarded, the post-await guard also
covers the `catch` branch, and `mark.find() == null` additionally covers a mark
cleared by a rebuild while the await was still in flight.

Images inside code are skipped: `renderInlineImages()` takes its matches from
`findMarkdownImages()` in `js/markdown-tokens.js`, which skips fenced code (also
inside block quotes) and any match that starts inside inline code. An atomic
mark on such an example used to hide the code and make it uneditable. Do not go
back to one raw regex over the whole document.

## createEditor() owns global resources and now has to be destroyed

`createEditor()` attaches a `ResizeObserver`, a `paste` handler on CodeMirror's
input field and a `change` handler on CodeMirror — none of them reachable from
outside, so there used to be no way to release them. It returns `destroy()`,
which disconnects the observer, clears the pending inline-image timer, removes
both handlers and calls `easyMDE.toTextArea()`. That last one matters: the
`<textarea>` in `index.html` is a stable element, and re-wrapping an
already-wrapped one stacks a second editor on top of the first. Teardown is
idempotent and must never throw.

`showApp()` calls `destroy()` on the previous handle before building a new one.

**Logout cannot leak it.** `btnLogout` does `sessionStorage.clear()` +
`location.reload()` (app.js), which tears down the whole JS realm — observers
and all. There is no surviving editor after that. Don't "fix" logout by
rebuilding the UI in place; that would be the only way to create the leak.

The path that *did* build the app twice is `init()` racing itself:

```js
consumeOAuthRedirect();      // NOT awaited — finishLogin() awaits the network (both in js/login-ui.js)
const saved = readSession(); // runs while the token check is still in flight (js/login-ui.js)
if (saved) showApp(...);     // path A
```

`finishLogin()` (`js/login-ui.js`) calls `showApp()` itself. So when an OAuth
callback landed on a tab that still had a session (re-entering `/auth/login`,
say), path A built the app, the network call resolved, and `showApp()` ran a
second time — two editors, two observers, two paste handlers, with the first
unreachable. `init()` is now `async`, awaits `consumeOAuthRedirect()`
(`js/login-ui.js`), and returns early when it reports that it completed the
login.

Two caveats worth keeping in mind:

- `consumeOAuthRedirect()` (`js/login-ui.js`) returns `false` (so `init()` falls
  through to the normal session path) both when there is no `#gh_token` at all
  **and** when the `owner`/`repo` pair is missing. The second case used to leave
  the user on the login screen; now it also renders that message underneath the
  app when a stale session is present. Fixing that would mean deciding what "log
  in again" means, so it was left alone deliberately.
- `init()` is still invoked un-awaited at module top level, so with no hash the
  app now appears one microtask later than before. Nothing depends on it being
  synchronous (all callers are event handlers), but a `wait_for_selector`-style
  test would notice.

**`e2e_smoke_test.py` does not cover either of these paths.** It fakes a session
by writing the four `sessionStorage` keys and reloading — so it exercises the
`readSession()` (`js/login-ui.js`) branch with no hash, and can never reach
`consumeOAuthRedirect()` / `finishLogin()` (both `js/login-ui.js`) or
`showApp()`-twice. The `destroy()` contract is covered by `test/editor.test.js`
(verified to fail if the observer is not disconnected); the `init()` race is
**not** covered by any test, and per the OAuth notes above it cannot be verified
locally without `wrangler pages dev` and a test OAuth app.

## showApp() is re-entrant

`showApp()` runs again when the user switches repositories in-app (no page
reload). Every `setup*` function it calls must therefore be idempotent:

- **Dataset guard on the element.** Setup functions bind listeners to stable DOM
  nodes from `index.html`. A second `showApp()` would stack a second set of
  listeners, so each setup function guards with `if (el.dataset.<name>Bound) return;`
  then sets `el.dataset.<name>Bound = '1'` (see `setupMobileShell`,
  `setupImageDropzone`, `pickImageFiles`, `setupFolderDropzone`).
- **Read session-dependent values through getters at use time.** `state.client`,
  `imageResolver`, the editor instance, etc. must never be captured by value at
  bind time — a captured client belongs to the previous session and writes would
  go to the wrong repository. Use `getClient: () => state.client` etc. and read
  them inside the handler (see `upload.js`, `folder-upload.js`).
- **Subscriptions bound to an OBJECT need an identity check.** CodeMirror
  `cursorActivity` (outline scroll-spy) is bound to the editor handle, which is
  recreated on every `showApp()`. A DOM dataset guard is wrong here — the element
  is the same, the object is not. Use identity-keyed rebinding
  (`bindOutlineScrollSpy` returns early if `outlineCursorBoundTo === editorHandle`)
  instead.
- **e2e scenario H guards this.** The e2e smoke test otherwise always cold-starts
  (seeds `sessionStorage`, reloads). Scenario H switches repo in-app and asserts
  exactly one PUT into the new repository plus working mobile toggle buttons — it
  goes red if any of the above rules regress.
  
## Search index — IndexedDB quirks and the no-Cache-Control rule (again)

Added for the client-side full-text search (MiniSearch + IndexedDB). The four
modules are `js/search-index.js` (pure logic), `js/search-store.js` (IndexedDB),
`js/search-sync.js` (orchestration), `js/search-ui.js` (DOM).

**No `Cache-Control` header, still.** The sync fetches hundreds of files in a
loop, which makes "just add `no-cache` to be sure" very tempting. Don't — see
the CORS safelist section above. `getTree()` busts GitHub's cache with a unique
query parameter, which is the only mechanism allowed here.

**Degraded modes are deliberate — do not "fix" them by deleting the fallback.**
Both are hit in the wild and neither is reachable from `e2e_smoke_test.py`:

- **No IndexedDB** (private window, Safari ITP, storage disabled).
  `indexedDB.open` can throw synchronously or never resolve. `SearchStore.open()`
  returns `false`, flips `degraded`, and every read/write silently falls through
  to an in-memory map. Search keeps working for the session and the status line
  says *"Search is session-only (storage unavailable)"*.
- **`QuotaExceededError` on `put`.** The index is re-serialized on every batch,
  so a big repo can exceed the origin quota. `put()` drops the oldest record of a
  **different** repo and retries **once**; a second failure degrades to memory
  with the same banner. `evictOldest(keepKey)` must never delete `keepKey` —
  that record is the one being written, and losing it loses the whole index.

`degraded` is **sticky**: `open()` returns `false` immediately once set. Without
that, the next call re-opens the database (opening still works — it is the
*writes* that fail), the store resumes reading a database with nothing in it,
and the session appears to lose the index it just built. This was a real bug
caught by `test/search-store.test.js`.

**Records outlive the session on purpose.** The index lives in IndexedDB; the
token lives in `sessionStorage`; logout clears only the latter. Signing back
into the same repo reuses the index instead of refetching the repo. Do **not**
add "clear the index on logout". Records carry a 30-day TTL on `savedAt`, swept
in `open()`, so a repository deleted on GitHub does not linger forever.

**The body is never in the index.** `storeFields: ['path', 'title']` only —
serializing bodies would balloon the blob. Snippets come from a 200-entry LRU
cache of raw bodies, filled as the sync fetches them, with a lazy per-result
fetch for a cache miss. `buildSnippet()` HTML-escapes everything except its own
`<mark>`; a note body is untrusted and that string goes to `innerHTML`.

**`discard()`, not `remove()`.** MiniSearch's `remove()` demands the *full*
original document, which we cannot reconstruct because we do not store the body.
`discard(id)` is documented as having "the same visible effect", and
MiniSearch's own auto-vacuuming cleans up afterwards. Calling `remove()` with a
rebuilt body corrupts the index.

**MiniSearch 7 API changes** (`getDocument` → `getStoredFields`, deserializing
via the static `MiniSearch.loadJSON(json, options)`). The options object must
match the one used at construction, so `createSearcherOptions()` returns a fresh
object per call instead of a shared constant.

**An empty tree is a real diff, not a no-op.** `runSearchSync()` skips only
while `state.treeLoaded` is false; deleting the *last* note leaves `allFiles`
empty and must still sync, or the deleted file stays in the results forever
(found in a real browser, pinned by the "emptied repository" test). For the same
reason the "nothing changed" branch of `SearchSync.run()` still stamps
`lastSyncedAt` — otherwise the status reads "last synced 20731d ago".

**Two counters, on purpose.** In `SearchSync.run()`, `done` counts files that
really entered the index and is what `run()` returns and `onDone` reports;
`processed` counts every file attempted, skipped ones included, and drives
`onProgress` and the batch persistence. Progress must reach `N/N` even when a
file is skipped (unreadable, or not valid UTF-8), and `indexed` must not claim
files that are absent from the index. Both are pinned in
`test/search-sync.test.js`.

**A path enters the manifest only after it has been fetched.** Unchanged paths
go in up front; new/changed ones only after a successful download (a non-UTF-8
body counts as fetched, so binaries are not re-downloaded every sync). A failed
download stays out, so the next sync retries it. The manifest is persisted every
`BATCH_SIZE` files, so pre-filling it would make an interrupted first sync (tab
closed, repo switched) skip unfetched notes forever. Pinned by
`test/search-sync.test.js`.

**Bump INDEX_VERSION when indexing rules change.** `INDEX_VERSION` in
`js/search-index.js` is stored with every record. `hydrate()` reuses a record
only when the version matches AND the blob deserializes; otherwise it starts
with an empty index AND an empty manifest, so the next sync refetches
everything. Changing `extractTitle`, `stripMarkdown` or the searcher
fields/options without a bump leaves old titles/bodies in every browser until a
manual rebuild. Never keep a manifest next to an index that failed to load: the
sync then believes everything is indexed and search stays empty.
Current value: 7 (2 = shared fence rules in `stripMarkdown`, 3 = fences inside
block quotes, 4 = outgoing links stored for backlinks, 5 = link targets in
`<...>` and percent-encoded targets read by backlinks, 6 = one level of
balanced `(...)` inside a target, 7 = backlinks use the shared external-link
rule `isExternalOrAnchor`). A change in `js/md-fences.js` changes what
gets indexed, so it needs a bump as well; so does a change in
`extractOutgoingLinks()` (`js/backlinks.js`), in `LINK_TARGET_SRC` /
`REF_TOKEN_RE` / `classifyRefMatch()` (`js/markdown-tokens.js`) or in the link
rules of `stripMarkdown`, because the result is stored in the record (next
paragraph). A test pins the number (`test/search-index.test.js`).

**Backlinks survive a reload: outgoing links are stored with the index.** The
record also holds `links` (`{ [path]: string[] }`): for every note that entered
the index, `extractOutgoingLinks(path, body)` - the same function
`backlinkIndex.setFile()` uses. `hydrate()` hands each entry to
`onLinksRestored` and `app.js` calls `backlinkIndex.setLinks()`. Unchanged notes
are never downloaded again after F5, so the 200-entry body cache alone left the
panel almost empty. Rules: the keys of `links` are a subset of the manifest keys
(`_linksInManifest()` filters on save and on load, so an interrupted first sync
keeps no links of a file it did not fetch); removed and changed paths drop their
links, `force` clears them, a non-UTF-8 body has none; notes only
(`isNoteSourcePath()` - one rule for `setFile`, `setLinks` and the sync). Pinned
by `test/search-sync.test.js` ("search-sync links") and the e2e tabs reload
check (G5).

**Teardown**: `showApp()` destroys the in-flight sync alongside the editor
handle, for the same reason — a re-login must not leave the old indexer fetching
and writing into the new session's store.

**What local checks cannot see:** `e2e_smoke_test.py` mocks `api.github.com`, so
rate limits (403), IndexedDB quota and private-window behaviour are all
invisible to it — they are covered by `test/search-store.test.js` instead. The
e2e test seeds `sessionStorage` and reloads, so its first load is a cold start
(empty IndexedDB). Later reloads in the same page keep IndexedDB: the tabs
scenario (G5) relies on that to check backlinks after a reload without
downloading the linking note.

### Autosave — hybrid model: local on idle, GitHub only on Save / Commit

Two independent layers, on purpose (`js/draft-store.js` + `js/autosave.js`):

| Layer | When | What |
|---|---|---|
| **LOCAL** (IndexedDB) | every keystroke, debounced 400ms; also on idle / tab hide / file switch | crash recovery draft |
| **REMOTE** (GitHub) | **only** explicit **Save** (current file) or **Commit** (working tree) | `putFile` / multi-file Git Data API |

**Do not reintroduce auto-push on idle.** That made the Commit panel useless
(changes were already on GitHub before the user could open the drawer) and
created races with manual Save. Pinned by `test/autosave.test.js` and the e2e
hybrid checks.

**Timers (local only):**

| Timer | Fires at | Restarted by | Effect |
|---|---|---|---|
| local-write debounce | 400ms after last keystroke | every `onChange` | write draft to IndexedDB; status `○ Local only — Save or Commit to push` |
| idle | 10s after last keystroke | every `onChange` | ensure draft is written; **no** GitHub PUT |
| max (5 min) | — | — | **disabled for remote**; kept as an API no-op so continuous typing does not force commits |

**`beforeunload` is still a trap** — never await a network write there. Only
`autosave.hasUnsavedDraft()` for the browser "unsaved changes" prompt.

**`visibilitychange` → hidden** and **`flushCurrentFile()`** (tab switch /
close) checkpoint the **local draft only**. They must not call `_push`.

**State machine** (pinned in `test/autosave.test.js` on `mock.timers`):

```
clean         --onChange-->               dirtyLocal   ● Unsaved
                                          (arm 400ms draft write, arm 10s idle)
dirtyLocal    --400ms draft written-->    dirtyIdle    ○ Local only — Save or Commit to push
dirtyIdle     --onChange-->               dirtyLocal   (restart idle)
dirtyLocal    --10s idle-->               dirtyIdle    (draft only; no PUT)
dirtyLocal    --saveNow() / Commit-->     pushing      ⟳ Saving to GitHub…
pushing       --putFile resolves-->       clean        ✓ Saved to GitHub
pushing       --409 twice-->              error        ⚠ reload / overwrite
pushing       --other error-->            dirtyLocal   ⚠ Save failed (user must Save again)
error         --reload / overwrite-->     clean / pushing
```

**`saveNow()`** is the single-file remote write (toolbar **Save**). Multi-file
remote writes go through the **Commit** panel + `working-tree.js`. Successful
remote writes clear that path in the working tree via `onRemoteCommit` /
`noteCommit`.

**Background failures** are still stored per-path so a failed Save after the
user switched files does not paint ⚠ on the newly opened file.

The e2e suite asserts: typing does not PUT; idle does not PUT; explicit Save
PUTs once; draft survives reload; 409 retry / Reload / Overwrite still work. It
never waits out a 5-minute max (CI flake) and never claims a cold-start reload
keeps an in-memory-only index.

## Browser tests: wait for the completed file open, not just its label

`openFile()` updates the current-file label before asynchronous draft
lookup and document installation finish. A matching label is not proof
that CodeMirror is showing that file yet. After a tab switch, browser
tests wait for the target label AND `btn-save.disabled === false`, then
assert the exact document text. Do not replace that assertion with a
fixed sleep or accept either document.

Lesson from the E2E K preparation for `2c8434a`: the new test sometimes
read A while the label already named B. In-memory diagnostics changed
timing and passed; waiting for completed opening fixed the test without
changing application code. A diagnostic PASS alone did not prove it safe.

## Tabs: who owns what, and the rules that keep them safe

**Split of responsibilities.** `js/tabs.js` is a pure model (ordered paths + the
active one + rename/delete bookkeeping + persistence); `js/tabs-ui.js` only
draws the strip and reports clicks; tab session state
(`tabDocs: Map<path, {doc, sha, unsaved, stale, commitSeen}>`, open/close/switch)
lives in `js/tabs-session.js`. A *lazy* tab is a restored tab that was never
opened - it is fetched on first click, never at page load.

**One CodeMirror `Doc` per tab, swapped with `swapDoc()`**
(`editorHandle.createDoc` / `showDoc`). Do not load a tab's text with
`easyMDE.value()`: that overwrites the single shared document and throws away
undo history, cursor and scroll. `swapDoc` fires no `change` event, so switching
tabs is not mistaken for typing, but inline image marks belong to a document and
are rebuilt by `showDoc()`. `setEditorValue()` (which uses `.value()`) is still
right for replacing the text of the CURRENT file in place — "Reload from GitHub"
in the conflict banner.

**Going around `value()` has a price: whatever EasyMDE hangs on `value()` no
longer happens.** The one that matters is the full **Preview** pane, which
EasyMDE re-renders only from `value()`; `showDoc()` re-renders it by hand
(`renderActivePreview()`), mirroring EasyMDE's own code. Without it the tab and
file name change and Preview keeps showing the first document. Side-by-side
needs nothing (it re-renders on CodeMirror's `update` event, which `swapDoc`
fires) and cannot be combined with switching tabs anyway: EasyMDE puts it in
fullscreen, over the tab bar. Any new editor mode or EasyMDE upgrade is a reason
to re-run the Preview scenario in `e2e_smoke_test.py` (group G).

**When is the cached document trusted?** Only if the tab was clean when left
(`!unsaved`) and not `stale`. Autosave is a state machine for ONE file; a tab
left dirty is re-fetched on return, and the draft banner then offers the local
text — the same path as switching files has always taken, so there is a single
code path for "what is the truth after a background commit". `unsaved` is
computed in `openFile()` twice on purpose: once right after the first flush (so
the commit overlaps the fetch), and again after the fetch, because the old tab
stays editable while the new file loads and whatever was typed meanwhile must be
flushed too. `commitSeen` exists because the background commit can land BEFORE
we decide `unsaved`; without it the tab would stay marked unsaved forever.

**Never `destroy()` the Autosave to leave a file — use `release()`.** A
destroyed instance skips `_afterCommit`, so a push still in flight leaves its
draft behind and the file later shows a phantom "unsaved local changes" banner.
`release()` drops the path (typing is ignored, timers are gone) but lets the
in-flight push clean up. `closeCurrentFile({flush:false})` is for files that
were just DELETED.

**`openFile(path)` on the file that is already open is a no-op** (it only
focuses the editor). Re-opening it would call `autosave.onOpen()` and reset the
state machine under the editor's unsaved text. Callers that really need a fresh
copy — rename, move, links rewritten by a move — pass `{reload: true}`;
moving/renaming the open file MUST do so, because it also rebinds autosave to
the new path.

**`openSeq`** guards the slow-open race: every `openFile()` takes a number and
gives up after each `await` if a newer one started. Do not move assignments to
`state.currentPath` above those checks.

**Tabs are only dropped on purpose**: when the user closes one, or when a delete
here removes its file (`dropTabs`). They are NOT pruned against every
`loadTree()` — a tree that is momentarily behind a commit would close the editor
under the user. The one exception is the restore at page load, which discards
paths that no longer exist.

**Not done on purpose (v1):** drag-to-reorder, keyboard shortcuts for
next/previous tab (Ctrl+Tab / Ctrl+W belong to the browser), a "reopen closed
tab", pinned tabs, and refreshing a clean cached tab when the file changed on
GitHub meanwhile (a stale sha surfaces as the usual 409 flow on the next commit).

## HTML Live/Preview — two panes, one funnel, null protocol, no srcdoc churn

Added after three stacked bugs (empty pane → alternating "renders / doesn't
render" → 2-3× flicker on every Live/Preview switch). Read this before touching
`previewRender`, `renderActivePreview` or `fillPreviewPane` in `js/editor.js` /
`js/app.js`.

**There are TWO preview nodes per container**: `.editor-preview-side` (the
visible Live/Preview pane) and `.editor-preview` (EasyMDE's full-preview pane,
still in the DOM). `renderActivePreview()` loops over BOTH in one tick. A global
`previewRenderToken` therefore made the SECOND pane's call cancel the FIRST
pane's deferred fill — which pane "wins" depended on call order (EasyMDE's
`update` vs our render), so the visible pane alternated between filled and empty
on Live/Preview switches. **State is per-pane now**: `htmlPaneStates` WeakMap
(`{token, chain, renderedText}`) inside `renderHtmlPreview()` — the single
funnel for all HTML rendering. `fillPreviewPane` (app.js) must DELEGATE to
`editorHandle.renderHtmlPreview()`, never build its own iframe; panes are
independent and must never block each other.

**`previewRender` returns `null` for HTML, never `''`.** EasyMDE has three write
sites (`sideBySideRenderingFunction`, `togglePreview`, the `value()` setter), all
guarded by `!= null` / `!== null` — `''` PASSES those guards and wipes the pane.
Our own callers mirror the same rule (`renderActivePreview` and
`fillPreviewPane` skip `null` too). The async fill owns the pane for the whole
HTML branch; nobody may `innerHTML = ''` it.

**Assigning `iframe.srcdoc` is a FULL iframe navigation — a visible flash.** One
Live/Preview click triggers a render up to THREE times (our `forceLayout` runs on
double-rAF + EasyMDE re-renders on CodeMirror `update` from `cm.refresh()`), and
each render used to assign srcdoc twice (raw, then resolved) → up to 6 reloads
per click (measured by the test: "iframe reloaded 6x"). Two guards, both
required:

- `state.renderedText === plainText` → **early return**, untouched srcdoc.
  A layout switch does not change the text, so it must reload nothing.
- compare before assigning (`iframe.srcdoc !== raw` / `!== srcdoc`) — even an
  identical value reloads the frame.

`renderedText` is stamped only AFTER the resolved srcdoc lands and only when the
per-pane token is still current — a superseded pass must not claim the pane.
Markdown/code panes must keep using plain `innerHTML` (no reload = no flicker) —
routing them through the iframe path would reintroduce flashing.

Covered by `test/editor.test.js`: "HTML preview fills BOTH panes on every render
pass (no alternating starve)" and "Live/Preview switching with unchanged text
NEVER reloads the HTML iframe (flicker)" — both verified RED without the fixes
(starved first pane; `6 !== 0` reloads). The e2e HTML check (`HTML Live preview
renders page content`) only proves content exists once; it cannot see
alternation or flicker (timing), so the unit tests are the guard.

## Outline (heading map) — jump to the VISIBLE scroller

`js/doc-outline.js` is a pure parser (unit-tested in `test/doc-outline.test.js`):
ATX headings with up to 3 leading spaces, skips fenced code blocks and indented
code, does NOT strip the `#` of `C#`, skips bare `#`. Do not re-derive it inline
in `app.js` — the original inlined regex listed `#` comments inside code blocks
and mangled `C#`.

**A jump must scroll whichever pane is actually visible.** In Preview layout
CodeMirror is `display:none`, so `setCursor` / `scrollIntoView` / `focus()` all
silently do nothing on screen (that was the original "click highlights but
nothing happens" bug). `jumpToOutlineHeading()` in `app.js` scrolls CodeMirror
AND the `.editor-preview-side` pane (Nth rendered heading by outline index,
fractional `scrollTop` as fallback), unfolds a folded section first via
`editorHandle.unfoldAtLine(line)` (otherwise the cursor lands inside hidden
collapsed text), and skips `cm.focus()` while `layoutMode === 'preview'`.

The panel refreshes via a debounced `scheduleOutlineRefresh()` hooked to the
editor's `onChange` (the old `document keydown` listener was dead code —
removed) and highlights the nearest heading above the cursor via
`cursorActivity` (`markActiveOutlineItem` / `.outline-item.active`). Keep both
when reworking the panel.

## Fenced code blocks: scan markdown through js/md-fences.js

Anything that looks for links, images or headings in markdown text must skip
fenced code blocks (backtick or tilde fences). Otherwise an example inside a
code block is treated as real content: a move rewrote links inside examples and
committed the change, Preview turned example images into canonical tags, and a
`# comment` in a bash block became the note title in search.

Use the helpers from `js/md-fences.js` instead of writing a new fence regex:
`splitByFences(text)` (segments `{text, code, start}` that join back
byte-for-byte, CRLF included), `mapOutsideFences(text, fn)`,
`replaceOutsideFences(text, re, fn)`. Segment boundaries are always at line
starts, so look-behinds such as `(?<!!)` behave as before. When a caller needs
positions in the WHOLE text (e.g. `data-md-line` in `injectCanonicalImageTags`),
add the segment `start` to the match offset.

Rules (deliberately lenient on indentation): any indentation before the fence; a
backtick fence line must not contain another backtick (three backticks around a
word on one line are inline code); the closing fence uses the same character, is
at least as long, and has nothing after it; an unclosed fence runs to the end of
the text. Pinned by `test/md-fences.test.js`.

Every caller uses these helpers now: links on move (`reference-rewriter.js`),
Preview/PDF images and Source image widgets (`markdown-tokens.js`), search
(`extractTitle`, `stripMarkdown`), task checkboxes (`markdown-commands.js`), the
outline (`doc-outline.js`) and the scroll-sync heading anchors. Do not add a
second fence regex anywhere; extend `md-fences.js` and its tests instead.

Rules beyond plain fences:
- A fence may sit inside a block quote (`> ~~~`, `>>`): it closes on a fence at
  the same quote depth or where the quote ends (fewer `>` or a blank line).
- Inline code: `findCodeSpans()` (a run of N backticks closed by the next run of
  exactly N, never across a blank line). A match is skipped only when it STARTS
  inside inline code, so a link whose text is code still counts.
- Image numbering on a line (`data-md-occ`) still counts inline-code examples,
  the way `setImageAttrsInLine()` does, so width edits hit the right image.
- Not handled on purpose: lazy blockquote continuation (a quoted line without
  `>`) and backslash-escaped backticks.

## Live scroll sync: js/scroll-sync.js owns it, not the minimap

Source and Preview are kept in step by `createScrollSync()` in
`js/scroll-sync.js`. `showApp()` builds it with the editor (whether the minimap is
open or not), destroys it with the editor, and `applyLayoutMode()` refreshes it
(EasyMDE replaces the preview element on layout switches). It is active only in
Live (`layoutMode === 'split'`). EasyMDE's own sync stays off
(`syncSideBySidePreviewScroll: false`).

History: the sync used to live inside `minimap.js`, so closing the map destroyed
it. That showed up only with a mouse: Chrome keeps a wheel gesture on the pane
where it started, so the other pane looked stuck or the wrong pane moved. A
touchpad reports where a gesture ends and did not show it. Never tie the sync to
an optional UI piece again; the minimap only paints and handles clicks.

- Position by content, not percentage: an image is one line in Source but
  hundreds of pixels in Preview. Anchors are pairs of offsets: each image gives
  top of its line <-> top of `.md-img-wrap` and bottom of the line <-> bottom of
  the image; headings join only when Source and Preview have the same count.
  Without anchors it falls back to a percentage (`buildScrollPairs`,
  `mapScroll`, pure and unit-tested).
- The following pane glides (`GLIDE_FRACTION` of the remaining distance per
  frame) instead of leaping across tall images. Scrolling the following pane
  mid-glide cancels the glide and makes that pane the leader.
- Echo guard by VALUE: the last 4 written positions are remembered; a scroll
  event at one of them is our own echo. No timers and no flags released by
  `setTimeout` (the old 120 ms flags dropped real input). Do not use
  `scrollTo({ behavior: 'smooth' })`: its intermediate frames look like the user.
- A range jump of more than 10% means a re-render (an image loaded): skip one
  step.

Pinned by `test/scroll-sync.test.js` (pure functions + jsdom with hand-driven
frames) and the e2e check "Live with the minimap closed".

**Cursor follow: deliberately not handled (F13).** The sync maps the TOP of the
leading pane, not the cursor line. Keyboard moves work through it (it listens to
`cm.on('scroll')`, so Arrow Down, Ctrl+End and Ctrl+Home move Preview too), but
in a note with images the cursor line near the bottom of Source can sit 2-3
screens below the visible part of Preview (measured in the browser: 131 lines,
22 images, cursor line 1474-2259 px below a 630 px Preview pane). Getting this
sync right took many hours, so this is left as is on purpose. Do NOT add a
separate "scroll Preview to the cursor" module: its writes are not echoes the
guard knows, so the sync would make Preview the leader and move Source back (the
panes fight). If it is ever done, it belongs inside `createScrollSync()` (e.g.
map the cursor line instead of the top while Source leads and the cursor is on
screen), with RED tests first and the e2e check unchanged.

## Link suggestions and the one link format: js/link-suggest.js

`buildFileLink(path)` is the only place that builds a link to a repository file:
`[name](/path)`, root-absolute, `.md` dropped from the name, `<...>` around a URL
with spaces or parentheses, never percent-encoded. Copy as link (`file-ops.js`)
and the `[[` suggestions both use it. `rankLinkSuggestions()` orders notes for a
query. `createLinkSuggest()` is the popup: its key map (Up/Down/Enter/Tab/Esc) is
added only while it is open, so Enter keeps continuing lists the rest of the time.
It is built and destroyed with the editor in `showApp()`, next to the scroll sync.
The suggestions insert markdown links, not `[[...]]`: those also work on
github.com, which shows `[[...]]` as plain text.

**Readers of that format.** ONE target rule, `LINK_TARGET_SRC`
(`js/markdown-tokens.js`): no spaces, one level of balanced `(...)` allowed
(`Asset/ATS_(BOB_Load)_image_0001.jpg`). It builds `REF_TOKEN_RE` (backlinks,
move/rename, image audit), `IMG_TOKEN_RE` (Preview/PDF, image resize) and
`MD_IMAGE_RE` (Source image widgets); no reader keeps its own copy of the rule.
`REF_TOKEN_RE` also takes a target in `<...>` (same capture groups, the plain
form first); `classifyRefMatch()` returns it without the brackets and
`angle: true`, and `rebuildRefToken()` puts the brackets back. On a move, a
link in `<...>` keeps a plain path; any other link stays percent-encoded
(`encodeLinkPath`, which keeps `(` and `)`). Backlinks decode the target once
with `decodeUriSafe` (rule 7). `stripMarkdown` (search text) drops links by a
looser rule, a superset of its old one. Not handled on purpose: nested or
unbalanced parentheses in a target (`a((b)).png`, `a(b.png` - marked shows
them, our readers do not, and the image audit turns invalid on such a link); a
file whose NAME holds a literal `%20`, linked without encoding, is read as a
space (the rewriter does the same); `>` inside `<...>` is not recognised (not
allowed in Windows file names). The app writes pictures percent-encoded
(`js/upload.js`), never as `![](<...>)`.
Open question: `isExternalOrAnchor()` treats a `//host/x` target as a repo path;
backlinks and the image audit exclude `//` themselves, Preview, the link click
and the image resolver do not. Changing `paths.js` needs its own tests for each
of those callers.

## Wiki links `[[...]]`: one set of rules for backlinks and rewriting

The app reads and rewrites `[[...]]` but never creates them. Both
`extractOutgoingLinks()` (`js/backlinks.js`) and `rewriteWikiLinks()` (called by
`updateReferencesInFile`, `js/reference-rewriter.js`) follow Obsidian:

- `[[./x]]`, `[[../x]]` - from the folder of the note that contains the link;
- any other path (`[[Notes/x]]`, `[[/Notes/x]]`) - from the repository root;
- a bare name (`[[x]]`) - by file name, in any folder;
- `#heading` and `|alias` are not part of the target.

Resolving every wiki link from the note folder (the old backlinks code) hid all
links written in another folder, and `[[Notes/x]]` falsely matched
`Other/Notes/x.md`. Do not go back to it.

Rewriting keeps the written form: `.md` or not, a leading `/`, `./`, `#heading`,
`|alias`, the `!` of an embed; code spans and fences are skipped
(`replaceOutsideFences`). A bare `[[Name]]` is rewritten only when the caller
passes `{ wikiName: true }`. `updateReferencesEverywhere()` (`js/file-mover.js`)
does that only when the file NAME changed and the old name is unique among
`allFiles` (case-insensitive): with two `Printer jam.md` the link could mean
either one, so it is left alone. A move that keeps the name never touches
`[[Name]]`. Folder operations get path wiki links through the same
`updateReferencesInFile`. Not handled: relative `[[../x]]` inside the moved
file itself. Tests: `test/backlinks.test.js`, `test/reference-rewriter.test.js`,
`test/file-mover.test.js`, `test/folder-manager.test.js`.

## Paste a URL over a selection: js/paste-link.js + cm.on('paste')

`linkFromPaste({ selection, clipboardText, inCode })` (pure) returns
`[text](url)` or `null` for a normal paste. Rules: exactly one `http(s)://` URL
with no spaces (trimmed); a non-empty one-line selection without `[` or `]` that
is not itself a URL; not inside code (`isInsideCode()`, built on `md-fences.js`).
A URL with `(` or `)` is wrapped in `<...>`, one with `<` or `>` is a normal paste.
`editor.js` asks only for markdown files and only with a single selection, and
inserts with `replaceSelection`, so Ctrl+Z is one step.

Hook it with CodeMirror's own `cm.on('paste', (cm, event) => ...)`, NOT a DOM
listener on the input field. CodeMirror inserts pasted text in its own DOM
handler, registered before ours, so a DOM listener runs too late: the URL would
already have replaced the selection. `cm.on('paste')` fires first and
`preventDefault()` cancels the insert. The image paste stays a DOM listener: it
only acts when there is no text to insert. The DOM tests in `test/editor.test.js`
call the CodeMirror handler with a fake CodeMirror, so they cannot prove this
order: after touching the hook, check paste in a real browser.
Tests: `test/paste-link.test.js`, `test/editor.test.js`.

## Preview re-render must keep loaded images (no placeholders while typing)

EasyMDE rewrites the Preview `innerHTML` on every keystroke. Images used to come
back as a 1x1 placeholder with `.md-img-wrap.loading` until the async resolve ran:
the pane collapsed (10621 -> 3997 px on a real note), Preview flickered, the
browser moved its scrollTop and the scroll sync dragged Source toward the end.
`ImageResolver.cachedUrl()` reads the cache synchronously (same path rules as
`resolve()`), and `renderMarkdownSafe(text, marked, purifier, { knownSrc })`
writes known images resolved right away. Only new images show the placeholder.
PDF export passes no `knownSrc`. Do not fix this kind of jump in scroll-sync.js:
fix the height collapse. About 15 earlier commits patched the sync instead.
Pinned by `test/image-resolver.test.js`, `test/markdown-tokens.test.js` and the
e2e check 'typing in Live keeps loaded images, no height collapse'.

## Discard: autosave.discardLocalChanges()

The Discard button reverts the open note to its GitHub version: fresh read, draft
deleted, state clean, nothing pushed. It shares `_reloadFromRemote()` with Reload
in the conflict banner and does nothing while a save is in flight. The button is
enabled exactly when the tab shows the unsaved dot (`setActiveFileUnsaved`), and
`onReloadRemote` also drops the file from the working tree, so the Commit badge
follows. New notes are created on
GitHub at once (`onCreateNewFile` PUTs the starter text), so Discard always has
a version to load. Deliberately not handled: a note deleted on GitHub elsewhere
(github.com, another device or tab) while it has unsaved edits here. Discard
then reports "Not Found" and keeps the tab, the dot, the draft and the Commit
entry; the local text and the draft are kept. Rare;
revisit only if it shows up in practice.

## Sidebar: the file tree lives inside .folder-dropzone

`.folder-dropzone` (flex: 1) wraps `#file-tree`; `#search-results` is its sibling
(flex: 1). `search-ui.js` hides only the tree, so the wrapper used to keep half
of the sidebar empty above the results. `css/app.css` hides the wrapper with
`.folder-dropzone:has(> .file-tree.hidden)`. If the markup or the show/hide
logic changes, keep the wrapper hidden whenever the tree is.
`e2e_smoke_test.py` asserts the results start right under the search box.

## Image audit: js/image-audit.js + tools/image-audit.mjs

`auditImages({ files, texts })` is pure: pictures no note links to, image links
to a missing file (with a hint when only the case differs) and groups of
identical pictures by blob sha. Same link rules as the reference rewriter
(Architecture rules 3 and 7). Fail-safe: an unread note, an `![[embed]]` or
`[[x.png]]`, an HTML file pointing at a picture, or an image link the parser
cannot read (an `![...](` outside code that is not inside a parsed token) makes
the report invalid, and an invalid report lists NO unused pictures, so nothing
can be offered for deletion by mistake.

**Lesson: Gillette `5f57fdf` -> `1aca810`.** Before `13d5027` every reader cut
a target at the first `)`: `![x](../Asset/ATS_(BOB_Load)_image_0001.jpg)` was
read as `../Asset/ATS_(BOB_Load`, not a picture path, so the audit skipped it
silently and listed 32 USED pictures as unused; they were deleted together with
51 truly unused ones and restored from `6b276be` in `1aca810`. A tool that
offers deletion must count what it could NOT read, not only what it read.
After any change in link parsing, run a read-only probe over the real notes
(every link through backlinks, move/rename, Preview and the audit) before
trusting the audit again.

Run: `node tools/image-audit.mjs <repo-dir> [--out <file>]`. It reads the tree
and the notes from git HEAD, never the disk (PowerShell 5.1 mangles non-ASCII
file names, OneDrive locks files, Windows ignores case), and refuses a dirty or
outdated checkout (fetch, HEAD must equal upstream). Exit 0 valid, 2 invalid,
1 stopped. Deleting is not part of the tool: a reviewed list is removed in ONE
commit in the notes repository (Gillette `5f57fdf`, 83 pictures, 32 of them by
mistake - see the lesson above).
Not handled: duplicate groups where several copies are used (needs link
rewriting). An in-app panel is deliberately postponed: the audit is rarely
needed and Gillette is clean after `1aca810` (valid, 0 unused, 0 broken); usage
notes are in the header of `tools/image-audit.mjs`. Pinned by
`test/image-audit.test.js`.

## Architecture rules (each one closes a whole class of bugs)

These came out of real bugs. Before adding a feature, check it against every
rule; when a fixed bug reveals a new class, add a rule here.

1. **Writing several files = ONE commit.** Any operation that changes more than
   one path goes through `client.commitTreeChanges()` (see "Folder operations:
   ONE atomic commit"). Never a loop of Contents API PUT/DELETE: a failure
   halfway leaves the repository half-changed (folder rename/delete did, B3).
2. **A late response must not overwrite a newer one.** An async load that can be
   started from several places (`loadTree()` is called from ~15) must ignore a
   response to an older request that arrives after a newer one (B4). A new
   loader of shared state gets the same guard and a test with a fake client
   that answers out of order.
3. **One set of link rules.** Backlinks (`js/backlinks.js`), the reference
   rewriter (`js/reference-rewriter.js`), the image audit (`js/image-audit.js`)
   and link building (`buildFileLink`, `js/link-suggest.js`) must agree on what a
   link points at (see "Wiki links `[[...]]`" and "Link suggestions"). Markdown
   links are parsed in ONE place, `REF_TOKEN_RE` + `classifyRefMatch()`
   (`js/markdown-tokens.js`); no reader keeps its own link regex. A new link form
   is added to all of them in one change, with tests in each. A new WRITE format
   needs a test for every reader (backlinks, move/rename, audit): `f02e83f`
   started writing `[x](</a b.md>)` and nothing read it, so moves stopped
   updating those links and backlinks never saw them (fixed in `e803e0d`).
   Reading a link form that moves do not rewrite breaks notes silently (B1, B5).
   What is EXTERNAL is one rule too, `isExternalOrAnchor()` (`js/paths.js`: any
   URL scheme, `#anchor`, `data:`); backlinks once kept their own list of five
   schemes and indexed `onenote:` and `file:` links as notes (fixed in `56ac283`).
4. **Failures before code.** A task that touches GitHub or shared state states
   up front what happens on: an error halfway (network, rate limit, 409); two
   actions at once (Refresh, a second tab, a double click); ambiguous data (two
   files with the same name, an empty file, binary under `.md`); a large
   repository (1000+ files, a `truncated` tree). At least one test covers a
   failure, not only the happy path.
5. **A test must be able to fail.** One exact expected value; no
   `a === x || a === y` and no "anything but an error". A test written that way
   accepted the wrong wiki-link resolution unnoticed (B5). New tests are seen
   RED without the fix before they go GREEN.
6. **A fixed bug leaves a rule.** If the cause is a pattern that can repeat
   elsewhere, add it to this list, not only a test for the one case.
7. **A link target is decoded exactly once, by the consumer.** Notes hold
   targets as written: `a%20b.png`, `%D0%9A...` for Cyrillic (the reference
   rewriter writes them encoded itself, `encodeLinkPath`). The code that turns
   a target into a repo path decodes it once (`ImageResolver._repoPath()`,
   `js/reference-rewriter.js`); callers pass the target as written and never
   decode. A real tree path given to such a consumer is passed encoded
   (`encodeLinkPath`). Decoding in two places double-decodes a literal `%25`;
   decoding in none sends `%20` to the API encoded again (`%2520`, 404):
   Markdown preview showed no image with a space in its path (`dd5b585`).
8. **Anything computed from a note and stored is versioned.** The search record
   keeps data computed from note bodies (index fields, titles, backlink
   `links`). Changing the code that computes it (`extractTitle`,
   `stripMarkdown`, `js/md-fences.js`, `extractOutgoingLinks`) bumps
   `INDEX_VERSION` in the same change, or every browser keeps the old result
   until a manual rebuild. A new stored field is limited to the manifest, so it
   never outlives the files it came from (`8881736`).

9. **Confirm the sent snapshot, not just its path.** Draft cleanup after a
   successful remote write must not delete newer local text. Use ordered
   mutations and an atomic conditional cleanup, not a separate read then
   unconditional delete. Check the owning generation before the actual
   deletion, not only after awaiting cleanup. Commit uses returned blob SHAs
   to confirm snapshots and rebase remaining drafts (see below).

## General rule before considering a task done

Here CI broke twice in a row right after merge (first `npm ci`, then a stale
`#input-token` selector in the e2e test), even though the changes looked
insignificant relative to the main task. Before push:

1. `npm ci && npm test` — from scratch, without leftovers of the old `node_modules`.
2. If `index.html` / `js/app.js` / anything in login was changed — run
   `e2e_smoke_test.py` locally (`node serve.mjs &` then
   `python3 e2e_smoke_test.py`), not just relying on CI. On Windows, redirecting
   its output to a file (`python e2e_smoke_test.py > out.txt`) dies with
   `UnicodeEncodeError: 'charmap' codec can't encode '✓'` — the cp1250 console
   cannot hold the checkmarks. Set `$env:PYTHONIOENCODING='utf-8'` first.
3. If the deploy infrastructure was changed — first check which Cloudflare product
   actually serves the live domain, and only then write code for it.
4. Remember what the local checks *cannot* see: `e2e_smoke_test.py` mocks
   `api.github.com` and never performs real OAuth, so CORS/preflight and live
   GitHub behaviour are untested locally. If you touched `js/github-client.js`,
   make sure the new rule is covered by `npm test` instead of assuming the green
   e2e run proves anything about the real API.
5. Read the `# cancelled` line of `npm test`, not only `# fail`. A test body cut off
   mid-way (tail stranded at the end of the file) still passes `node --check`, and
   every test after the cut is reported as *cancelled*, which is easy to miss. The
   expected summary is `# fail 0` **and** `# cancelled 0`.
6. A test that cannot fail is worse than no test. Before trusting a new e2e or unit
   assertion, break the code it guards and watch it go red (e.g. put
   `position: fixed; left: -99999px` back on `#pdf-export-container`, drop the
   `clampImagesToPage()` call, set `IDLE_MS` to 0, remove the silent 409 retry).
   The 409 scenario once only printed a ✓ without asserting anything.
   In a task with a RED step, the red run comes from running the new test BEFORE
   the code change (see rule 14). `git stash push -- <files>` is only for checking
   an existing fix afterwards, and only when the task explicitly allows it
   (remember to `git stash pop`; an interrupted git can leave `.git/index.lock`
   behind — delete it before retrying).
7. When INSERTING a new test into an existing `test/*.test.js`, make sure the
   previous test's closing `});` really precedes it. An insert slipped one line
   too early nests the new test inside the previous test's callback — both then
   report as failed (the parent fails with its child), which reads like a second,
   unrelated regression. After editing test files, eyeball the `test(...)` /
   `});` pairing or run the file alone: `node --test test/<file>.test.js`.
8. Run `node --check <file>` after EVERY edit of a JS file, before running
   tests or reporting. If `npm test` shows the same `SyntaxError` for every
   test of one module (e.g. `Unexpected token 'function'` in all
   `test/editor.test.js` tests), the module does not parse — that is the
   first thing to check, not the tests. A module that does not parse also
   breaks the whole app in the browser (`app.js` cannot import it), which in
   `e2e_smoke_test.py` shows up as `#app-main` staying hidden. Never "fix"
   that by changing the e2e startup path.
9. Keep every file UTF-8 without BOM. On Windows, PowerShell `Set-Content`,
   `Out-File` and `>` re-encode files (cp1250), turning dashes, arrows,
   ellipses and quotes into mojibake. This silently broke user-visible
   messages and two tests once. Edit files with a tool that writes UTF-8, and
   before every commit run this ASCII-only check (it builds the mojibake
   patterns from char codes, so the command itself cannot get mangled):

   ```powershell
   $pats = @("$([char]0xE2)$([char]0x20AC)", "$([char]0xE2)$([char]0x2020)", "$([char]0xC3)")
   git -c core.quotepath=off ls-files --cached --others --exclude-standard |
     Where-Object { $_ -ne 'AGENTS.md' -and $_ -match '\.(js|mjs|ts|html|css|md|json|py|ps1|txt|toml|yml|yaml)$' } |
     ForEach-Object { Select-String -LiteralPath $_ -Pattern $pats -SimpleMatch -CaseSensitive -Encoding UTF8 } |
     ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
   ```

   It must print nothing. Also check `git diff` shows only the lines you
   meant to change — no line-ending or whitespace churn on untouched lines.
10. Leave no temporary files in the repo. Probe scripts, logs and diff
    dumps go to the OS temp folder and are deleted before reporting;
    `git status` must show only the intended changes.
11. A failing test after your change is caused by your change until proven
    otherwise. Compare the counts with the previous run (pass / fail /
    cancelled) — do not report failures as "pre-existing" without showing
    they failed before your change.
12. Reports must contain RAW command output, pasted verbatim (test summary
    numbers, git diff, git status, check results). Summaries such as
    "all passed" or "expected empty output" are rejected. If a command
    could not be run, say so and paste the error.
13. Never rewrite a whole file, and never "restore" one by writing it back.
    A rewrite silently changed a file's working-copy line endings
    (w/lf -> w/crlf) and was then reported as "just a git config notice".
    Check `git ls-files --eol <file>` before and after; report any change.
14. Follow the step order of the task. RED is produced by running the new tests
    BEFORE the code change, not by changing the code and then reverting it with
    `git checkout` or `git stash`. If the order cannot be followed: STOP and ask.

## History / Restore: ordinary scenario coverage

`2c8434a` adds guards, not a behaviour change. Ordinary module and browser
probes found no failure in the scenarios covered below:
- History lists the requested branch and shows the selected commit,
  filename and patch.
- Cancel on Restore makes no content request and changes no local work.
- Restore fetches the selected commit version and puts its exact text
  into the editor as local changes, with a dirty tab, Commit badge and
  recovery draft; no remote write is made.
- The pre-commit diff compares restored text with the current base blob.
- Restoring B while A is open leaves A unchanged. Switching B/A/B keeps
  restored text; after reload, Keep local recovers its draft.

Coverage: `test/history-restore.test.js` has three module guards; E2E
scenario K checks the other-file Restore, tab switches and reload in
Chromium with mocked GitHub. Baseline: 570/570 unit tests and full E2E
including J/K passed. Manual production verification of History/Restore
is not yet confirmed. This is not a claim that all error paths, empty
historical versions or concurrent actions have been tested.

## Draft confirmation: ordered mutations and atomic conditional cleanup

**Lesson: storage ordering fixed in `733f527`.** Read-only probes on the
pre-fix code (`35cf2dd`) showed two unsafe orders: a pending put could finish
after delete and resurrect a draft; a separate get/compare/delete could
delete newer text written between the read and the delete.

`DraftStore` now queues put/delete/deleteByKey/deleteIfText/rebase per full
`owner/repo@branch:path` key within ONE store instance. Other keys are
independent; a rejected operation does not poison the queue. This is not
cross-tab or cross-instance locking.

`deleteIfText(ref, expectedText, stillCurrent)` returns true only when
it deletes a matching record. Missing or different text returns false;
empty text is a valid match. The optional synchronous `stillCurrent`
callback must return exactly true; false or an exception prevents deletion.
It is checked after the queue wait and immediately before deletion in
the IndexedDB read callback or memory operation. IndexedDB reads, compares
and deletes in ONE readwrite transaction; abort returns false and preserves
the draft. Existing two-argument calls remain supported.

Tests: `test/draft-store.test.js` (seven tests seen RED before the fix),
`test/draft-confirmation-guards.test.js` (independent keys, queue recovery
and real transaction abort; guard tests). Baseline after `733f527`:
538/538 unit tests and the existing E2E smoke suite passed.

**Snapshot APIs added in `7396e21`.**
- `Autosave.confirmSnapshot({ path, text, sha })` adopts an already
  committed snapshot without a remote write or another `onRemoteCommit`
  callback. Matching active text becomes clean with timers cancelled;
  newer text remains dirty and is checkpointed on the committed SHA.
  Another path, destroy or a changed open/release generation invalidates
  confirmation; cleanup checks that generation before deletion.
- `TabsSession.confirmSnapshot({ path, text, sha })` is synchronous:
  it updates the blob SHA and clears only matching local text. Newer
  document text remains dirty in WorkingTree on the committed base.
  A closed file uses its WorkingTree entry without recreating a tab.
  Empty text is valid in both APIs.

**Lesson from the intermediate implementation.** Checking generation
only after awaiting deletion protected status but still deleted a draft
after destroy or same-path reopen. Two tests were observed RED on that
intermediate working copy, then GREEN with the permission callback.
They guard recovery data, not just the visible status.

Tests: `test/autosave-confirmation.test.js`,
`test/autosave-confirmation-generation.test.js`,
`test/tabs-confirmation.test.js`; transaction permission guards in
`test/draft-confirmation-current.test.js`. After `7396e21`:
552/552 unit tests, module integration probes and the existing E2E suite
passed. The E2E run verifies existing behaviour, not new Commit wiring.

**Commit UI integrated in `a7105e5`.** Probes on `35cf2dd` confirmed
two bugs: ordinary Commit left Autosave dirty and a checkpoint recreated
its deleted draft; typing during Commit lost the WorkingTree entry, dot
and recovery draft even though GitHub received only the earlier snapshot.

Commit now captures client, branch, session generation and text snapshots.
It validates every returned blob SHA before confirmation. A best-effort
tree refresh is overlaid with those SHAs, so that response cannot supply
old SHAs for the committed paths. Active Autosave and tab state confirm
the sent text; newer edits keep their dirty state and committed base.
Background/closed files use conditional draft cleanup followed by rebase.
A closed tab is not recreated. Duplicate Commit requests are ignored.

`DraftStore.rebase(ref, sha, stillCurrent)` updates only `baseSha` of
an existing record, preserving its text, dirty flag and savedAt. It uses
the per-key queue and ONE IndexedDB readwrite transaction (get then put).
Missing records, revoked permission and transaction failures return false.
It never creates a missing draft. The memory fallback has the same rule.
This avoids a get/put in Commit UI that could overwrite newer text.

Commit checks session generation/client/branch after async work and before
applying confirmation; draft operations also check permission at mutation.
Remote failure keeps local work and the message for a manual retry:
`Commit not confirmed: <reason>. Local changes kept; check History before retrying.`
A lost response does not prove the branch was unchanged.

**Deliberate limits:** existing single-file Save notifications are unchanged.
No global lock for Save/upload/move/delete, no automatic retry or ref
reconciliation after a lost response, and no detection/merge of external
file edits that were not loaded. GitHub ref updates remain `force: false`.
The per-instance draft queue is not cross-tab locking. Demo was not changed.

Tests: `test/commit-confirmation.test.js` (success, typing during request,
empty text, duplicate request, changed generation, background/closed files;
failure and closed matching file are guards), `test/draft-rebase.test.js`,
`test/commit-api-contract.test.js` (guard: exact blob SHAs and force false).
E2E scenario J uses a separate mocked repository and holds PATCH ref while
typing; it checks two exact snapshots in one commit, absent drafts after
idle/reload, a rebased newer draft and the next Commit of remaining changes.
E2E RED on old code was not run; RED was demonstrated by module tests.
Baseline: `a7105e5`, 567/567 unit tests, full E2E including J passed.
Manual production verification is not yet confirmed.

## Draft sweep: never delete a draft because its path is missing from the tree

`sweepStaleDrafts()` used to drop every draft whose path was not in the tree
returned by `getTree()`. That tree is not a reliable list of existing files:
right after a write GitHub can return the pre-write tree (a just-created file is
missing), and a large repository can come back `truncated`. `loadTree()` runs
after every save/create/upload/delete, so the sweep silently deleted drafts of
files that do exist - the crash-recovery copy was gone exactly when needed.

The sweep now drops ONLY drafts older than the 30-day TTL (`knownPaths` is
ignored). Deletes made in the editor remove their own drafts (`forgetPaths()` in
`js/file-ops.js`). A file deleted outside the editor keeps its draft until the
TTL; at worst a re-created file of the same name shows the draft banner, which
the user can discard. Do not reintroduce the "not in the tree" rule. Pinned by
`test/draft-store.test.js` ("drops only drafts older than the TTL", "an empty or
partial tree never deletes a fresh draft").

## Truncated tree: deliberately not handled (B2)

`getTree()` (`js/github-client.js`) ignores `truncated` in the recursive tree
response. GitHub cuts that response for very large repositories (roughly
100000 entries or 7 MB - check the current GitHub docs). With a cut tree the
file tree, search (it would drop unseen files from the index), backlinks and
link rewriting on move would all see only part of the repository; drafts are
already safe (see above). The target repository has about 1200 entries (~1% of
the limit), so this is not handled on purpose. Revisit when a repository grows
past ~50000 entries. Minimum fix then: expose `truncated` from `getTree()`,
warn in the UI, never remove files from the search index based on a truncated
tree, and warn that a move may not update every link.

## Never put unsanitized HTML into the main page

The main page keeps the GitHub token in sessionStorage. Any HTML string assigned
to innerHTML there runs with access to it: `<script>` does not execute via
innerHTML, but attributes such as `onerror=`, `ontoggle=`, `onclick=` do, and so
do `javascript:` links. marked does NOT sanitize.

- Markdown that reaches innerHTML goes through `renderMarkdownSafe()`
  (`js/sanitize-html.js`), never `markdownToCanonicalHtml()` directly.
- The PDF export of an .html file uses `sanitizeHtmlDocument()`: unlike the
  preview (sandboxed iframe, no allow-same-origin), PDF renders in the main page.
- Fail-closed: if DOMPurify did not load, rendering throws and the preview shows
  an error. Never fall back to raw HTML.
- DOMPurify is injected like `marked` (`deps.purifier`). Its version is pinned in
  three places that must agree: `index.html`, `package.json` (exact, no caret),
  `CDN_MOCKS` in `e2e_smoke_test.py`. Pinned by `test/sanitize-html.test.js`.
  