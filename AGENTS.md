# AGENTS.md

Short version: if you're about to touch deployment, login, tests or GitHub
API calls in this project — read this first. Everything below documents real
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
server code for a specific Cloudflare product, check where the
live domain is actually served from (Cloudflare dashboard, or just the URL shape:
`*.pages.dev` → Pages, `*.workers.dev`/custom domain without `.pages.dev` →
Workers). Here a Worker was first fully implemented (`worker/index.js` +
`wrangler.toml main`), and it simply never ran in prod because prod
lives on a different product.

## OAuth: how it works and what is deliberately missing

- Flow: `/auth/login` → redirect to `github.com/login/oauth/authorize` (with
  anti-CSRF `state` in an HttpOnly cookie) → GitHub login and 2FA on GitHub's side →
  `/auth/callback` exchanges `code` for `access_token` (Client Secret
  is used only here, on the server) → the token is handed to the client via
  `#gh_token=...` in the URL fragment — a fragment never reaches the server/logs —
  → `js/app.js` (`consumeOAuthRedirect()`) picks it up from `location.hash` and
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
  up after `/auth/callback` in that same `consumeOAuthRedirect()`. If you
  ever rework the login form — don't forget that this key pair must survive
  the full trip to github.com and back (same tab, sessionStorage
  persists).
- `readSession()` in `js/app.js` expects exactly four sessionStorage keys:
  `gh_token`, `gh_owner`, `gh_repo`, `gh_branch`. This is the same contract the
  e2e test uses (see below) — change one, sync the other.
- Redirect URI/callback in the GitHub OAuth App must match character-for-character:
  `https://md-edit.pages.dev/auth/callback`. In the new UI GitHub calls this field
  "Redirect URI", not "Authorization callback URL" — same thing.

## Environment variables — only via the Cloudflare Pages dashboard, not wrangler

`GITHUB_CLIENT_ID` (Type: **Text**) and `GITHUB_CLIENT_SECRET` (Type: **Secret**)
are set in Cloudflare dashboard → Workers & Pages → project → Settings →
Environment variables, separately for Production and Preview. **`wrangler secret
put` doesn't work here** — that's a command for Worker projects, not for Pages
Git deploys. Environment variable changes only take effect on the **next
build** — after saving, redeploy once more (empty push or "Retry
deployment" in the dashboard), otherwise the app will keep seeing the old/missing
values.

## Local development does NOT see /auth/*

`node serve.mjs` is a bare static file server, it executes nothing from
`/functions`. The "Sign in with GitHub" button on `localhost:8080` will hit a 404 or
an unstyled `index.html` fallback (that's exactly how it was first discovered — an unstyled
login screen at `/auth/login`, because CSS is linked via the relative path `./css/app.css`,
which breaks when the current URL isn't `/`). To actually run the OAuth flow
locally — serve via `npx wrangler pages dev .` (emulates both static assets and Pages
Functions), not `node serve.mjs`.

## package-lock.json — a silent npm ci trap

`npm install` locally may say "up to date" and change nothing, while `npm
ci` in GitHub Actions fails with `EUSAGE: Missing: ... from lock file`.
The cause found here: the lock file had incomplete "stub" entries for transitive
`"*"` dependencies (`@types/tern`, `typo-js` — pulled in via
easymde/codemirror-spell-checker) without `resolved`/`integrity`, and was
fully missing the `@types/estree` entry. `npm install --package-lock-only` doesn't
fix this if the local npm cache is already "satisfied" with the old state.

**Before any push that touches `package.json`, or just whenever in doubt** —
run `npm ci` itself locally, don't rely on CI to discover it first:

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
Playwright's `page.route`, so those requests never hit the real CORS machinery of
the browser — no preflight, no `Access-Control-Allow-Headers` check. The
`Cache-Control` header above passed the entire e2e suite locally and in CI and
only failed in production. That's the same class of blind spot as the OAuth one
below: anything enforced by the real network or by GitHub itself is untested
locally, so cover such rules with a plain unit test instead.

## e2e_smoke_test.py does not test the real OAuth

The test can't go through real GitHub OAuth — there are no live credentials in
CI, and even locally `node serve.mjs` doesn't serve `/functions`. So the test
immediately puts a fake token/owner/repo directly into `sessionStorage` (the same
four keys from `readSession()`, see above) and reloads the page — this
simulates the "already signed in" state, not the login process itself. `/auth/login` and
`/auth/callback` are not covered by this test at all. If you ever need to
really verify the OAuth round-trip itself — that's a separate scenario with `wrangler
pages dev` and a test GitHub OAuth App (or a mocked `github.com`); such
a thing doesn't exist here yet.

## PDF export: never position #pdf-export-container itself

This regressed twice, so the rule is worth writing down. html2canvas (inside
html2pdf.js) renders the element **where it actually sits**. As long as
`#pdf-export-container` had `position: fixed; left: -99999px` in `app.css`, the
document rendered outside the captured area and `html2pdf().from(container)` saved
a ~3 KB, one-empty-page PDF — no error, just a blank file. It was fixed once
(`d3f3017`, an off-screen transparent holder) and silently reverted by `acbf466`
when the positioning moved into CSS.

So: the container is a **neutral block** (width/background/padding only), and
`js/pdf-export.js` wraps it in a throwaway `position: fixed; opacity: 0;
z-index: -9999` holder that is removed in `finally`. Don't "simplify" the holder
back into a CSS rule on the container.

`e2e_smoke_test.py` guards it three ways: it records the container's computed
`position` while exporting (must be `static`), asserts the downloaded PDF is
larger than 50 KB (a blank export is ~3 KB, a real one is hundreds of KB), and
decodes every page and requires some non-white pixels on it. The size of a JPEG
stream proves nothing — a blank page compresses to a few KB too — so do not
replace the pixel check with a byte-length one.

**The html2pdf.js version is pinned in three places that must agree:** the CDN
URL in `index.html`, the devDependency in `package.json` (exact version, no
`^`), and `CDN_MOCKS` in `e2e_smoke_test.py`. The e2e test serves the library from
`node_modules` under the URL it mocks, so a mismatch means the PDF checks run
against a different release than production does.

## PDF export: images must never be split across pages

html2pdf's pagebreak plugin (see `pagebreaks.js` in the bundle) honours
`page-break-inside: avoid` on an element and inserts a padding div in front of
it so the element lands whole on the next page. **But** it only does that when
the element is at most one page tall — `nPages <= 1` — otherwise it leaves it to
be sliced.

That single condition is the whole trap. Clamping the `<img>` to the page
height is *not* enough: `.md-img-wrap` also has `margin: 12px auto` and a
border, so the wrapper ends up taller than the page, `nPages > 1`, and the image
gets cut anyway. `clampImagesToPage()` therefore measures the wrapper's margins
and border and shrinks the image to fit inside that budget.

`e2e_smoke_test.py` checks this for real, not by inspecting CSS: the test
document contains a solid **red** image taller than a page, positioned to
straddle a break. Every page of the exported PDF is a `DCTDecode` JPEG, so the
test decodes each one in the browser and counts red pixels. A split shows a
large red block on one page plus red starting at row 0 of the next. Verified to
fail when the fix is removed.

## Never assign a handler with a parameter straight to `onclick`

`els.btnNewFile.onclick = onCreateNewFile;` looks fine and is a classic
JS idiom — until the handler has a **path** parameter. The browser calls the
handler with the `MouseEvent`/`PointerEvent`, so `folderPath` became the event
object, the `= fileTree.getActiveFolder()` default never applied (defaults only
fire on `undefined`), and the app asked GitHub for
`contents/%5Bobject%20PointerEvent%5D/name.md`. The user saw the prompt say
`created in "[object PointerEvent]"`.

Only `onCreateNewFile` / `onCreateNewFolder` take an argument — every other
`onclick` assignment in `js/app.js` points at a zero-arg handler, which is why
only these two broke. Two rules follow from it:

1. Wrap such handlers in `() => fn()`.
2. Make the function itself defensive, and fall back to the **active folder**,
   not to the repo root: `toFolderPath(value)` returns `value` when it is a
   string, otherwise `fileTree.getActiveFolder()`. Returning `''` for an event
   would be "safe" (no `[object PointerEvent]` in the path) yet silently drop
   the user's intent — the file would land in the root while they were looking
   at a folder. Only an *explicit* empty string should mean the repo root.

`e2e_smoke_test.py` clicks both buttons, answers the prompt, and asserts the
resulting `/contents/...` request URL contains no `object`/`PointerEvent` **and**
points at the tree's active folder. That second assertion is what makes the
check meaningful: verified to fail if the file lands in the root instead.

## renameFolder: the file snapshot must track the moves it makes

`moveFile`/`moveToPath` only ever READ `allFiles` — they never update it. So a
loop that moves several files through the same snapshot (only `renameFolder`
does) is walking a list that goes stale under it. After the first move the
entries still name files under the **old** folder while the files themselves now
live under the new one.

`updateReferencesEverywhere()` scans that list, so on the second iteration it
asks for `Notes/a.md`, gets a 404, hits its `catch`, and skips the file — the
root-absolute links inside that already-moved file keep pointing at a folder
that no longer exists. Verified in `test/folder-manager.test.js`, which fails
without the fix: `Docs/a.md` kept `[b](/Notes/b.md)` instead of `[b](/Docs/b.md)`.

The failure is easy to miss because it only shows up for **root-absolute**
links (`/Notes/b.md`). Relative links between files of the same folder survive
on their own — they keep pointing at the same relative position once the whole
folder travels together — so a fixture built only from relative links passes
either way and proves nothing.

Keep a **private** copy (`allFiles.map((f) => ({ ...f }))`) and repoint the
entry after each move. Two reasons it must be a copy, not an in-place edit:

- the caller still owns `allFiles` and reuses it for the tree refresh afterwards;
- `filesInFolder` holds references to the same objects, so mutating them in
  place would corrupt the loop's own iteration source.

The `sha` is deliberately left stale there: `updateReferencesEverywhere()`
re-fetches it per file, and a clash sha is only read under `{ overwrite: true }`,
which a folder rename never passes.

## The active folder must be re-validated on every tree load

`FileTree.activeFolder` is the "create here" target, and it outlives the folder it
names. Deleting or renaming that folder reloads the tree, but `setFiles()` used
to only assign `files` and re-render — nothing noticed the stored path was gone.
The next `onCreateNewFile()` then PUT into it and silently resurrected a folder
the user had just deleted.

`setFiles()` now drops the target to the repository root when the folder is no
longer in the tree, and prunes `collapsedFolders` at the same time. Both come
from one `collectFolderPaths(files)` helper, because Git has no real folders —
they exist only as path prefixes, so the set of folder paths implied by the
file list *is* the definition of "which folders exist". One check therefore
covers `onDeleteFolder` *and* `onRenameFolder`, since both end in `loadTree()`.

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
would close the menu before anyone could pick from it. `closeMenu()` removes
both listeners instead of relying on `{ once: true }`, because a click inside
the menu must NOT consume the dismiss handler.

`e2e_smoke_test.py` asserts the menu really detaches on Escape and on an
outside click. It failed with the `setTimeout` version; 6/6 consecutive runs
pass with the synchronous one.

## b64ToUtf8 must keep `fatal: true`

`escape`/`unescape` are Annex B (deprecated since 1999); `github-client.js` now
uses `TextEncoder`/`TextDecoder`. The subtle part is the decoder's `fatal`
flag, and it is easy to remove by accident:

```js
new TextDecoder('utf-8', { fatal: true }).decode(bytes)
```

`moveToPath()` only rewrites the text of `.md` files, and it uses a thrown
error as the signal to leave the original bytes alone (see its `catch` in
`file-mover.js`). The **default** `TextDecoder` never throws — it substitutes
U+FFFD — so a binary blob sitting under a `.md` extension would be decoded into
replacement characters and PUT straight back to GitHub. `updateReferencesEverywhere()`
relies on the same throw.

`test/base64-utf8.test.js` pins both halves against `Buffer` as an independent
UTF-8 reference, and `test/file-mover.test.js` pins the end-to-end consequence:
verified to fail without `fatal`, with the mangled payload visible
(`'aO+/vWk='` instead of `'aIBp'`).

One deliberate behaviour change: `utf8ToB64` used to throw a `URIError` on a
lone surrogate (`encodeURIComponent` did); `TextEncoder` substitutes U+FFFD
instead. Strings arriving from a textarea are well-formed, so this should not
be reachable in practice.

## inlineImageMarks: the generation guard is what stops orphaned marks

A stale-mark leak here is easy to *claim* and hard to *believe*, so read
`renderInlineImages()` before changing it. What it draws in Source is a file
LINK (name + location) — the picture itself belongs to the Live/Preview panes
(`markdown-tokens.js`). The invariant is not the generation
guard on its own — it is the combination of three things:

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
`location.reload()` (app.js), which tears down the whole JS realm — observers and
all. There is no surviving editor after that. Don't "fix" logout by rebuilding
the UI in place; that would be the only way to create the leak.

The path that *did* build the app twice is `init()` racing itself:

```js
consumeOAuthRedirect();      // NOT awaited — finishLogin() awaits the network
const saved = readSession(); // runs while the token check is still in flight
if (saved) showApp(...);     // path A
```

`finishLogin()` calls `showApp()` itself. So when an OAuth callback landed on a
tab that still had a session (re-entering `/auth/login`, say), path A built the
app, the network call resolved, and `showApp()` ran a second time — two editors,
two observers, two paste handlers, with the first unreachable. `init()` is now
`async`, awaits `consumeOAuthRedirect()`, and returns early when it reports that
it completed the login.

Two caveats worth keeping in mind:

- `consumeOAuthRedirect()` returns `false` (so `init()` falls through to the
  normal session path) both when there is no `#gh_token` at all **and** when the
  `owner`/`repo` pair is missing. The second case used to leave the user on the
  login screen; now it also renders that message underneath the app when a stale
  session is present. Fixing that would mean deciding what "log in again" means,
  so it was left alone deliberately.
- `init()` is still invoked un-awaited at module top level, so with no hash the
  app now appears one microtask later than before. Nothing depends on it being
  synchronous (all callers are event handlers), but a `wait_for_selector`-style
  test would notice.

**`e2e_smoke_test.py` does not cover either of these paths.** It fakes a session
by writing the four `sessionStorage` keys and reloading — so it exercises the
`readSession()` branch with no hash, and can never reach `consumeOAuthRedirect()`,
`finishLogin()` or `showApp()`-twice. The `destroy()` contract is covered by
`test/editor.test.js` (verified to fail if the observer is not disconnected); the
`init()` race is **not** covered by any test, and per the OAuth notes above it
cannot be verified locally without `wrangler pages dev` and a test OAuth app.

## Search index — IndexedDB quirks and the no-Cache-Control rule (again)

Added for the client-side full-text search (MiniSearch + IndexedDB). The four
modules are `js/search-index.js` (pure logic), `js/search-store.js` (IndexedDB),
`js/search-sync.js` (orchestration), `js/search-ui.js` (DOM).

**No `Cache-Control` header, still.** The sync fetches hundreds of files in a
loop, which makes "just add `no-cache` to be sure" very tempting. Don't — see the
CORS safelist section above. `getTree()` busts GitHub's cache with a unique
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
token lives in `sessionStorage`; logout clears only the latter. Signing back into
the same repo reuses the index instead of refetching the repo. Do **not** add
"clear the index on logout". Records carry a 30-day TTL on `savedAt`, swept in
`open()`, so a repository deleted on GitHub does not linger forever.

**The body is never in the index.** `storeFields: ['path', 'title']` only —
serializing bodies would balloon the blob. Snippets come from a 200-entry LRU
cache of raw bodies, filled as the sync fetches them, with a lazy per-result
fetch for a cache miss. `buildSnippet()` HTML-escapes everything except its own
`<mark>`; a note body is untrusted and that string goes to `innerHTML`.

**`discard()`, not `remove()`.** MiniSearch's `remove()` demands the *full*
original document, which we cannot reconstruct because we do not store the body.
`discard(id)` is documented as having "the same visible effect", and MiniSearch's
own auto-vacuuming cleans up afterwards. Calling `remove()` with a rebuilt body
corrupts the index.

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

**Teardown**: `showApp()` destroys the in-flight sync alongside the editor
handle, for the same reason — a re-login must not leave the old indexer fetching
and writing into the new session's store.

**What local checks cannot see:** `e2e_smoke_test.py` mocks `api.github.com`,
so rate limits (403), IndexedDB quota and private-window behaviour are all
invisible to it — they are covered by `test/search-store.test.js` instead. The e2e
test seeds `sessionStorage` and reloads, so it is a cold start: never assert
that the index survives a reload there.

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
`autosave.hasUnsavedDraft()` for the browser “unsaved changes” prompt.

**`visibilitychange` → hidden** and **`flushCurrentFile()`** (tab switch / close)
checkpoint the **local draft only**. They must not call `_push`.

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

**Background failures** are still stored per-path so a failed Save after the user
switched files does not paint ⚠ on the newly opened file.

The e2e suite asserts: typing does not PUT; idle does not PUT; explicit Save
PUTs once; draft survives reload; 409 retry / Reload / Overwrite still work.
It never waits out a 5-minute max (CI flake) and never claims a cold-start
reload keeps an in-memory-only index.


## Tabs: who owns what, and the rules that keep them safe

**Split of responsibilities.** `js/tabs.js` is a pure model (ordered paths + the
active one + rename/delete bookkeeping + persistence); `js/tabs-ui.js` only draws
the strip and reports clicks; everything heavy lives in `js/app.js`, in
`tabDocs: Map<path, {doc, sha, unsaved, stale, commitSeen}>`. A path with no entry
is a restored tab that was never opened — it is fetched on first click, never at
page load.

**One CodeMirror `Doc` per tab, swapped with `swapDoc()`** (`editorHandle.createDoc`
/ `showDoc`). Do not load a tab's text with `easyMDE.value()`: that overwrites the
single shared document and throws away undo history, cursor and scroll. `swapDoc`
fires no `change` event, so switching tabs is not mistaken for typing, but inline
image marks belong to a document and are rebuilt by `showDoc()`. `setEditorValue()`
(which uses `.value()`) is still right for replacing the text of the CURRENT file
in place — "Reload from GitHub" in the conflict banner.

**Going around `value()` has a price: whatever EasyMDE hangs on `value()` no longer
happens.** The one that matters is the full **Preview** pane, which EasyMDE re-renders
only from `value()`; `showDoc()` re-renders it by hand (`renderActivePreview()`),
mirroring EasyMDE's own code. Without it the tab and file name change and Preview keeps
showing the first document. Side-by-side needs nothing (it re-renders on CodeMirror's
`update` event, which `swapDoc` fires) and cannot be combined with switching tabs anyway:
EasyMDE puts it in fullscreen, over the tab bar. Any new editor mode or EasyMDE upgrade
is a reason to re-run the Preview scenario in `e2e_smoke_test.py` (group G).

**When is the cached document trusted?** Only if the tab was clean when left
(`!unsaved`) and not `stale`. Autosave is a state machine for ONE file; a tab left
dirty is re-fetched on return, and the draft banner then offers the local text — the
same path as switching files has always taken, so there is a single code path for
"what is the truth after a background commit". `unsaved` is computed in `openFile()`
twice on purpose: once right after the first flush (so the commit overlaps the
fetch), and again after the fetch, because the old tab stays editable while the new
file loads and whatever was typed meanwhile must be flushed too. `commitSeen`
exists because the background commit can land BEFORE we decide `unsaved`; without it
the tab would stay marked unsaved forever.

**Never `destroy()` the Autosave to leave a file — use `release()`.** A destroyed
instance skips `_afterCommit`, so a push still in flight leaves its draft behind and
the file later shows a phantom "unsaved local changes" banner. `release()` drops the
path (typing is ignored, timers are gone) but lets the in-flight push clean up.
`closeCurrentFile({flush:false})` is for files that were just DELETED.

**`openFile(path)` on the file that is already open is a no-op** (it only focuses the
editor). Re-opening it would call `autosave.onOpen()` and reset the state machine under
the editor's unsaved text. Callers that really need a fresh copy — rename, move, links
rewritten by a move — pass `{reload: true}`; moving/renaming the open file MUST do so,
because it also rebinds autosave to the new path.

**`openSeq`** guards the slow-open race: every `openFile()` takes a number and gives up
after each `await` if a newer one started. Do not move assignments to `state.currentPath`
above those checks.

**Tabs are only dropped on purpose**: when the user closes one, or when a delete here
removes its file (`dropTabs`). They are NOT pruned against every `loadTree()` — a tree
that is momentarily behind a commit would close the editor under the user. The one
exception is the restore at page load, which discards paths that no longer exist.

**Not done on purpose (v1):** drag-to-reorder, keyboard shortcuts for next/previous tab
(Ctrl+Tab / Ctrl+W belong to the browser), a "reopen closed tab", pinned tabs, and
refreshing a clean cached tab when the file changed on GitHub meanwhile (a stale sha
surfaces as the usual 409 flow on the next commit).

## HTML Live/Preview — two panes, one funnel, null protocol, no srcdoc churn

Added after three stacked bugs (empty pane → alternating "renders / doesn't
render" → 2-3× flicker on every Live/Preview switch). Read this before touching
`previewRender`, `renderActivePreview` or `fillPreviewPane` in `js/editor.js` /
`js/app.js`.

**There are TWO preview nodes per container**: `.editor-preview-side` (the
visible Live/Preview pane) and `.editor-preview` (EasyMDE's full-preview pane,
still in the DOM). `renderActivePreview()` loops over BOTH in one tick. A
global `previewRenderToken` therefore made the SECOND pane's call cancel the
FIRST pane's deferred fill — which pane "wins" depended on call order
(EasyMDE's `update` vs our render), so the visible pane alternated between
filled and empty on Live/Preview switches. **State is per-pane now**:
`htmlPaneStates` WeakMap (`{token, chain, renderedText}`) inside
`renderHtmlPreview()` — the single funnel for all HTML rendering. `fillPreviewPane`
(app.js) must DELEGATE to `editorHandle.renderHtmlPreview()`, never build its
own iframe; panes are independent and must never block each other.

**`previewRender` returns `null` for HTML, never `''`.** EasyMDE has three
write sites (`sideBySideRenderingFunction`, `togglePreview`, the `value()`
setter), all guarded by `!= null` / `!== null` — `''` PASSES those guards and
wipes the pane. Our own callers mirror the same rule (`renderActivePreview`
and `fillPreviewPane` skip `null` too). The async fill owns the pane for the
whole HTML branch; nobody may `innerHTML = ''` it.

**Assigning `iframe.srcdoc` is a FULL iframe navigation — a visible flash.**
One Live/Preview click triggers a render up to THREE times (our `forceLayout`
runs on double-rAF + EasyMDE re-renders on CodeMirror `update` from
`cm.refresh()`), and each render used to assign srcdoc twice (raw, then
resolved) → up to 6 reloads per click (measured by the test: "iframe reloaded
6x"). Two guards, both required:

- `state.renderedText === plainText` → **early return**, untouched srcdoc.
  A layout switch does not change the text, so it must reload nothing.
- compare before assigning (`iframe.srcdoc !== raw` / `!== srcdoc`) — even an
  identical value reloads the frame.

`renderedText` is stamped only AFTER the resolved srcdoc lands and only when
the per-pane token is still current — a superseded pass must not claim the
pane. Markdown/code panes must keep using plain `innerHTML` (no reload = no
flicker) — routing them through the iframe path would reintroduce flashing.

Covered by `test/editor.test.js`: "HTML preview fills BOTH panes on every
render pass (no alternating starve)" and "Live/Preview switching with
unchanged text NEVER reloads the HTML iframe (flicker)" — both verified RED
without the fixes (starved first pane; `6 !== 0` reloads). The e2e HTML check
(`HTML Live preview renders page content`) only proves content exists once; it
cannot see alternation or flicker (timing), so the unit tests are the guard.

## Outline (heading map) — jump to the VISIBLE scroller

`js/doc-outline.js` is a pure parser (unit-tested in `test/doc-outline.test.js`):
ATX headings with up to 3 leading spaces, skips fenced ``` / ~~~ blocks and
indented code, does NOT strip the `#` of `C#`, skips bare `#`. Do not
re-derive it inline in `app.js` — the original inlined regex listed `#`
comments inside code blocks and mangled `C#`.

**A jump must scroll whichever pane is actually visible.** In Preview layout
CodeMirror is `display:none`, so `setCursor` / `scrollIntoView` / `focus()`
all silently do nothing on screen (that was the original "click highlights but
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

## General rule before considering a task done

Here CI broke twice in a row right after merge (first `npm ci`, then a
stale `#input-token` selector in the e2e test), even though the changes looked
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
   `git stash push -- <files>` is the quickest way to get the "before" state for
   a red run (remember to `git stash pop`; an interrupted git can leave
   `.git/index.lock` behind — delete it before retrying).
7. When INSERTING a new test into an existing `test/*.test.js`, make sure the
   previous test's closing `});` really precedes it. An insert slipped one line
   too early nests the new test inside the previous test's callback — both then
   report as failed (the parent fails with its child), which reads like a second,
   unrelated regression. After editing test files, eyeball the `test(...)` /
   `});` pairing or run the file alone: `node --test test/<file>.test.js`.
