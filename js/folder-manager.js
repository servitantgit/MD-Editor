// folder-manager.js
// Операції з папками: створення (через .gitkeep), перейменування, видалення.
// У Git папок не існує без файлів — працюємо через маніпуляцію файлами.

import { dirnameOf, basenameOf } from './paths.js';
import { utf8ToB64 } from './github-client.js';
import { moveFile } from './file-mover.js';

/**
 * Створює папку шляхом додавання .gitkeep файлу.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {string} folderPath  шлях папки (наприклад "docs/new-folder")
 * @returns {Promise<string>} шлях створеного .gitkeep
 */
export async function createFolder(client, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) throw new Error('Шлях папки не може бути порожнім');
  const gitkeepPath = `${cleanPath}/.gitkeep`;
  await client.putFile(gitkeepPath, utf8ToB64(''), `Create folder ${cleanPath}`);
  return gitkeepPath;
}

/**
 * Перейменовує папку: переміщує всі файли з oldFolderPath у newFolderPath.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} oldFolderPath
 * @param {string} newFolderPath
 * @returns {Promise<{moved: string[], updatedFiles: string[]}>}
 */
export async function renameFolder(client, allFiles, oldFolderPath, newFolderPath) {
  const oldClean = oldFolderPath.replace(/^\/+|\/+$/g, '');
  const newClean = newFolderPath.replace(/^\/+|\/+$/g, '');
  if (!oldClean || !newClean) throw new Error('Шляхи не можуть бути порожніми');
  if (oldClean === newClean) return { moved: [], updatedFiles: [] };

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(oldClean + '/'));
  if (!filesInFolder.length) throw new Error('Папка порожня або не існує');

  const moved = [];
  const allUpdated = [];

  for (const file of filesInFolder) {
    const relPath = file.path.slice(oldClean.length + 1);
    const newPath = `${newClean}/${relPath}`;
    const result = await moveFile(client, allFiles, file.path, dirnameOf(newPath));
    moved.push(result.newPath);
    allUpdated.push(...result.updatedFiles);
  }

  return { moved, updatedFiles: [...new Set(allUpdated)] };
}

/**
 * Видаляє папку: видаляє всі файли в ній.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} folderPath
 * @returns {Promise<string[]>} шляхи видалених файлів
 */
export async function deleteFolder(client, allFiles, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) throw new Error('Шлях папки не може бути порожнім');

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(cleanPath + '/'));
  if (!filesInFolder.length) throw new Error('Папка порожня або не існує');

  const deleted = [];
  for (const file of filesInFolder) {
    await client.deleteFile(file.path, file.sha, `Delete ${file.path} (folder removal)`);
    deleted.push(file.path);
  }
  return deleted;
}

/**
 * Отримує список папок з дерева файлів.
 * @param {{path:string, sha:string}[]} allFiles
 * @returns {string[]} унікальні шляхи папок
 */
export function getFolders(allFiles) {
  const folders = new Set();
  for (const file of allFiles) {
    let dir = dirnameOf(file.path);
    while (dir) {
      folders.add(dir);
      dir = dirnameOf(dir);
    }
  }
  return Array.from(folders).sort();
}

/**
 * Перевіряє, чи папка порожня (немає файлів, крім можливого .gitkeep).
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} folderPath
 * @returns {boolean}
 */
export function isFolderEmpty(allFiles, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  const filesInFolder = allFiles.filter((f) => f.path.startsWith(cleanPath + '/'));
  return filesInFolder.length === 0 || (filesInFolder.length === 1 && basenameOf(filesInFolder[0].path) === '.gitkeep');
}