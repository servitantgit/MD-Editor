// image-resolver.js
// Turns a markdown path (relative or root-based) into a data: URL via the GitHub API,
// with caching. The single place where a "path in text" becomes "real bytes".

import { dirnameOf, resolveRelativePath, isExternalOrAnchor } from './paths.js';

export class ImageResolver {
  constructor(githubClient) {
    this.client = githubClient;
    this.cache = new Map(); // repo-path (without "/") -> data: URL
  }

  invalidate(path) {
    this.cache.delete(path);
  }

  /**
   * @param {string} origSrc  path as written in markdown (may be relative)
   * @param {string} currentFilePath  path of the .md file where this link was found
   * @returns {Promise<string>} data: URL or origSrc itself if it's an external link
   * @throws if the file could not be read — with the GitHub API reason
   */
  async resolve(origSrc, currentFilePath) {
    if (!origSrc) throw new Error('empty image path');
    if (isExternalOrAnchor(origSrc)) return origSrc; // http(s)/data:/onenote: etc. — as-is

    const path = origSrc.startsWith('/')
      ? origSrc.slice(1)
      : resolveRelativePath(dirnameOf(currentFilePath || ''), origSrc);

    if (this.cache.has(path)) return this.cache.get(path);
    const dataUrl = await this.client.getFileAsDataUrl(path);
    this.cache.set(path, dataUrl);
    return dataUrl;
  }
}
