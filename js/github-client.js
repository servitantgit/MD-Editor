// github-client.js
// Thin GitHub REST API client. No DOM logic, no UI state —
// only network calls. Easy to swap for a fetch mock in higher-level tests.

import { encodePathForApi, guessMime } from './paths.js';

export class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export class GitHubClient {
  constructor({ token, owner, repo }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });
    return res;
  }

  /** Checks the token/access and returns basic repository info (incl. default_branch). */
  async getRepoInfo() {
    const res = await this.request(`/repos/${this.owner}/${this.repo}`);
    if (!res.ok) throw await this._error(res, '');
    return res.json();
  }

  /** Full recursive file tree of the repository on the given branch. */
  async getTree(branch) {
    const ref = branch || 'HEAD';
    // GitHub caches GET responses (git/trees included), so right after a write the tree
    // can still be the pre-write one and a new folder/file only shows up after a reload.
    //
    // The bust is a query parameter, NOT a `Cache-Control: no-cache` header: that header
    // is not CORS-safelisted, so it turns the request into a preflight that GitHub rejects
    // ("Request header field cache-control is not allowed by Access-Control-Allow-Headers").
    // A unique URL is a different cache key and needs no preflight at all.
    const bust = `cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodePathForApi(ref)}?recursive=1&${bust}`
    );
    if (!res.ok) throw await this._error(res, '');
    const data = await res.json();
    return data.tree
      .filter((item) => item.type === 'blob')
      .map((item) => ({ path: item.path, sha: item.sha }));
  }

  /**
   * File contents as a base64 string (regardless of size — the Contents API is limited to 1MB,
   * so for large files we automatically fall back to the Git Blobs API).
   */
  async getFileB64(path) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePathForApi(path)}`);
    if (!res.ok) throw await this._error(res, path);
    const data = await res.json();
    let b64 = data.content;
    if (!b64 && data.sha) {
      const blobRes = await this.request(`/repos/${this.owner}/${this.repo}/git/blobs/${data.sha}`);
      if (blobRes.ok) {
        const blobData = await blobRes.json();
        b64 = blobData.content;
      }
    }
    if (!b64) throw new GitHubApiError(`Empty contents or file too large (${path})`, res.status);
    return { b64: b64.replace(/\n/g, ''), sha: data.sha };
  }

  async getFileAsDataUrl(path) {
    const { b64 } = await this.getFileB64(path);
    return `data:${guessMime(path)};base64,${b64}`;
  }

  async putFile(path, contentB64, message, sha) {
    const body = { message, content: contentB64 };
    if (sha) body.sha = sha;
    const res = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePathForApi(path)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this._error(res, path);
    return res.json();
  }

  async deleteFile(path, sha, message) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePathForApi(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha }),
    });
    if (!res.ok) throw await this._error(res, path);
    return res.json();
  }

  async _error(res, path) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.message) msg = j.message;
    } catch (_) { /* body is not JSON — keep the status code */ }
    return new GitHubApiError(path ? `${msg} (${path})` : msg, res.status);
  }
}

/** utf-8 text -> base64, correct for Cyrillic/emoji (unlike bare btoa). */
export function utf8ToB64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

/** base64 -> utf-8 text. */
export function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}
