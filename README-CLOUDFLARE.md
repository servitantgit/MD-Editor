# Cloudflare deployment

Wrangler must use `md-editor-v2` as the Workers static-assets directory.
Do not deploy the repository root as the assets directory, because the build
may create `node_modules/`, including `node_modules/workerd/bin/workerd`.

The included `wrangler.toml` sets:

[assets]
directory = "./md-editor-v2"

Deploy from the repository root with `npx wrangler deploy`.
