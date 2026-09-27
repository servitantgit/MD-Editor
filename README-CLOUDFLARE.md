# Cloudflare deployment

The application files stay in the repository root so GitHub renders `README.md` normally and the editor is served from `/`.

`wrangler.toml` keeps the Workers Assets directory at the repository root, while `.assetsignore` excludes `node_modules`, `worker/` and development-only files from the deployed assets. `worker/index.js` is the Worker's own code (`main` in `wrangler.toml`) — it runs OAuth on `/auth/login` and `/auth/callback`, and serves everything else through `env.ASSETS`.

## One-time GitHub OAuth App setup

The editor logs in with "Sign in with GitHub" instead of a pasted Personal Access Token. This requires a GitHub OAuth App you register once:

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL**: your deployed URL (the domain `wrangler deploy` prints, or your custom domain if you've bound one — see note below).
3. **Authorization callback URL**: the same domain + `/auth/callback`, e.g. `https://md-editor.<your-subdomain>.workers.dev/auth/callback`. This must match **exactly**, including scheme and no trailing slash.
4. Generate a **Client Secret**.
5. Put the Client ID into `wrangler.toml` under `[vars] GITHUB_CLIENT_ID` (it's public — it's visible in the browser's authorize URL anyway).
6. Store the Client Secret **only** as a Worker secret, never in the repo:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

> **Domain note:** this project used to describe itself as deployed to `md-edit.pages.dev` (Cloudflare Pages), but `wrangler.toml` actually configures **Workers with static assets** (`[assets]` + `main`), deployed with `wrangler deploy`. That publishes to `<name>.<your-subdomain>.workers.dev` by default, not a `.pages.dev` URL, unless you've attached a custom domain in the Cloudflare dashboard. Check the URL `wrangler deploy` actually prints and use *that* domain (or your custom domain) as the callback URL above — a mismatch here is the single most common cause of GitHub OAuth failing with `redirect_uri_mismatch`.

Deploy from the repository root:

```bash
npx wrangler deploy
```

## Notes / not yet handled

- Access tokens from a standard GitHub OAuth App **don't expire** unless you explicitly enable "token expiration" for the app in GitHub's settings. This implementation does **not** implement refresh-token rotation — if you turn expiration on, users will simply need to sign in again after ~8h. Adding refresh-token support is a follow-up, not done here.
- This has not been tested end-to-end against a real GitHub OAuth App (that requires credentials only you can create). Test the full login round-trip after setup, and watch the Worker logs (`wrangler tail`) if `/auth/callback` errors.
