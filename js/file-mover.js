// file-mover.js
// Оркестрація переміщення файлу між папками: читає/пише через GitHubClient,
// а саму логіку "що саме змінити в тексті" бере з reference-rewriter.js (чисті функції).

import { basenameOf, dirnameOf, extOf } from './paths.js';
import { utf8ToB64, b64ToUtf8 } from './github-client.js';
import { rewriteOwnRelativeLinks, updateReferencesInFile } from './reference-rewriter.js';

/**
 * Переміщує файл oldPath у теку targetFolder (може бути '' — корінь репозиторію).
 * Якщо переміщуваний файл — .md, спершу перераховує його ВЛАСНІ відносні посилання.
 * Потім скановує всі .md файли репозиторію (крім самого переміщеного) і виправляє
 * посилання, що вказували на oldPath.
 *
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles  поточний знімок дерева файлів
 * @param {string} oldPath
 * @param {string} targetFolder
 * @returns {Promise<{newPath: string, updatedFiles: string[], skipped: boolean}>}
 */
export async function moveFile(client, allFiles, oldPath, targetFolder) {
  const filename = basenameOf(oldPath);
  const newPath = targetFolder ? `${targetFolder}/${filename}` : filename;
  if (newPath === oldPath) return { newPath, updatedFiles: [], skipped: true };

  const { b64, sha } = await client.getFileB64(oldPath);
  let finalB64 = b64;

  if (extOf(oldPath) === 'md') {
    try {
      const text = b64ToUtf8(b64);
      const fixed = rewriteOwnRelativeLinks(text, dirnameOf(oldPath), dirnameOf(newPath));
      finalB64 = utf8ToB64(fixed);
    } catch (_) {
      // не текстовий/не-UTF8 вміст під розширенням .md — лишаємо байти як є
    }
  }

  await client.putFile(newPath, finalB64, `Move ${oldPath} to ${newPath}`);
  await client.deleteFile(oldPath, sha, `Remove ${oldPath} (moved to ${newPath})`);

  const updatedFiles = await updateReferencesEverywhere(client, allFiles, oldPath, newPath);

  return { newPath, updatedFiles, skipped: false };
}

/**
 * Проходить по всіх .md файлах (крім newPath — це вже сам переміщений файл) і виправляє
 * посилання, що фактично вказували на oldPath.
 * @returns {Promise<string[]>} шляхи файлів, які були змінені
 */
export async function updateReferencesEverywhere(client, allFiles, oldPath, newPath) {
  const updated = [];
  const mdFiles = allFiles.filter((f) => extOf(f.path) === 'md' && f.path !== newPath);

  for (const f of mdFiles) {
    try {
      const { b64, sha } = await client.getFileB64(f.path);
      const text = b64ToUtf8(b64);
      const { changed, text: newText } = updateReferencesInFile(text, dirnameOf(f.path), oldPath, newPath);
      if (!changed) continue;
      await client.putFile(f.path, utf8ToB64(newText), `Update links after moving ${oldPath} to ${newPath}`, sha);
      updated.push(f.path);
    } catch (e) {
      console.warn('Не вдалося оновити посилання у', f.path, e);
    }
  }
  return updated;
}
