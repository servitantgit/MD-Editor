// image-resolver.js
// Turns a markdown path (relative or root-based) into a data: URL via the GitHub API,
// with caching. The single place where a "path in text" becomes "real bytes".
//
// Also rewrites GitHub-flavoured *virtual* image paths that are not real blobs:
//   ../../actions/workflows/ci.yml/badge.svg  →  https://github.com/{owner}/{repo}/actions/...

import { dirnameOf, resolveRelativePath, isExternalOrAnchor } from './paths.js';

/** Match repo-relative Actions status badge paths (GitHub README convention). */
const ACTIONS_BADGE_RE = /^actions\/workflows\/([^/]+\.(?:yml|yaml))\/badge\.svg$/i;

/**
 * Map a resolved repo path to a public GitHub URL when it is not a git blob.
 * Used by tests and resolve().
 * @param {string} path repo-rooted path without leading slash
 * @param {string} owner
 * @param {string} repo
 * @returns {string|null}
 */
export function actionsBadgePublicUrl(path, owner, repo) {
  if (!path || !owner || !repo) return null;
  const m = String(path).replace(/^\/+/, '').match(ACTIONS_BADGE_RE);
  if (!m) return null;
  return `https://github.com/${owner}/${repo}/actions/workflows/${m[1]}/badge.svg`;
}

export class ImageResolver {
  constructor(githubClient) {
    this.client = githubClient;
    this.cache = new Map(); // path -> data: or https URL
  }

  invalidate(path) {
    this.cache.delete(path);
  }

  /**
   * @param {string} origSrc  path as written in markdown (may be relative)
   * @param {string} currentFilePath  path of the .md file where this link was found
   * @returns {Promise<string>} data: URL, or https URL for external / virtual badges
   * @throws if the file could not be read — with the GitHub API reason
   */
  async resolve(origSrc, currentFilePath) {
    if (!origSrc) throw new Error('empty image path');
    if (isExternalOrAnchor(origSrc)) return origSrc;
    // Protocol-relative CDN URLs
    if (origSrc.startsWith('//')) return 'https:' + origSrc;

    const path = origSrc.startsWith('/')
      ? origSrc.slice(1)
      : resolveRelativePath(dirnameOf(currentFilePath || ''), origSrc);

    if (this.cache.has(path)) return this.cache.get(path);

    const owner = this.client && this.client.owner;
    const repo = this.client && this.client.repo;
    const virtual = actionsBadgePublicUrl(path, owner, repo);
    if (virtual) {
      this.cache.set(path, virtual);
      return virtual;
    }

    const dataUrl = await this.client.getFileAsDataUrl(path);
    this.cache.set(path, dataUrl);
    return dataUrl;
  }
}
