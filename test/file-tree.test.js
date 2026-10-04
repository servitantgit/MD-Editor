import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildTreeStructure, FileTree } from '../js/file-tree.js';

test('buildTreeStructure nests files under their folders correctly', () => {
  const files = [
    { path: 'Asset/pic.jpg' },
    { path: 'AI corrected/BOBAM/file.md' },
    { path: 'AI corrected/BOBAM/sub/deep.md' },
    { path: 'README.md' },
  ];
  const tree = buildTreeStructure(files);

  assert.ok(tree.children['Asset']);
  assert.equal(tree.children['Asset'].type, 'folder');
  assert.ok(tree.children['Asset'].children['pic.jpg']);

  assert.ok(tree.children['README.md']);
  assert.equal(tree.children['README.md'].type, 'file');

  const bobam = tree.children['AI corrected'].children['BOBAM'];
  assert.ok(bobam.children['file.md']);
  assert.ok(bobam.children['sub'].children['deep.md']);
  assert.equal(bobam.children['sub'].path, 'AI corrected/BOBAM/sub');
});

/** Renders a FileTree into a detached jsdom container. */
function mountTree(files) {
  const dom = new JSDOM('<!doctype html><body><div id="tree"></div></body>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const container = dom.window.document.getElementById('tree');
  const tree = new FileTree(container, { getActivePath: () => null });
  tree.setFiles(files);
  return { dom, container, tree, restore: () => Object.assign(globalThis, previous) };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

test('clicking the expand arrow expands the folder (it used to be ignored)', () => {
  const { dom, container, tree, restore } = mountTree([{ path: 'Asset/pic.jpg' }]);
  try {
    const folderRow = () => container.querySelector('.file-item.folder');
    const arrow = () => folderRow().querySelector('.folder-toggle');

    // Everything starts collapsed, so the child file is not in the DOM yet.
    assert.equal(arrow().textContent, '▸');
    assert.equal(container.querySelector('.file-item[data-path="Asset/pic.jpg"]'), null);

    click(arrow());
    assert.equal(arrow().textContent, '▾');
    assert.ok(container.querySelector('.file-item[data-path="Asset/pic.jpg"]'), 'child file should be visible');
    assert.equal(tree.collapsedFolders.has('Asset'), false);

    click(arrow());
    assert.equal(arrow().textContent, '▸');
    assert.equal(container.querySelector('.file-item[data-path="Asset/pic.jpg"]'), null, 'child file should be hidden again');
    assert.equal(tree.collapsedFolders.has('Asset'), true);
  } finally {
    restore();
  }
});

test('clicking the folder name/icon toggles the folder too', () => {
  const { dom, container, restore } = mountTree([{ path: 'Asset/pic.jpg' }]);
  try {
    click(container.querySelector('.file-item.folder .name'));
    assert.equal(container.querySelector('.file-item.folder .folder-toggle').textContent, '▾');
    assert.ok(container.querySelector('.file-item[data-path="Asset/pic.jpg"]'));
  } finally {
    restore();
  }
test('the active folder falls back to the root once it is gone from the tree', () => {
  const { container, tree, restore } = mountTree([
    { path: 'Notes/deep/a.md' },
    { path: 'Other/b.md' },
  ]);
  try {
    tree.setActiveFolder('Notes/deep');
    assert.equal(tree.getActiveFolder(), 'Notes/deep');

    // Deleting that folder reloads the tree, and renaming it does the same.
    tree.setFiles([{ path: 'Other/b.md' }]);
    assert.equal(tree.getActiveFolder(), '', 'a deleted folder must not stay the create target');

    // A folder that still exists keeps the target — the check must not fire on
    // every reload, or "new file" would silently fall back to the root.
    tree.setActiveFolder('Other');
    tree.setFiles([{ path: 'Other/c.md' }, { path: 'Other/sub/d.md' }]);
    assert.equal(tree.getActiveFolder(), 'Other');

    // Renaming it away invalidates it just as deletion does.
    tree.setFiles([{ path: 'Renamed/c.md' }]);
    assert.equal(tree.getActiveFolder(), '');

    // Root is always valid and must be left alone.
    tree.setFiles([{ path: 'only.md' }]);
    assert.equal(tree.getActiveFolder(), '');
  } finally {
    restore();
  }
});
});
