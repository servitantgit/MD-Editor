// github-client.js
// Тонкий клієнт GitHub REST API. Жодної DOM-логіки, жодного стану інтерфейсу —
// тільки мережеві виклики. Легко підмінити на fetch-мок у тестах вищого рівня.

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

  /** Перевіряє токен/доступ і повертає базову інформацію про репозиторій (у т.ч. default_branch). */
  async getRepoInfo() {
    const res = await this.request(`/repos/${this.owner}/${this.repo}`);
    if (!res.ok) throw await this._error(res, '');
    return res.json();
  }

  /** Повне рекурсивне дерево файлів репозиторію на вказаній гілці. */
  async getTree(branch) {
    const ref = branch || 'HEAD';
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodePathForApi(ref)}?recursive=1`
    );
    if (!res.ok) throw await this._error(res, '');
    const data = await res.json();
    return data.tree
      .filter((item) => item.type === 'blob')
      .map((item) => ({ path: item.path, sha: item.sha }));
  }

  /**
   * Вміст файлу як base64-рядок (незалежно від розміру — Contents API обмежений 1MB,
   * тому для великих файлів автоматично падаємо на Git Blobs API).
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
    if (!b64) throw new GitHubApiError(`Порожній вміст або файл завеликий (${path})`, res.status);
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
    } catch (_) { /* тіло не JSON — лишаємо статус-код */ }
    return new GitHubApiError(path ? `${msg} (${path})` : msg, res.status);
  }
}

/** utf-8 текст -> base64, коректно для кирилиці/емодзі (на відміну від голого btoa). */
export function utf8ToB64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

/** base64 -> utf-8 текст. */
export function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}
