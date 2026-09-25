// image-resolver.js
// Перетворює шлях із markdown (відносний або кореневий) на data: URL через GitHub API,
// з кешуванням. Єдине місце, де "шлях у тексті" стає "реальними байтами".

import { dirnameOf, resolveRelativePath, isExternalOrAnchor } from './paths.js';

export class ImageResolver {
  constructor(githubClient) {
    this.client = githubClient;
    this.cache = new Map(); // repo-path (без "/") -> data: URL
  }

  invalidate(path) {
    this.cache.delete(path);
  }

  /**
   * @param {string} origSrc  шлях так, як він написаний у markdown (може бути відносним)
   * @param {string} currentFilePath  шлях .md файлу, у якому це посилання зустрілось
   * @returns {Promise<string>} data: URL або сам origSrc, якщо це зовнішнє посилання
   * @throws якщо файл не вдалося прочитати — з причиною від GitHub API
   */
  async resolve(origSrc, currentFilePath) {
    if (!origSrc) throw new Error('порожній шлях до зображення');
    if (isExternalOrAnchor(origSrc)) return origSrc; // http(s)/data:/onenote: тощо — як є

    const path = origSrc.startsWith('/')
      ? origSrc.slice(1)
      : resolveRelativePath(dirnameOf(currentFilePath || ''), origSrc);

    if (this.cache.has(path)) return this.cache.get(path);
    const dataUrl = await this.client.getFileAsDataUrl(path);
    this.cache.set(path, dataUrl);
    return dataUrl;
  }
}
