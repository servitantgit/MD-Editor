# Cloudflare deployment

The application files stay in the repository root so GitHub renders `README.md` normally and the editor is served from `/`.

`wrangler.toml` keeps the Workers Assets directory at the repository root, while `.assetsignore` excludes `node_modules` and development-only files from the deployed assets.

Deploy from the repository root:

```bash
npx wrangler deploy
```
