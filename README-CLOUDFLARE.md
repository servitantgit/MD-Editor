# Cloudflare deployment

The application files stay in the repository root so GitHub renders `README.md` normally and the editor is served from `/`.

**This project deploys as a Cloudflare Pages project with Git integration** (auto-build on push to `main`/`master`), live at `md-edit.pages.dev`. `wrangler.toml` in this repo is a leftover from an earlier Workers-based setup and is **not used** by the current Git-integration deploy — Pages configures the build purely from its own dashboard project settings. Ignore it unless you deliberately switch to deploying with the `wrangler pages deploy` CLI.

## GitHub OAuth via Pages Functions

The editor logs in with "Sign in with GitHub" instead of a pasted Personal Access Token. This runs as two **Cloudflare Pages Functions** — plain files under `/functions` that Pages wires up into routes automatically on every Git deploy, no extra config needed:

- `functions/auth/login.js` → route `GET /auth/login` — redirects to GitHub's authorize page
- `functions/auth/callback.js` → route `GET /auth/callback` — exchanges the OAuth `code` for an access token and hands it to the browser

### One-time setup

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL**: `https://md-edit.pages.dev`
3. **Redirect URI** (GitHub's newer UI calls the old "Authorization callback URL" this): `https://md-edit.pages.dev/auth/callback` — must match exactly.
4. Decide about **"Expire user access tokens"**: leave it **unchecked** for now — this implementation does not do refresh-token rotation, so a checked box means users get logged out every ~8h with no automatic renewal. Check it only once refresh-token support is added.
5. Register, then copy the **Client ID**.
6. Generate a **Client Secret** and copy it (shown once).
7. In the Cloudflare dashboard: **Workers & Pages → md-edit (your Pages project) → Settings → Environment variables**. Add, for the **Production** environment (and Preview too, if you use preview deploys):
   - `GITHUB_CLIENT_ID` — plain text, the Client ID from step 5
   - `GITHUB_CLIENT_SECRET` — mark it **Encrypt** (Cloudflare's equivalent of a Worker secret for Pages)
8. Push/redeploy so the new environment variables take effect (Pages only picks up env var changes on the next build+deploy).

### Not yet handled

- No refresh-token flow — see point 4 above. Adding it means handling a second POST to the same GitHub token endpoint with `grant_type=refresh_token`, and passing the refresh token to the client the same way the access token is passed now.
- Not tested end-to-end against a real GitHub OAuth App (needs credentials only you can create). Test the full login round-trip after setup. Cloudflare's dashboard has a "Functions" log/real-time log viewer under the Pages project if `/auth/callback` errors.
