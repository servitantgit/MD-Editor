// folder-manager.js
// Folder operations: create (via .gitkeep), rename, delete.
// Git has no folders without files — we work through file manipulations.

import { dirnameOf, basenameOf } from './paths.js';
import { utf8ToB64 } from './github-client.js';
import { moveFile } from './file-mover.js';

/**
 * Creates a folder by adding a .gitkeep file.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {string} folderPath  folder path (e.g. "docs/new-folder")
 * @returns {Promise<string>} path of the created .gitkeep
 */
export async function createFolder(client, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) throw new Error('Folder path cannot be empty');
  const gitkeepPath = `${cleanPath}/.gitkeep`;
  await client.putFile(gitkeepPath, utf8ToB64(''), `Create folder ${cleanPath}`);
  return gitkeepPath;
}

/**
 * Renames a folder: moves all files from oldFolderPath to newFolderPath.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} oldFolderPath
 * @param {string} newFolderPath
 * @returns {Promise<{moved: string[], updatedFiles: string[]}>}
 */
export async function renameFolder(client, allFiles, oldFolderPath, newFolderPath) {
  const oldClean = oldFolderPath.replace(/^\/+|\/+$/g, '');
  const newClean = newFolderPath.replace(/^\/+|\/+$/g, '');
  if (!oldClean || !newClean) throw new Error('Paths cannot be empty');
  if (oldClean === newClean) return { moved: [], updatedFiles: [] };

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(oldClean + '/'));
  if (!filesInFolder.length) throw new Error('Folder is empty or does not exist');

  // Detect collisions BEFORE moving anything: GitHub needs the sha of an existing file
  // to overwrite it, and failing halfway through would leave the rename half-done.
  for (const file of filesInFolder) {
    const newPath = `${newClean}/${file.path.slice(oldClean.length + 1)}`;
    if (allFiles.some((other) => other.path === newPath)) {
      throw new Error(`Folder "${newClean}" already contains "${basenameOf(file.path)}" — rename would overwrite it`);
    }
  }

  const moved = [];
  const allUpdated = [];

  // `moveFile` only READS allFiles, so the snapshot the caller handed us goes
  // stale after the very first move: its entries still name files under oldClean
  // that by then live under newClean. updateReferencesEverywhere() scans that
  // list, so on the second iteration it looks for "Notes/a.md", 404s, and skips
  // it — leaving root-absolute links in an already-moved file pointing at a
  // folder that no longer exists. Keep a private copy in step with the moves.
  //
  // Shallow copies on purpose: the caller still owns allFiles and may reuse it,
  // and filesInFolder below must keep yielding the original paths as we iterate.
  const snapshot = allFiles.map((f) => ({ ...f }));

  for (const file of filesInFolder) {
    const relPath = file.path.slice(oldClean.length + 1);
    const newPath = `${newClean}/${relPath}`;
    const result = await moveFile(client, snapshot, file.path, dirnameOf(newPath));
    const entry = snapshot.find((f) => f.path === file.path);
    if (entry) entry.path = newPath;
    // `sha` is deliberately left stale: updateReferencesEverywhere() re-fetches
    // it per file, and a clash sha is only read under { overwrite: true }, which
    // a folder rename never passes.
    moved.push(result.newPath);
    allUpdated.push(...result.updatedFiles);
  }

  return { moved, updatedFiles: [...new Set(allUpdated)] };
}

/**
 * Deletes a folder: removes all files in it.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} folderPath
 * @returns {Promise<string[]>} paths of the deleted files
 */
export async function deleteFolder(client, allFiles, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) throw new Error('Folder path cannot be empty');

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(cleanPath + '/'));
  if (!filesInFolder.length) throw new Error('Folder is empty or does not exist');

  const deleted = [];
  for (const file of filesInFolder) {
    await client.deleteFile(file.path, file.sha, `Delete ${file.path} (folder removal)`);
    deleted.push(file.path);
  }
  return deleted;
}

/**
 * Gets the folder list from the file tree.
 * @param {{path:string, sha:string}[]} allFiles
 * @returns {string[]} unique folder paths
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
 * Checks whether a folder is empty (no files except a possible .gitkeep).
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} folderPath
 * @returns {boolean}
 */
export function isFolderEmpty(allFiles, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  const filesInFolder = allFiles.filter((f) => f.path.startsWith(cleanPath + '/'));
  return filesInFolder.length === 0 || (filesInFolder.length === 1 && basenameOf(filesInFolder[0].path) === '.gitkeep');
}