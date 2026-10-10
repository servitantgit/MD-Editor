// demo-client.js
// In-memory GitHubClient stand-in for "Try demo" on the landing page.
// No network. Git-only features (real History from GitHub, OAuth, private repos)
// are unavailable — the UI shows a demo banner and disabled controls.

import { utf8ToB64, b64ToUtf8 } from './github-client.js';

function shaOf(text) {
  // Stable-enough pseudo-sha for demo (not cryptographic).
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'demo' + (h >>> 0).toString(16).padStart(8, '0');
}

const SEED = {
  'Welcome.md': `# Welcome to the demo

This is a **local sandbox**. Nothing is sent to GitHub.

- Edit freely — drafts stay in this browser tab
- Try **Source / Live / Preview**
- Open other files from the tree and switch **tabs**
- **Save** writes into the in-memory demo store (not GitHub)

> Sign in with GitHub on the landing page to use your real repository.

## Sample checklist

- [x] Open the demo
- [ ] Toggle Live preview
- [ ] Open \`Notes/Getting started.md\`
- [ ] Try Find, Outline, Map
`,
  'Notes/Getting started.md': `# Getting started (demo)

## Layouts

| Mode | What you see |
|------|----------------|
| **Source** | Editor only |
| **Live** | Editor + preview |
| **Preview** | Preview full width |

## Local vs GitHub

In demo mode:

- Tree, tabs, editor, preview, search index (in-memory), outline, minimap work
- **Commit / History / real GitHub push** are disabled — use Sign in for those

\`\`\`js
// Sample code fence
function hello(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`
`,
  'Notes/Sample note.md': `# Sample note

Link to [[Welcome]] or [Getting started](./Getting%20started.md).

An image from the demo store:

![Demo diagram](../assets/demo-note.svg)

Type below this line:

`,
  'assets/demo-note.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80">
  <rect width="320" height="80" rx="8" fill="#21262d"/>
  <text x="160" y="48" text-anchor="middle" fill="#58a6ff" font-family="sans-serif" font-size="18">Demo image</text>
</svg>`,
  'examples/hello.js': `// Demo JavaScript file — try Source mode + language badge
export function greet(name = 'world') {
  return \`Hello, \${name}\`;
}

console.log(greet('MD Editor'));
`,
  'examples/page.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Demo page</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6edf3; padding: 2rem; }
    h1 { color: #58a6ff; }
  </style>
</head>
<body>
  <h1>Demo HTML</h1>
  <p>Open this file and switch to <strong>Live</strong> or <strong>Preview</strong>.</p>
</body>
</html>
`,
};

export class DemoClient {
  constructor() {
    this.owner = 'demo';
    this.repo = 'sandbox';
    this.token = 'demo';
    /** @type {Map<string, { text: string, sha: string }>} */
    this._files = new Map();
    for (const [path, text] of Object.entries(SEED)) {
      this._files.set(path, { text, sha: shaOf(text) });
    }
    this._commits = [];
  }

  async getRepoInfo() {
    return {
      name: this.repo,
      full_name: `${this.owner}/${this.repo}`,
      default_branch: 'main',
      private: false,
      description: 'Local demo sandbox (not a real GitHub repository)',
    };
  }

  async getTree(_branch) {
    return [...this._files.keys()]
      .sort()
      .map((path) => ({
        path,
        type: 'blob',
        sha: this._files.get(path).sha,
        mode: '100644',
      }));
  }

  async getFileB64(path) {
    const f = this._files.get(path);
    if (!f) {
      const err = new Error(`Not Found (${path})`);
      err.status = 404;
      throw err;
    }
    return { b64: utf8ToB64(f.text), sha: f.sha };
  }

  async getFileAsDataUrl(path) {
    const { b64 } = await this.getFileB64(path);
    const mime = path.endsWith('.svg')
      ? 'image/svg+xml'
      : path.endsWith('.png')
        ? 'image/png'
        : 'application/octet-stream';
    return `data:${mime};base64,${b64}`;
  }

  async putFile(path, contentB64, message, sha) {
    const existing = this._files.get(path);
    if (sha && existing && existing.sha !== sha) {
      const err = new Error('Conflict (demo sha mismatch)');
      err.status = 409;
      throw err;
    }
    const text = b64ToUtf8(contentB64);
    const newSha = shaOf(text + '|' + Date.now());
    this._files.set(path, { text, sha: newSha });
    this._commits.unshift({
      sha: newSha,
      commit: {
        message: message || `Update ${path}`,
        author: { name: 'Demo', date: new Date().toISOString() },
      },
      path,
    });
    return { content: { sha: newSha, path }, commit: { sha: newSha, message } };
  }

  async deleteFile(path, sha, _message) {
    const existing = this._files.get(path);
    if (!existing) {
      const err = new Error(`Not Found (${path})`);
      err.status = 404;
      throw err;
    }
    if (sha && existing.sha !== sha) {
      const err = new Error('Conflict');
      err.status = 409;
      throw err;
    }
    this._files.delete(path);
    return { commit: { sha: shaOf('del' + path) } };
  }

  async getBlobB64(sha) {
    for (const f of this._files.values()) {
      if (f.sha === sha) return { b64: utf8ToB64(f.text), sha, encoding: 'base64' };
    }
    for (const c of this._commits) {
      if (c.sha === sha && c.path && this._files.has(c.path)) {
        const f = this._files.get(c.path);
        return { b64: utf8ToB64(f.text), sha, encoding: 'base64' };
      }
    }
    const err = new Error(`Blob not found (${sha})`);
    err.status = 404;
    throw err;
  }

  async commitFiles(branch, message, files) {
    for (const f of files) {
      if (f.contentB64 === null) this._files.delete(f.path);
      else await this.putFile(f.path, f.contentB64, message, null);
    }
    const sha = shaOf(message + Date.now());
    this._commits.unshift({
      sha,
      commit: {
        message,
        author: { name: 'Demo', date: new Date().toISOString() },
      },
    });
    return { sha, branch };
  }

  async listCommits({ path, perPage = 30 } = {}) {
    let list = this._commits;
    if (path) list = list.filter((c) => !c.path || c.path === path);
    return list.slice(0, perPage).map((c) => ({
      sha: c.sha,
      commit: c.commit,
      html_url: '#demo',
    }));
  }

  async getCommitDetail(sha) {
    const c = this._commits.find((x) => x.sha === sha);
    if (!c) {
      const err = new Error('Commit not found');
      err.status = 404;
      throw err;
    }
    return {
      sha: c.sha,
      commit: c.commit,
      files: c.path
        ? [{ filename: c.path, status: 'modified', patch: '' }]
        : [],
    };
  }

  async getAuthenticatedUser() {
    return { login: 'demo', name: 'Demo User', avatar_url: '' };
  }

  async listUserRepos() {
    return [{
      full_name: 'demo/sandbox',
      name: 'sandbox',
      owner: { login: 'demo' },
      private: false,
      description: 'Local demo only',
    }];
  }
}

export function isDemoSession() {
  try {
    return sessionStorage.getItem('gh_demo') === '1';
  } catch (_) {
    return false;
  }
}
