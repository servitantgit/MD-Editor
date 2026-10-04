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
