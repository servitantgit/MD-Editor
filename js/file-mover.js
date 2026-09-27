// file-mover.js
// Orchestrates moving a file between folders: reads/writes via GitHubClient,
// and takes the "what exactly to change in the text" logic from reference-rewriter.js (pure functions).

import { basenameOf, dirnameOf, extOf } from './paths.js';
import { utf8ToB64, b64ToUtf8 } from './github-client.js';
import { rewriteOwnRelativeLinks, updateReferencesInFile } from './reference-rewriter.js';

/**
 * Moves file oldPath into folder targetFolder (may be '' — the repository root).
 * If the moved file is .md, first recalculates its OWN relative links.
 * Then scans all .md files in the repository (except the moved file itself) and fixes
 * links that pointed at oldPath.
 *
 * @param {import('./github-client.js').GitHubClient} client
 * @param {{path:string, sha:string}[]} allFiles  current snapshot of the file tree
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
      // non-text/non-UTF8 content under a .md extension — keep the bytes as-is
    }
  }

  await client.putFile(newPath, finalB64, `Move ${oldPath} to ${newPath}`);
  await client.deleteFile(oldPath, sha, `Remove ${oldPath} (moved to ${newPath})`);

  const updatedFiles = await updateReferencesEverywhere(client, allFiles, oldPath, newPath);

  return { newPath, updatedFiles, skipped: false };
}

/**
 * Walks all .md files (except newPath — that's the moved file itself) and fixes
 * links that actually pointed at oldPath.
 * @returns {Promise<string[]>} paths of the files that were changed
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
      console.warn('Failed to update links in', f.path, e);
    }
  }
  return updated;
}
