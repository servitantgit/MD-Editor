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

`e2e_smoke_test.py` guards it two ways: it records the container's computed
`position` while exporting (must be `static`) and asserts the downloaded PDF is
larger than 50 KB. A blank export is ~3 KB, a real one is hundreds of KB.

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
`renderInlineImages()` before changing it. The invariant is not the generation
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
dropped by `img.onerror`.

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

**Teardown**: `showApp()` destroys the in-flight sync alongside the editor
handle, for the same reason — a re-login must not leave the old indexer fetching
and writing into the new session's store.

**What local checks cannot see:** `e2e_smoke_test.py` mocks `api.github.com`,
so rate limits (403), IndexedDB quota and private-window behaviour are all
invisible to it — they are covered by `test/search-store.test.js` instead. The e2e
test seeds `sessionStorage` and reloads, so it is a cold start: never assert
that the index survives a reload there.

### Autosave — why `beforeunload` is a trap and `visibilitychange` is not, and why the 10s idle timer resets on onChange but the 5min max does not

Two independent layers, `js/draft-store.js` (IndexedDB, instant, crash recovery)
and `js/autosave.js` (GitHub, debounced, one commit per window). Read this before
touching either timer: collapsing them into one is the tempting mistake.

**The timers — three, never two:**

| Timer | Fires at | Restarted by | Why |
|---|---|---|---|
| local-write debounce | 400ms after the last keystroke | every `onChange` | writing IndexedDB per keystroke causes jank on long docs; 400ms ≈ "finished the current word" |
| remote idle | 10s after the last keystroke | every `onChange` | "idle" is defined as no keystrokes. Writing the DRAFT is not user activity, so it never restarts this |
| remote max | 5min after the file first became dirty | **nothing** | a user who types continuously for 5 minutes must still get a commit. If reset by `onChange` it would never fire |

The idle timer resets because a gap in typing is exactly what it measures. The max
timer does not, because it measures *time since the file became dirty*, not idleness.
Resetting it from `onChange` is the single most likely regression here — and it is
silent: everything still works for anyone who pauses while typing.

**`beforeunload` is a trap; `visibilitychange` is the right trigger.** You cannot
await a fetch inside `beforeunload` — modern browsers cancel the request as part of
teardown, so any "commit on close" written there looks fine and loses every write.
The 400ms draft write is what actually saves the user; `beforeunload` only earns the
browser's native "changes may not be saved" prompt (`app.js` checks
`autosave.hasUnsavedDraft()`, and nothing else — no network, ever, in that handler).

`visibilitychange` → hidden is where a checkpoint belongs: the tab is going away,
nothing is racing teardown, and `onVisibilityChange(true)` pushes a dirty draft
immediately instead of making the user wait out the 10s. This is how Google Docs
behaves. It only fires when `hasUnsavedDraft()`.

**The state machine** (pinned in `test/autosave.test.js` on `mock.timers`):

```
clean         --onChange-->               dirtyLocal   ● Unsaved
                                          (write draft after 400ms debounce,
                                           arm 10s idle timer,
                                           arm 5min max timer if not already)
dirtyLocal    --400ms draft write-->      dirtyIdle    ○ Draft saved locally
dirtyIdle     --onChange-->               dirtyLocal   (restart 10s idle)
dirtyLocal    --onChange-->               dirtyLocal   (restart 10s idle)
dirtyLocal    --10s idle elapsed-->       pushing
dirtyLocal    --5min max elapsed-->       pushing      (even if still typing)
dirtyLocal    --saveNow()-->              pushing      (immediate)
dirtyLocal    --flushCurrentFile()-->     pushing      (in background; new file loads)
pushing       --putFile resolves-->       clean        (clear draft, ✓ Saved, update baseSha)
pushing       --putFile rejects
               with 409 sha conflict-->   error        (⚠ reload / overwrite)
pushing       --putFile rejects other-->  dirtyLocal   (⚠ Save failed, retry on next idle)
error (409)   --user picks reload-->      clean        (load fresh, discard draft)
error (409)   --user picks overwrite-->   pushing      (putFile with the fresh sha)
```

The two rules that keep it honest: `saveNow()` cancels both timers and leaves them
cancelled (the next keystroke arms fresh ones), and `flushCurrentFile()` resolves
after the DRAFT write, never after the push — switching files must feel instant.

**Background failures are stored per-path.** A flush whose push fails after the user
moved on must not paint ⚠ on the file they just opened. `_push()` deliberately does
NOT bail out when `this.path` changes — the task snapshot (path/text/sha) is already
captured and still exactly what the user asked to commit, so dropping it there would
silently lose a commit — but only `_afterCommit`/`_afterFailure` touch the UI, and
both compare against `this.path`. The error is stored in `_backgroundErrors` and
surfaces only when that path is reopened (`onOpen` drains it).

**`destroy()` is the third "leaving" path.** `closeCurrentFile()` (i.e. deleting the
open file) calls `flushCurrentFile()` and then `destroy()`, because a live instance
would keep timers aimed at a file that no longer exists. **A destroyed `Autosave`
ignores everything**, so `openFile()` goes through `ensureAutosave()`, which rebuilds
it over the same `DraftStore` (`open()` is idempotent, the db handle is still open).
Log out destroys it too, but that is defence in depth only — `location.reload()`
already tears the whole realm down. Same shape as the editor handle: one owner, one
teardown, `showApp()` rebuilds.

**Programmatic `.value()` must be suppressed.** EasyMDE fires CodeMirror's `change`
*synchronously* from `.value()`, so opening a file would otherwise look exactly like
typing ("● Unsaved" on a file the user never touched, timers armed). `app.js` wraps
those loads in `setEditorValue()` with the `suppressEditorChange` flag, and the hook
installed by `createEditor` checks it. The inline-image render still runs first in
the same handler — autosave only *arms timers*, it never delays the preview.

**The status label is a separate element.** `#autosave-status` next to Save is owned
by autosave; `setSaveStatus()` is untouched and still handles moves/deletes/folder ops.
Do not merge them: `setSaveStatus()` auto-clears after 4s, which is right for a
one-off event and wrong for the live condition of the open file. Only
`✓ Saved to GitHub` fades (`STATUS.saved.fade`); `● Unsaved`,
`○ Draft saved locally` and `⟳ Saving to GitHub…` are persistent.

**The draft store is keyed `${owner}/${repo}@${branch}:${path}`** in its own database
`md-editor-drafts` — deliberately NOT `md-editor-search`. The search index is derived
from committed GitHub state and can be rebuilt; a draft is the only copy of work that
exists nowhere else. Two consequences: never index drafts (they would pollute search
with half-written text), and never sweep other repositories on login — the
`sweepStaleDrafts(knownPaths, now, scope)` call in `loadTree()` is scoped to the
current repo/branch for exactly that reason, with the same 30-day TTL as the search
sweep. Changing repos orphans the old drafts; the TTL reclaims them later. The
generic open/degrade/quota logic lives in `js/idb-backend.js`; `search-store.js` still
carries its own copy on purpose (the search modules were left read-only) — if those
two are ever unified, `test/search-store.test.js` must stay green unchanged.

**409 is routine, not an edge case.** With a 5-minute max timer, a user editing in
two tabs hits it constantly. The FIRST 409 is silently retried once with a freshly
read sha (copying `moveFile`'s one-shot pattern) because that is almost always "the
other tab committed first"; only a SECOND 409 in a row opens the reload/overwrite
banner. On the reload path, `b64ToUtf8` throwing on non-UTF-8 must be caught exactly
like `moveToPath()` does — leave the bytes alone, keep the draft, change nothing.

**What local checks cannot see:** `e2e_smoke_test.py` mocks `api.github.com`, so real
409s, sha drift and quota errors are invisible to it — they belong in
`test/autosave.test.js` / `test/draft-store.test.js`. The e2e covers what it *can*
see: typing does not commit, exactly one idle commit arrives with the right message,
and an explicit Save bypasses the timer. It never waits out the 5-minute max
(five real minutes in CI flakes constantly) and never claims a reload survives a
cold start.

## General rule before considering a task done

Here CI broke twice in a row right after merge (first `npm ci`, then a
stale `#input-token` selector in the e2e test), even though the changes looked
insignificant relative to the main task. Before push:

1. `npm ci && npm test` — from scratch, without leftovers of the old `node_modules`.
2. If `index.html` / `js/app.js` / anything in login was changed — run
   `e2e_smoke_test.py` locally (`node serve.mjs &` then
   `python3 e2e_smoke_test.py`), not just relying on CI.
3. If the deploy infrastructure was changed — first check which Cloudflare product
   actually serves the live domain, and only then write code for it.
4. Remember what the local checks *cannot* see: `e2e_smoke_test.py` mocks
   `api.github.com` and never performs real OAuth, so CORS/preflight and live
   GitHub behaviour are untested locally. If you touched `js/github-client.js`,
   make sure the new rule is covered by `npm test` instead of assuming the green
   e2e run proves anything about the real API.
