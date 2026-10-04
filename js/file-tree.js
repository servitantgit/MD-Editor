// file-tree.js
// File-tree rendering + drag&drop between folders. The "what to change when
// moving" mechanics live in file-mover.js; only DOM here.

import { dirnameOf, basenameOf, extOf, isImagePath, escapeAttr } from './paths.js';

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
  }

  getActiveFolder() {
    return this.activeFolder;
  }

  /** Sets the "create here" folder; an already-known folder is expanded so the user sees the result. */
  setActiveFolder(folderPath, { expand = false } = {}) {
    this.activeFolder = folderPath;
    if (expand && folderPath && this.collapsedFolders.delete(folderPath)) this.render();
  }

  setFiles(files) {
    this.files = files;
    this.render();
  }

  render() {
    const files = this.files;
    this.containerEl.innerHTML = '';

    if (!this.treeInitialized) {
      this.treeInitialized = true;
      const dirSet = new Set();
      files.forEach((f) => {
        let d = dirnameOf(f.path);
        while (d) {
          dirSet.add(d);
          d = dirnameOf(d);
        }
      });
      this.collapsedFolders = dirSet; // everything collapsed by default (handy for large repos)
    }

    const rootDrop = document.createElement('div');
    rootDrop.className = 'tree-root-drop';
    rootDrop.textContent = '⬆ drag here to move to the root';
    this.containerEl.appendChild(rootDrop);
    this._wireDropTarget(rootDrop, '');

    const root = buildTreeStructure(files);
    this._renderLevel(root, this.containerEl, 0);
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
        this.activeFolder = folder.path;
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
      const icon = isMd ? '📄' : isImg ? '🖼️' : '📦';

      const el = document.createElement('div');
      el.className = 'file-item' + (isMd || isImg ? '' : ' other');
      el.style.paddingLeft = `${12 + (depth + 1) * 14}px`;
      el.dataset.path = file.path;
      el.title = file.path;
      el.innerHTML = `<span class="icon">${icon}</span><span class="name">${escapeAttr(name)}</span>`;

      if (isMd && this.handlers.onOpenFile) {
        el.addEventListener('click', () => {
          // Opening a file also makes ITS folder the target for new files/folders.
          this.activeFolder = dirnameOf(file.path);
          this.handlers.onOpenFile(file.path);
        });
      } else if (isImg && this.handlers.onPreviewImage) {
        el.addEventListener('click', () => {
          this.activeFolder = dirnameOf(file.path);
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

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      menu.remove();
      onPick(btn.dataset.action);
    });

    const closeMenu = () => menu.remove();
    document.addEventListener('click', closeMenu, { once: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, { once: true });

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
      { action: 'rename', label: '✏️ Rename' },
      { action: 'delete', label: '🗑 Delete', className: 'danger' },
    ], (action) => {
      if (action === 'new-file-here' && this.handlers?.onCreateFileIn) {
        this.handlers.onCreateFileIn(dirnameOf(filePath));
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
