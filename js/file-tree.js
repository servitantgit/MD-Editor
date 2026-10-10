// file-tree.js
// File-tree rendering + drag&drop between folders. The "what to change when
// moving" mechanics live in file-mover.js; only DOM here.

import { dirnameOf, basenameOf, extOf, isImagePath, escapeAttr } from './paths.js';
import { isEditableTextPath, kindFromPath } from './file-kind.js';

/** Turns a flat {path} list into a nested folder/file structure. */
export function buildTreeStructure(files) {
  const root = { name: '', path: '', type: 'folder', children: {} };
  files.forEach((item) => {
    const parts = item.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!node.children[p]) {
        node.children[p] = { name: p, path: (node.path ? node.path + '/' : '') + p, type: 'folder', children: {} };
      }
      node = node.children[p];
    }
    const fname = parts[parts.length - 1];
    node.children[fname] = { name: fname, path: item.path, type: 'file', sha: item.sha };
  });
  return root;
}

/**
 * Every folder path implied by a flat file list. Git has no real folders — they
 * exist only as path prefixes — so this is the whole client-side notion of
 * "which folders exist right now".
 */
function collectFolderPaths(files) {
  const dirs = new Set();
  for (const f of files) {
    let d = dirnameOf(f.path);
    while (d) {
      dirs.add(d);
      d = dirnameOf(d);
    }
  }
  return dirs;
}

export class FileTree {
  /**
   * @param {HTMLElement} containerEl
   * @param {{
   *   onOpenFile: (path: string) => void,
   *   onPreviewImage: (path: string) => void,
   *   onMoveFile: (oldPath: string, targetFolder: string) => Promise<void>,
   *   getActivePath: () => string|null,
   *   onRenameFolder: (path: string) => void,
   *   onDeleteFolder: (path: string) => void,
   * }} handlers
   */
  constructor(containerEl, handlers) {
    this.containerEl = containerEl;
    this.handlers = handlers;
    this.collapsedFolders = new Set();
    this.treeInitialized = false;
    this.files = [];
    // The folder new files/folders are created in — follows the last folder the user
    // interacted with (opened or expanded). '' means the repository root.
    this.activeFolder = '';
    /** @type {Record<string, 'M'|'A'>} */
    this.dirtyMap = {};
  }

  /** Update dirty badges without changing the file list. */
  setDirtyMap(map) {
    this.dirtyMap = map || {};
    if (this.files.length) this.render();
  }

  getActiveFolder() {
    return this.activeFolder;
  }

  /** Sets the "create here" folder; an already-known folder is expanded so the user sees the result. */
  setActiveFolder(folderPath, { expand = false, render = true } = {}) {
    const prev = this.activeFolder;
    this.activeFolder = folderPath || '';
    if (expand && folderPath) this.collapsedFolders.delete(folderPath);
    if (render && (prev !== this.activeFolder || expand)) {
      this.render(); // also notifies onActiveFolderChange
    } else if (typeof this.handlers?.onActiveFolderChange === 'function') {
      try { this.handlers.onActiveFolderChange(this.activeFolder || ''); } catch (_) {}
    }
  }

  setFiles(files) {
    this.files = files;
    const existing = collectFolderPaths(files);

    // The "create here" target must still exist. Deleting or renaming that folder
    // reloads the tree, but nothing here used to notice that the stored path is
    // gone — and the next "new file" would then PUT into it, silently
    // resurrecting a folder the user just deleted. Root ('') is always valid.
    if (this.activeFolder && !existing.has(this.activeFolder)) this.activeFolder = '';

    // Same for collapsed state: an entry left behind by a deleted folder is not
    // inert, because it becomes live again the moment a folder with that name is
    // recreated — and it would then start collapsed for no visible reason.
    for (const path of this.collapsedFolders) {
      if (!existing.has(path)) this.collapsedFolders.delete(path);
    }

    this.render();
  }

  render() {
    const files = this.files;
    this.containerEl.innerHTML = '';

    if (!this.treeInitialized) {
      this.treeInitialized = true;
      // Everything collapsed on the first render (handy for large repos). Runs once
      // only, which is also why a folder created later starts expanded.
      this.collapsedFolders = collectFolderPaths(files);
    }

    // Drop strip: moves a file into the *current target folder* (activeFolder),
    // not only the repo root. Label updates with the selection.
    const targetFolder = this.activeFolder || '';
    const dropStrip = document.createElement('div');
    dropStrip.className = 'tree-root-drop';
    dropStrip.dataset.targetFolder = targetFolder;
    if (targetFolder) {
      const short = targetFolder.length > 42 ? '…' + targetFolder.slice(-40) : targetFolder;
      dropStrip.textContent = `⬆ drag here to move into «${short}»`;
      dropStrip.title = `Drop to move into ${targetFolder}`;
    } else {
      dropStrip.textContent = '⬆ drag here to move to the root';
      dropStrip.title = 'Drop to move to the repository root';
    }
    this.containerEl.appendChild(dropStrip);
    this._wireDropTarget(dropStrip, targetFolder);

    const root = buildTreeStructure(files);
    this._renderLevel(root, this.containerEl, 0);

    if (typeof this.handlers?.onActiveFolderChange === 'function') {
      try { this.handlers.onActiveFolderChange(this.activeFolder || ''); } catch (_) {}
    }
  }

  /** Flips the collapsed state of a folder and re-renders the tree. */
  _toggleFolder(folderPath) {
    if (this.collapsedFolders.has(folderPath)) this.collapsedFolders.delete(folderPath);
    else this.collapsedFolders.add(folderPath);
    this.render();
  }

  _renderLevel(node, container, depth) {
    const folderNames = Object.keys(node.children).filter((k) => node.children[k].type === 'folder').sort();
    const fileNames = Object.keys(node.children).filter((k) => node.children[k].type === 'file').sort();

    folderNames.forEach((name) => {
      const folder = node.children[name];
      const collapsed = this.collapsedFolders.has(folder.path);

      const el = document.createElement('div');
      el.className = 'file-item folder';
      el.style.paddingLeft = `${12 + depth * 14}px`;
      el.dataset.path = folder.path;
      el.innerHTML = `<span class="folder-toggle" role="button" tabindex="0" title="Expand/collapse">${collapsed ? '▸' : '▾'}</span><span class="icon">📁</span><span class="name">${escapeAttr(name)}</span>`;
      // Any click on the row (arrow, icon or name) toggles the folder and makes it
      // the target for "new file"/"new folder".
      el.addEventListener('click', () => {
        this.setActiveFolder(folder.path, { render: false });
        this._toggleFolder(folder.path);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this._toggleFolder(folder.path);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._showFolderContextMenu(e.clientX, e.clientY, folder.path);
      });
      this._wireDropTarget(el, folder.path);
      container.appendChild(el);

      if (!collapsed) this._renderLevel(folder, container, depth + 1);
    });

    fileNames.forEach((name) => {
      const file = node.children[name];
      const isMd = extOf(file.path) === 'md';
      const isImg = isImagePath(file.path);
      const isText = !isImg && isEditableTextPath(file.path);
      const kind = kindFromPath(file.path);
      const icon = isMd ? '📄' : isImg ? '🖼️' : kind.kind === 'html' ? '🌐' : kind.kind === 'code' ? '📜' : '📦';

      const el = document.createElement('div');
      el.className = 'file-item' + (isMd || isImg || isText ? '' : ' other');
      el.style.paddingLeft = `${12 + (depth + 1) * 14}px`;
      el.dataset.path = file.path;
      el.title = file.path + (kind.label ? ` · ${kind.label}` : '');
      const dirty = this.dirtyMap[file.path];
      const dirtyHtml = dirty
        ? `<span class="dirty-badge ${dirty}">${dirty}</span>`
        : '';
      el.innerHTML = `<span class="icon">${icon}</span><span class="name">${escapeAttr(name)}</span>${dirtyHtml}`;

      if ((isMd || isText) && this.handlers.onOpenFile) {
        el.addEventListener('click', () => {
          // Opening a file also makes ITS folder the target for new files/folders.
          this.setActiveFolder(dirnameOf(file.path));
          this.handlers.onOpenFile(file.path);
        });
      } else if (isImg && this.handlers.onPreviewImage) {
        el.addEventListener('click', () => {
          this.setActiveFolder(dirnameOf(file.path));
          this.handlers.onPreviewImage(file.path);
        });
      }
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._showFileContextMenu(e.clientX, e.clientY, file.path);
      });

      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', file.path);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));

      if (this.handlers.getActivePath() === file.path) el.classList.add('active');

      container.appendChild(el);
    });
  }

  _wireDropTarget(el, folderPath) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const srcPath = e.dataTransfer.getData('text/plain');
      if (!srcPath) return;
      if (this.handlers?.onMoveFile) await this.handlers.onMoveFile(srcPath, folderPath);
    });
  }

  /**
 * Shows a context menu at (x, y). `items` = [{action, label, className}].
   * `onPick(action)` fires synchronously from the click handler itself.
   *
   * Do NOT defer that call with setTimeout: the menu stays open for as long as the
   * user takes to decide, so a timer started here runs long before they click and
   * reads `null` — the chosen action is silently dropped. (That bug shipped once.)
   */
  _showContextMenu(x, y, items, onPick) {
    const existing = document.querySelector('.folder-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.innerHTML = items
      .map((it) => `<button data-action="${escapeAttr(it.action)}"${it.className ? ` class="${it.className}"` : ''}>${escapeAttr(it.label)}</button>`)
      .join('');

    const closeMenu = () => {
      menu.remove();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
    // Registered SYNCHRONOUSLY, deliberately. Deferring this with setTimeout(0)
    // leaves a window in which the menu is on screen but not yet armed, so a
    // click landing in that window silently does nothing — that is exactly what
    // made the e2e dismissal check flaky.
    //
    // Synchronous is safe here even though the menu opens from `contextmenu`,
    // because `document` is the outermost ancestor: in the bubble phase its
    // handler always runs AFTER the menu's own. The containment check below
    // makes that reasoning unnecessary as well, so opening the menu from a plain
    // click (a "⋯" button) in future would still work.
    const onDocClick = (e) => {
      // A click INSIDE the menu belongs to the menu's own handler; dismissing
      // here would rip the button out of the DOM before that handler runs.
      if (menu.contains(e.target)) return;
      closeMenu();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') closeMenu(); };

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      closeMenu();
      onPick(btn.dataset.action);
    });

    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);

    document.body.appendChild(menu);

    // Keep the menu on screen when right-clicking near the bottom/right edge.
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  }

  _showFolderContextMenu(x, y, folderPath) {
    this._showContextMenu(x, y, [
      { action: 'new-file', label: '📄 New file here' },
      { action: 'new-folder', label: '📁 New folder here' },
      { action: 'rename', label: '✏️ Rename' },
      { action: 'delete', label: '🗑 Delete', className: 'danger' },
    ], (action) => {
      if (action === 'new-file' && this.handlers?.onCreateFileIn) this.handlers.onCreateFileIn(folderPath);
      if (action === 'new-folder' && this.handlers?.onCreateFolderIn) this.handlers.onCreateFolderIn(folderPath);
      if (action === 'rename' && this.handlers?.onRenameFolder) this.handlers.onRenameFolder(folderPath);
      if (action === 'delete' && this.handlers?.onDeleteFolder) this.handlers.onDeleteFolder(folderPath);
    });
  }

  _showFileContextMenu(x, y, filePath) {
    this._showContextMenu(x, y, [
      { action: 'new-file-here', label: '📄 New file in this folder' },
      { action: 'copy-link', label: '🔗 Copy as link' },
      { action: 'rename', label: '✏️ Rename' },
      { action: 'delete', label: '🗑 Delete', className: 'danger' },
    ], (action) => {
      if (action === 'new-file-here' && this.handlers?.onCreateFileIn) {
        this.handlers.onCreateFileIn(dirnameOf(filePath));
      }
      if (action === 'copy-link' && this.handlers?.onCopyLinkToFile) {
        this.handlers.onCopyLinkToFile(filePath);
      }
      if (action === 'rename' && this.handlers?.onRenameFile) this.handlers.onRenameFile(filePath);
      if (action === 'delete' && this.handlers?.onDeleteFileAt) this.handlers.onDeleteFileAt(filePath);
    });
  }

  clearActive() {
    this.containerEl.querySelectorAll('.file-item').forEach((el) => el.classList.remove('active'));
  }

  setActive(path) {
    this.clearActive();
    const active = this.containerEl.querySelector(`.file-item[data-path="${cssEscape(path)}"]`);
    if (active) active.classList.add('active');
  }
}

function cssEscape(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
