// file-tree.js
// Побудова дерева файлів + drag&drop між папками. Сама механіка "що змінити при
// переміщенні" — у file-mover.js; тут тільки DOM.

import { dirnameOf, basenameOf, extOf, isImagePath, escapeAttr } from './paths.js';

/** Перетворює плаский список {path} на вкладену структуру тек/файлів. */
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
   * }} handlers
   */
  constructor(containerEl, handlers) {
    this.containerEl = containerEl;
    this.handlers = handlers;
    this.collapsedFolders = new Set();
    this.treeInitialized = false;
    this.files = [];
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
      this.collapsedFolders = dirSet; // за замовчуванням усе згорнуто (зручно для великих репо)
    }

    const rootDrop = document.createElement('div');
    rootDrop.className = 'tree-root-drop';
    rootDrop.textContent = '⬆ перетягніть сюди, щоб перемістити в корінь';
    this.containerEl.appendChild(rootDrop);
    this._wireDropTarget(rootDrop, '');

    const root = buildTreeStructure(files);
    this._renderLevel(root, this.containerEl, 0);
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
      el.innerHTML = `<span class="folder-toggle">${collapsed ? '▸' : '▾'}</span><span class="icon">📁</span><span class="name">${escapeAttr(name)}</span>`;
      el.onclick = () => {
        if (this.collapsedFolders.has(folder.path)) this.collapsedFolders.delete(folder.path);
        else this.collapsedFolders.add(folder.path);
        this.render();
      };
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

      if (isMd) el.onclick = () => this.handlers.onOpenFile(file.path);
      else if (isImg) el.onclick = () => this.handlers.onPreviewImage(file.path);

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
      await this.handlers.onMoveFile(srcPath, folderPath);
    });
  }

  setActive(path) {
    this.containerEl.querySelectorAll('.file-item').forEach((el) => el.classList.remove('active'));
    const active = this.containerEl.querySelector(`.file-item[data-path="${cssEscape(path)}"]`);
    if (active) active.classList.add('active');
  }
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
