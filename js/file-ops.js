// file-ops.js
// File and folder CRUD orchestration: create / rename / move / delete / copy link.
// Pure extraction from app.js — same behaviour; app state via injected deps.
//
// Lower-level helpers stay in file-mover.js, folder-manager.js, paths.js.

import { utf8ToB64 } from './github-client.js';
import { moveFile, renameFile } from './file-mover.js';
import { createFolder, renameFolder, deleteFolder, getFolders, isFolderEmpty } from './folder-manager.js';
import { basenameOf, dirnameOf, relativePathFromTo } from './paths.js';
import { kindFromPath, isEditableTextPath } from './file-kind.js';

/**
 * @param {object} deps
 * @param {object} deps.els - DOM refs used by add-menu / toolbar labels
 * @param {() => any} deps.getState - mutable app state { client, allFiles, currentPath, currentSha, branch, ... }
 * @param {() => any} deps.getFileTree
 * @param {() => any} deps.getTabs
 * @param {() => any} deps.getImageResolver
 * @param {(msg: string, isError?: boolean) => void} deps.setSaveStatus
 * @param {(path: string, opts?: object) => Promise<void>} deps.openFile
 * @param {() => Promise<void>} deps.loadTree
 * @param {(paths: string[]) => Promise<void>} deps.dropTabs
 * @param {(oldPath: string, newPath: string) => void} deps.moveTabDoc
 * @param {(paths: string[]) => void} deps.markStale
 * @param {() => void} deps.persistTabs
 * @param {() => void} deps.renderTabs
 * @param {(text: string) => void} [deps.insertMarkdownAtCursor]
 */
export function createFileOps(deps) {
  const els = deps.els;

  /**
   * Expand every ancestor of `folderPath` so a nested destination is actually
   * visible. setActiveFolder({expand:true}) only opens ONE folder — parents
   * that stay in collapsedFolders never render their children (create/delete
   * work because the user already had that folder open).
   */
  function expandFolderChain(folderPath) {
    const tree = deps.getFileTree();
    if (!tree) return;
    const chain = [];
    let d = folderPath || '';
    while (d) {
      chain.push(d);
      d = dirnameOf(d);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      tree.collapsedFolders.delete(chain[i]);
    }
    tree.setActiveFolder(folderPath || '', { expand: true, render: true });
  }

  /**
   * Local tree truth after a path change. GitHub's recursive tree often lags
   * behind Contents API put+delete (move), so loadTree alone is not enough —
   * same class of bug create/delete used to hit before optimistic updates.
   */
  function patchAllFilesPath(oldPath, newPath) {
    const state = deps.getState();
    const tree = deps.getFileTree();
    const prev = state.allFiles || [];
    const oldEntry = prev.find((f) => f.path === oldPath);
    const existingNew = prev.find((f) => f.path === newPath);
    let files = prev.filter((f) => f.path !== oldPath && f.path !== newPath);
    const entry = existingNew
      ? { ...existingNew, path: newPath }
      : (oldEntry ? { ...oldEntry, path: newPath } : { path: newPath, sha: 'local' });
    entry.path = newPath;
    files.push(entry);
    files.sort((a, b) => a.path.localeCompare(b.path));
    state.allFiles = files;
    if (tree) {
      tree.setFiles(files);
      expandFolderChain(dirnameOf(newPath));
    }
  }

  /**
   * Mirror create/delete: call loadTree for search/draft hooks, then ALWAYS
   * re-apply the local path patch. Never trust the post-write tree alone.
   */
  async function refreshTreeAfterPathChange(oldPath, newPath) {
    try {
      await deps.loadTree();
    } catch (_) {
      /* still patch below */
    }
    patchAllFilesPath(oldPath, newPath);
  }



  async function onMoveFile(oldPath, targetFolder) {
    deps.setSaveStatus(`Moving ${oldPath}...`, false);
    try {
      let result;
      try {
        result = await moveFile(deps.getState().client, deps.getState().allFiles, oldPath, targetFolder);
      } catch (e) {
        // A file with the same name is already in the target folder — replacing it is
        // destructive, so ask first instead of failing with a raw GitHub API error.
        if (e.code !== 'target-exists') throw e;
        const confirmed = confirm(
          `"${e.targetPath}" already exists.\n\nReplace it with "${oldPath}"? This cannot be undone.`
        );
        if (!confirmed) {
          deps.setSaveStatus('Move cancelled', false);
          return;
        }
        result = await moveFile(deps.getState().client, deps.getState().allFiles, oldPath, targetFolder, { overwrite: true });
      }

      const { newPath, updatedFiles, skipped, overwritten } = result;
      if (skipped) {
        deps.setSaveStatus(`${oldPath} is already in that folder`, false);
        return;
      }

      const wasCurrent = deps.getState().currentPath === oldPath;
      deps.getTabs().rename(oldPath, newPath);
      deps.moveTabDoc(oldPath, newPath);
      deps.markStale(updatedFiles); // links were rewritten in these files

      // Show the new location immediately (GitHub tree API often lags).
      patchAllFilesPath(oldPath, newPath);

      if (wasCurrent) {
        deps.getState().currentPath = newPath;
        els.currentFileLabel.textContent = newPath;
      }
      if (deps.getState().currentPath && (wasCurrent || updatedFiles.includes(deps.getState().currentPath))) {
        // Pull fresh contents/sha, and — for the moved file itself — rebind autosave
        // to the NEW path. Left bound to the old one, the next keystroke would try
        // to commit to a path that no longer exists.
        await deps.openFile(deps.getState().currentPath, { reload: true });
      }
      deps.persistTabs();
      deps.renderTabs();

      deps.getImageResolver().invalidate(oldPath);
      // loadTree may return the pre-move tree; reconcile keeps the local move visible.
      await refreshTreeAfterPathChange(oldPath, newPath);
      deps.setSaveStatus(
        `Moved: ${oldPath} → ${newPath}` +
          (overwritten ? ' (replaced the existing file)' : '') +
          (updatedFiles.length ? ` (updated links in ${updatedFiles.length} file(s))` : ''),
        false
      );
    } catch (e) {
      deps.setSaveStatus('Move error: ' + e.message, true);
    }
  }


  // Deleting the active file. The GitHub API requires the sha of that same blob, so
  // we take deps.getState().currentSha (it always matches the last known version of the file).
  async function onDeleteFile() {
    const path = deps.getState().currentPath;
    if (!path) return;

    const confirmed = confirm(`Are you sure you want to delete this file?\n\n${path}\n\nThe file will be removed from the repository; this cannot be undone.`);
    if (!confirmed) return;

    els.btnDelete.disabled = true;
    els.btnSave.disabled = true;
    deps.setSaveStatus('Deleting...', false);

    try {
      await deps.getState().client.deleteFile(path, deps.getState().currentSha, `Delete ${path}`);
      deps.getImageResolver().invalidate(path);
      await deps.dropTabs([path]);
      await deps.loadTree();
      deps.setSaveStatus(`File deleted: ${path}`, false);
    } catch (e) {
      // The file is still in place — restore the buttons to a working state so you can
      // either retry or save the remaining edits.
      els.btnSave.disabled = false;
      els.btnDelete.disabled = false;
      deps.setSaveStatus('Delete error: ' + e.message, true);
    }
  }


  /** Resolves a user-entered NAME into a full repo path inside folderPath ('' = root). */
  function resolvePathIn(folderPath, name) {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) throw new Error('Name cannot be empty');
    if (clean === '.' || clean === '..') throw new Error(`"${clean}" is not a valid name`);
    // A name with slashes is accepted for backwards compatibility with the old
    // "type the full path" prompt, but it is always resolved from the repository root.
    const full = clean.includes('/') ? clean.replace(/^\/+|\/+$/g, '') : clean;
    return folderPath ? `${folderPath}/${full}` : full;
  }


  function targetFolderLabel(folderPath) {
    return folderPath ? `"${folderPath}"` : 'the repository root';
  }


  /** Coerces a "create here" target into a real folder path.
   *
   * The toolbar wires these handlers through `onclick`, and a click event can
   * reach here as `folderPath`. Returning '' (the repo root) for that would
   * silently drop the user's intent — the active folder is what they are looking
   * at, so fall back to it, exactly like the default parameter does for
   * `undefined`. Only an explicit empty string means the repo root. */
  function toFolderPath(value) {
    if (typeof value === 'string') return value;
    return deps.getFileTree() ? deps.getFileTree().getActiveFolder() : '';
  }


  /**
   * Creates a new text file (.md, .html, .js, .css, …). folderPath defaults to the
   * tree's active folder so the file lands where the user is looking.
   */

  function formatActiveFolderPath(folderPath) {
    const p = (folderPath || '').replace(/^\/+|\/+$/g, '');
    return p ? p : '/';
  }


  function updateActiveFolderPathLabel(folderPath) {
    if (!els.activeFolderPath) return;
    const label = formatActiveFolderPath(folderPath);
    els.activeFolderPath.textContent = label;
    els.activeFolderPath.title = label === '/'
      ? 'Target: repository root'
      : 'Target folder: ' + label;
  }


  function closeAddMenu() {
    if (els.addMenu) els.addMenu.classList.add('hidden');
  }


  function setupAddMenu() {
    if (!els.btnAddMenu || els.btnAddMenu.dataset.bound) return;
    els.btnAddMenu.dataset.bound = '1';
    els.btnAddMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!els.addMenu) return;
      els.addMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!els.addMenu || els.addMenu.classList.contains('hidden')) return;
      if (els.addMenu.contains(e.target) || (els.btnAddMenu && els.btnAddMenu.contains(e.target))) return;
      closeAddMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAddMenu();
    });
  }


  async function onCreateNewFile(folderPath = deps.getFileTree().getActiveFolder()) {
    folderPath = toFolderPath(folderPath);
    const name = prompt(
      `New file name (created in ${targetFolderLabel(folderPath)}):\n` +
        `Examples: note.md, page.html, script.js, styles.css`,
      'untitled.md'
    );
    if (!name) return;

    let path;
    try {
      path = resolvePathIn(folderPath, name);
      if (!isEditableTextPath(path)) {
        throw new Error(
          'Unsupported file type. Use a text extension (.md, .html, .js, .css, .json, .txt, …)'
        );
      }
      if (deps.getState().allFiles.some((f) => f.path === path)) throw new Error(`"${path}" already exists`);
    } catch (e) {
      alert(e.message);
      return;
    }

    try {
      deps.setSaveStatus(`Creating ${path}...`, false);
      const starter = starterContentForPath(path);
      await deps.getState().client.putFile(path, utf8ToB64(starter), `Create ${path}`);
      await deps.loadTree();
      deps.getFileTree().setActiveFolder(folderPath, { expand: true }); // reveal the new file
      await deps.openFile(path);
      deps.setSaveStatus(`File created: ${path}`, false);
    } catch (e) {
      deps.setSaveStatus('Create error: ' + e.message, true);
    }
  }


  /** Initial body for a newly created file, by kind. */
  function starterContentForPath(path) {
    const kind = kindFromPath(path);
    if (kind.kind === 'html') {
      return (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n' +
        '  <title>New page</title>\n</head>\n<body>\n  <h1>New page</h1>\n</body>\n</html>\n'
      );
    }
    if (kind.kind === 'code') {
      if (kind.ext === 'css') return '/* styles */\n\n';
      if (kind.ext === 'json') return '{\n  \n}\n';
      if (kind.ext === 'js' || kind.ext === 'mjs' || kind.ext === 'cjs' || kind.ext === 'ts' || kind.ext === 'jsx' || kind.ext === 'tsx') {
        return '// script\n\n';
      }
      if (kind.ext === 'py') return '# script\n\n';
      return '';
    }
    if (kind.kind === 'markdown') return '# New file\n';
    return '';
  }


  async function onCreateNewFolder(folderPath = deps.getFileTree().getActiveFolder()) {
    folderPath = toFolderPath(folderPath);
    const name = prompt(`New folder name (created in ${targetFolderLabel(folderPath)}):`);
    if (!name) return;

    let path;
    try {
      path = resolvePathIn(folderPath, name);
      if (getFolders(deps.getState().allFiles).includes(path)) throw new Error(`Folder "${path}" already exists`);
    } catch (e) {
      alert(e.message);
      return;
    }

    try {
      deps.setSaveStatus(`Creating folder ${path}...`, false);
      await createFolder(deps.getState().client, path);
      await deps.loadTree();
      deps.getFileTree().setActiveFolder(path, { expand: true }); // show the folder that was just created
      deps.setSaveStatus(`Folder created: ${path}`, false);
    } catch (e) {
      deps.setSaveStatus('Create error: ' + e.message, true);
    }
  }


  // Context-menu entry points: always target the folder the user right-clicked.
  function onCreateFileIn(folderPath) {
    return onCreateNewFile(folderPath);
  }


  function onCreateFolderIn(folderPath) {
    return onCreateNewFolder(folderPath);
  }


  /** Renames a file from the tree context menu; keeps it in the same folder. */
  async function onRenameFile(path) {
    const newName = prompt(`New name for "${basenameOf(path)}":`, basenameOf(path));
    if (!newName) return;
    const trimmed = newName.trim();
    if (trimmed === basenameOf(path)) return;

    try {
      deps.setSaveStatus(`Renaming ${path}...`, false);
      const { newPath, updatedFiles, skipped } = await renameFile(deps.getState().client, deps.getState().allFiles, path, trimmed);
      if (skipped) return;

      const wasCurrent = deps.getState().currentPath === path;
      deps.getTabs().rename(path, newPath);
      deps.moveTabDoc(path, newPath);
      deps.markStale(updatedFiles);

      patchAllFilesPath(path, newPath);

      if (wasCurrent) {
        deps.getState().currentPath = newPath;
        els.currentFileLabel.textContent = newPath;
      }
      if (deps.getState().currentPath && (wasCurrent || updatedFiles.includes(deps.getState().currentPath))) {
        await deps.openFile(deps.getState().currentPath, { reload: true }); // refresh the editor + sha under the new path
      }
      deps.persistTabs();
      deps.renderTabs();

      deps.getImageResolver().invalidate(path);
      await refreshTreeAfterPathChange(path, newPath);
      deps.setSaveStatus(
        `Renamed: ${path} → ${newPath}` +
          (updatedFiles.length ? ` (updated links in ${updatedFiles.length} file(s))` : ''),
        false
      );
    } catch (e) {
      deps.setSaveStatus('Rename error: ' + e.message, true);
    }
  }


  /** Deletes a file from the tree context menu (works for any file, not just the open one). */
  async function onDeleteFileAt(path) {
    const confirmed = confirm(
      `Are you sure you want to delete this file?\n\n${path}\n\nThe file will be removed from the repository; this cannot be undone.`
    );
    if (!confirmed) return;

    try {
      deps.setSaveStatus(`Deleting ${path}...`, false);
      const entry = deps.getState().allFiles.find((f) => f.path === path);
      const sha = deps.getState().currentPath === path ? deps.getState().currentSha : entry && entry.sha;
      if (!sha) throw new Error(`No sha known for ${path} — refresh the tree and try again`);

      await deps.getState().client.deleteFile(path, sha, `Delete ${path}`);
      deps.getImageResolver().invalidate(path);
      await deps.dropTabs([path]);
      await deps.loadTree();
      deps.setSaveStatus(`File deleted: ${path}`, false);
    } catch (e) {
      deps.setSaveStatus('Delete error: ' + e.message, true);
    }
  }


  /**
   * Builds a markdown link to `targetPath` and copies it to the clipboard.
   * Relative to the currently open file when there is one; falls back to
   * repo-root absolute (/path) otherwise. For .md files the display name
   * strips the extension; everything else keeps its extension (images,
   * html, code files).
   */
  async function onCopyLinkToFile(targetPath) {
    const basename = basenameOf(targetPath);
    const displayName = basename.replace(/\.md$/i, '');

    let linkPath;
    if (deps.getState().currentPath) {
      linkPath = relativePathFromTo(dirnameOf(deps.getState().currentPath), targetPath);
    } else {
      // No open file — root-absolute link. The leading slash is a convention
      // the editor already understands (see reference-rewriter.js).
      linkPath = '/' + targetPath;
    }
    // DO NOT percent-encode here. marked (the markdown renderer) captures the
    // link URL verbatim and percent-encodes it once at HTML serialization — so a
    // pre-encoded %20 would come back out as %20 and then be re-encoded to %25 by
    // encodePathForApi on the way to GitHub (a 404). The raw path with real
    // spaces/unicode is the correct wire format for markdown link syntax —
    // GitHub, Obsidian and VS Code all accept and prefer this.
    //
    // Markdown has one real escaping concern: parentheses terminate link syntax,
    // and a bare space inside (...) is not parsed as a link at all. Wrap the URL
    // in <...> when it contains spaces or parens — the standard markdown escape
    // for arbitrary URLs. marked strips the angle brackets and encodes the
    // spaces into the href, and the click handler decodes them back.
    const needsAngleBrackets = /[()\s]/.test(linkPath);
    const urlPart = needsAngleBrackets ? `<${linkPath}>` : linkPath;
    const markdown = `[${displayName}](${urlPart})`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(markdown);
        deps.setSaveStatus(`Link copied: ${basename}`, false);
      } else {
        throw new Error('clipboard API unavailable');
      }
    } catch (e) {
      // Fallback: prompt with text pre-selected so user can Ctrl+C.
      // Not pretty, but works in insecure contexts and older browsers.
      const ok = window.prompt(
        `Copy this link (Ctrl+C):`,
        markdown
      );
      if (ok !== null) {
        deps.setSaveStatus(`Link ready: ${basename}`, false);
      }
    }
  }


  // ====================== FOLDER OPERATIONS ======================
  async function onRenameFolder(folderPath) {
    const newName = prompt(`New name for folder "${basenameOf(folderPath)}":`);
    if (!newName || newName.trim() === '') return;
    const newPath = `${dirnameOf(folderPath)}/${newName.trim()}`.replace(/^\/+/, '');
    if (newPath === folderPath) return;

    try {
      deps.setSaveStatus(`Renaming ${folderPath}...`, false);
      const { moved, updatedFiles } = await renameFolder(deps.getState().client, deps.getState().allFiles, folderPath, newPath);
      for (const [from, to] of deps.getTabs().renameFolder(folderPath, newPath)) deps.moveTabDoc(from, to);
      deps.markStale(updatedFiles);

      // Optimistic local update (see onMoveFile), but a folder rename moves MANY
      // files. renameFolder() reads deps.getState().allFiles without mutating it, so every
      // entry still names its OLD path; repoint them all under the new prefix so
      // the whole folder visibly moves at once. The eventual deps.loadTree() overwrites
      // with authoritative state when GitHub catches up.
      const folderPrefix = folderPath + '/';
      const newFolderPrefix = newPath + '/';
      let folderPatched = false;
      for (let i = 0; i < deps.getState().allFiles.length; i++) {
        const f = deps.getState().allFiles[i];
        if (f.path.startsWith(folderPrefix)) {
          deps.getState().allFiles[i] = { ...f, path: newFolderPrefix + f.path.slice(folderPrefix.length) };
          folderPatched = true;
        }
      }
      if (folderPatched) deps.getFileTree().setFiles(deps.getState().allFiles);

      if (deps.getState().currentPath && deps.getState().currentPath.startsWith(folderPath + '/')) {
        deps.getState().currentPath = newPath + deps.getState().currentPath.slice(folderPath.length);
        els.currentFileLabel.textContent = deps.getState().currentPath;
        await deps.openFile(deps.getState().currentPath, { reload: true });
      }
      deps.persistTabs();
      deps.renderTabs();
      await deps.loadTree();
      deps.setSaveStatus(`Renamed: ${folderPath} → ${newPath} (files: ${moved.length})`, false);
    } catch (e) {
      deps.setSaveStatus('Error: ' + e.message, true);
    }
  }


  async function onDeleteFolder(folderPath) {
    if (!isFolderEmpty(deps.getState().allFiles, folderPath)) {
      const confirmed = confirm(`Folder "${folderPath}" is not empty. Delete all files in it?\nThis cannot be undone.`);
      if (!confirmed) return;
    } else {
      const confirmed = confirm(`Delete empty folder "${folderPath}"?`);
      if (!confirmed) return;
    }

    try {
      deps.setSaveStatus(`Deleting folder ${folderPath}...`, false);
      await deleteFolder(deps.getState().client, deps.getState().allFiles, folderPath);
      await deps.dropTabs(deps.getTabs().paths.filter((p) => p.startsWith(folderPath + '/')));
      await deps.loadTree();
      deps.setSaveStatus(`Folder deleted: ${folderPath}`, false);
    } catch (e) {
      deps.setSaveStatus('Error: ' + e.message, true);
    }
  }

  function setupToolbar() {
    if (els.btnNewFile) {
      els.btnNewFile.onclick = () => {
        closeAddMenu();
        onCreateNewFile();
      };
    }
    if (els.btnNewFolder) {
      els.btnNewFolder.onclick = () => {
        closeAddMenu();
        onCreateNewFolder();
      };
    }
    try { setupAddMenu(); } catch (e) { console.warn('setupAddMenu', e); }
    if (els.btnDelete) els.btnDelete.onclick = onDeleteFile;
  }

  /** Handlers for FileTree constructor */
  function treeHandlers() {
    return {
      onMoveFile,
      onRenameFolder,
      onDeleteFolder,
      onCreateFileIn,
      onCreateFolderIn,
      onRenameFile,
      onDeleteFileAt,
      onCopyLinkToFile: (path) => onCopyLinkToFile(path),
      onActiveFolderChange: (folderPath) => updateActiveFolderPathLabel(folderPath),
    };
  }

  return {
    setupToolbar,
    treeHandlers,
    onCreateNewFile,
    onCreateNewFolder,
    onDeleteFile,
    onMoveFile,
    onRenameFile,
    onDeleteFileAt,
    onCopyLinkToFile,
    onRenameFolder,
    onDeleteFolder,
    updateActiveFolderPathLabel,
    toFolderPath,
    closeAddMenu,
  };
}
