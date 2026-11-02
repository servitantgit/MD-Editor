// folder-manager.js
// Folder operations: create (via .gitkeep), rename, delete.
// Git has no folders without files — we work through file manipulations.

import { dirnameOf, basenameOf, extOf } from './paths.js';
import { utf8ToB64, b64ToUtf8 } from './github-client.js';
import { updateReferencesInFile, rewriteOwnRelativeLinks } from './reference-rewriter.js';

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
 * @returns {Promise<{moved: string[], updatedFiles: string[], failedFiles: string[]}>}
 */
export async function renameFolder(client, allFiles, oldFolderPath, newFolderPath, options = {}) {
  // ONE atomic commit (client.commitTreeChanges): every file move and every link
  // update lands together, or nothing changes on GitHub. It used to be one commit
  // per file, so a failure halfway left the folder split in two.
  // options.branch (required), options.onProgress({ phase, done, total, path }),
  // options.onPhase1Done({ moved, mapping, oldClean, newClean }) after the commit.
  const oldClean = oldFolderPath.replace(/^\/+|\/+$/g, '');
  const newClean = newFolderPath.replace(/^\/+|\/+$/g, '');
  if (!oldClean || !newClean) throw new Error('Paths cannot be empty');
  if (oldClean === newClean) return { moved: [], updatedFiles: [], failedFiles: [] };
  if (!options.branch) throw new Error('renameFolder: options.branch is required');

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(oldClean + '/'));
  if (!filesInFolder.length) throw new Error('Folder is empty or does not exist');

  // Collisions are checked BEFORE anything is read or written.
  const mapping = new Map(); // oldPath -> newPath for every moved file
  for (const file of filesInFolder) {
    const newPath = `${newClean}/${file.path.slice(oldClean.length + 1)}`;
    if (allFiles.some((other) => other.path === newPath)) {
      throw new Error(`Folder "${newClean}" already contains "${basenameOf(file.path)}" - rename would overwrite it`);
    }
    mapping.set(file.path, newPath);
  }

  const progress = async (p) => {
    if (typeof options.onProgress === 'function') { try { await options.onProgress(p); } catch (_) {} }
  };
  const applyMapping = (text, fileDir) => {
    let t = text;
    for (const [o, n] of mapping) {
      const r = updateReferencesInFile(t, fileDir, o, n);
      if (r.changed) t = r.text;
    }
    return t;
  };

  const changes = [];
  const moved = [];
  const updated = [];
  const failed = [];

  // Files of the folder. A .md is read: its own relative links and links to its
  // moved neighbours are rewritten; a read failure aborts BEFORE the commit.
  // Anything else keeps its blob: same sha under the new path, never re-uploaded.
  let done = 0;
  for (const file of filesInFolder) {
    const newPath = mapping.get(file.path);
    if (extOf(file.path) === 'md') {
      const { b64, sha } = await client.getFileB64(file.path);
      let text = null;
      try { text = b64ToUtf8(b64); } catch (_) { text = null; } // binary under .md: keep the bytes
      const next = text === null ? null
        : applyMapping(rewriteOwnRelativeLinks(text, dirnameOf(file.path), dirnameOf(newPath)), dirnameOf(newPath));
      if (text !== null && next !== text) {
        changes.push({ path: newPath, contentB64: utf8ToB64(next) });
        updated.push(newPath);
      } else {
        changes.push({ path: newPath, sha });
      }
    } else {
      let sha = file.sha;
      if (!sha) ({ sha } = await client.getFileB64(file.path));
      changes.push({ path: newPath, sha });
    }
    changes.push({ path: file.path, sha: null });
    moved.push(newPath);
    done += 1;
    await progress({ phase: 'move', done, total: filesInFolder.length, path: file.path });
  }

  // Notes outside the folder: links to the moved files. An unreadable note is
  // reported (failedFiles) and does not stop the rename.
  const outside = allFiles.filter((f) => extOf(f.path) === 'md' && !mapping.has(f.path));
  let linkDone = 0;
  for (const f of outside) {
    await progress({ phase: 'links', done: linkDone, total: outside.length, path: f.path });
    linkDone += 1;
    let b64;
    try {
      ({ b64 } = await client.getFileB64(f.path));
    } catch (e) {
      console.warn('Failed to read for link update:', f.path, e);
      failed.push(f.path);
      continue;
    }
    let text;
    try { text = b64ToUtf8(b64); } catch (_) { continue; } // not valid UTF-8: nothing to rewrite
    const next = applyMapping(text, dirnameOf(f.path));
    if (next === text) continue;
    changes.push({ path: f.path, contentB64: utf8ToB64(next) });
    updated.push(f.path);
  }

  await client.commitTreeChanges(options.branch, `Rename folder ${oldClean} to ${newClean}`, changes);

  if (typeof options.onPhase1Done === 'function') {
    try {
      await options.onPhase1Done({ moved: moved.slice(), mapping, oldClean, newClean });
    } catch (e) {
      console.warn('onPhase1Done failed', e);
    }
  }
  return { moved, updatedFiles: [...new Set(updated)], failedFiles: [...new Set(failed)] };
}

/**
 * Deletes a folder in ONE atomic commit (client.commitTreeChanges): every file
 * goes, or none does. options.branch is required.
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles
 * @param {string} folderPath
 * @returns {Promise<string[]>} paths of the deleted files
 */
export async function deleteFolder(client, allFiles, folderPath, options = {}) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) throw new Error('Folder path cannot be empty');
  if (!options.branch) throw new Error('deleteFolder: options.branch is required');

  const filesInFolder = allFiles.filter((f) => f.path.startsWith(cleanPath + '/'));
  if (!filesInFolder.length) throw new Error('Folder is empty or does not exist');

  await client.commitTreeChanges(options.branch, `Delete folder ${cleanPath}`,
    filesInFolder.map((f) => ({ path: f.path, sha: null })));
  return filesInFolder.map((f) => f.path);
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