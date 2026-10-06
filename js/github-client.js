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

  // ===== Git Data API: multi-file commits + history =====

  /** Current commit SHA for a branch ref. */
  async getRefSha(branch) {
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodePathForApi(branch)}`
    );
    if (!res.ok) throw await this._error(res, branch);
    const data = await res.json();
    return data.object.sha;
  }

  async getCommit(sha) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/git/commits/${sha}`);
    if (!res.ok) throw await this._error(res, sha);
    return res.json();
  }

  /** Raw blob by SHA (for history restore / diffs against base). */
  async getBlobB64(sha) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    if (!res.ok) throw await this._error(res, sha);
    const data = await res.json();
    if (!data.content) throw new GitHubApiError(`Empty blob (${sha})`, res.status);
    return { b64: String(data.content).replace(/\n/g, ''), sha: data.sha, encoding: data.encoding };
  }

  async createBlob(contentB64) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: contentB64, encoding: 'base64' }),
    });
    if (!res.ok) throw await this._error(res, 'blob');
    return res.json(); // { sha, url }
  }

  /**
   * Create a tree from base tree + path changes.
   * @param {string} baseTreeSha
   * @param {Array<{path: string, mode?: string, type?: string, sha: string|null}>} changes
   *   sha=null means delete the path
   */
  async createTree(baseTreeSha, changes) {
    const tree = changes.map((c) => {
      if (c.sha === null) {
        return { path: c.path, mode: '100644', type: 'blob', sha: null };
      }
      return {
        path: c.path,
        mode: c.mode || '100644',
        type: c.type || 'blob',
        sha: c.sha,
      };
    });
    const res = await this.request(`/repos/${this.owner}/${this.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    });
    if (!res.ok) throw await this._error(res, 'tree');
    return res.json();
  }

  async createCommitObject({ message, treeSha, parentSha }) {
    const body = {
      message,
      tree: treeSha,
      parents: parentSha ? [parentSha] : [],
    };
    const res = await this.request(`/repos/${this.owner}/${this.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this._error(res, 'commit');
    return res.json();
  }

  async updateRef(branch, sha, force = false) {
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${encodePathForApi(branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha, force }),
      }
    );
    if (!res.ok) throw await this._error(res, branch);
    return res.json();
  }

  /**
   * Multi-file commit in one Git commit.
   * @param {string} branch
   * @param {string} message
   * @param {Array<{path: string, contentB64: string|null}>} files
   *   contentB64=null deletes the path
   */
  async commitFiles(branch, message, files) {
    const parentSha = await this.getRefSha(branch);
    const parentCommit = await this.getCommit(parentSha);
    const baseTreeSha = parentCommit.tree.sha;

    const changes = [];
    for (const f of files) {
      if (f.contentB64 === null) {
        changes.push({ path: f.path, sha: null });
      } else {
        const blob = await this.createBlob(f.contentB64);
        changes.push({ path: f.path, sha: blob.sha });
      }
    }

    const tree = await this.createTree(baseTreeSha, changes);
    const commit = await this.createCommitObject({
      message,
      treeSha: tree.sha,
      parentSha,
    });
    await this.updateRef(branch, commit.sha);
    return { commit, files: changes };
  }

  /** Recent commits on a branch (optionally filtered by path). */
  async listCommits({ branch, path, perPage = 30 } = {}) {
    const q = new URLSearchParams();
    if (branch) q.set('sha', branch);
    if (path) q.set('path', path);
    q.set('per_page', String(perPage));
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/commits?${q}`
    );
    if (!res.ok) throw await this._error(res, 'commits');
    return res.json();
  }

  /** Full commit detail including files + patch. */
  async getCommitDetail(sha) {
    const res = await this.request(`/repos/${this.owner}/${this.repo}/commits/${sha}`);
    if (!res.ok) throw await this._error(res, sha);
    return res.json();
  }
}

/** utf-8 text -> base64, correct for Cyrillic/emoji (unlike bare btoa). */
export function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  // Build the binary string in chunks: String.fromCharCode(...bytes) blows the
  // argument limit on a large document (and markdown files are not small).
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * base64 -> utf-8 text.
 *
 * `fatal: true` is load-bearing, do not "fix" it away: callers rely on this
 * THROWING when the content is not valid UTF-8 (a binary blob that happens to
 * sit under a .md extension, say) so they can leave the original bytes alone.
 * The default TextDecoder would instead substitute U+FFFD silently, and
 * moveToPath() would then PUT that mangled text back — real corruption in the
 * repository, not a cosmetic glitch.
 */
export function b64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
