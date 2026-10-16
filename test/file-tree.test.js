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
function mountTree(files, extraHandlers = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="tree"></div></body>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const container = dom.window.document.getElementById('tree');
  const tree = new FileTree(container, { getActivePath: () => null, ...extraHandlers });
  tree.setFiles(files);
  return { dom, container, tree, restore: () => Object.assign(globalThis, previous) };
}

/** A minimal DataTransfer stand-in: jsdom has none, and the drag code only
 *  ever setData/getData strings — exactly what an internal tree drag carries. */
function makeDataTransfer() {
  const store = new Map();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    store,
    setData: (type, value) => { store.set(type, String(value)); },
    getData: (type) => (store.has(type) ? store.get(type) : ''),
  };
}

function fireDrag(el, type, dataTransfer) {
  const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = dataTransfer;
  el.dispatchEvent(ev);
  return ev;
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
});

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

test('a folder recreated under a name that was deleted starts expanded', () => {
  const { container, tree, restore } = mountTree([{ path: 'Notes/a.md' }]);
  try {
    // Everything starts collapsed on the first render.
    assert.equal(tree.collapsedFolders.has('Notes'), true);

    // Delete the folder: its files are gone from the tree, the row disappears.
    tree.setFiles([{ path: 'Other/b.md' }]);
    assert.equal(container.querySelector('.file-item.folder[data-path="Notes"]'), null);

    // Recreate the SAME name. It must not inherit collapsed state left behind by
    // a folder that no longer exists — that is surprising for the user.
    tree.setFiles([{ path: 'Notes/c.md' }]);
    const row = container.querySelector('.file-item.folder[data-path="Notes"]');
    assert.ok(row, 'the recreated folder must be rendered');
    assert.equal(
      row.querySelector('.folder-toggle').textContent,
      '▾',
      'a recreated folder must start expanded, not inherit stale collapsed state'
    );
  } finally {
    restore();
  }
});

test('collapsedFolders keeps entries for folders that still exist', () => {
  const { tree, restore } = mountTree([{ path: 'Notes/a.md' }, { path: 'Other/b.md' }]);
  try {
    assert.equal(tree.collapsedFolders.has('Notes'), true);
    assert.equal(tree.collapsedFolders.has('Other'), true);

    // Reloading the tree with one folder gone must not drop the other's state.
    tree.setFiles([{ path: 'Notes/a.md' }]);
    assert.equal(tree.collapsedFolders.has('Notes'), true, 'an existing folder keeps its state');
    assert.equal(tree.collapsedFolders.has('Other'), false, 'the deleted one is pruned');
  } finally {
    restore();
  }
});

test('.gitkeep-only folder renders the folder row, hides .gitkeep, shows (empty)', () => {
  const { container, tree, restore } = mountTree([{ path: 'Docs/.gitkeep' }]);
  try {
    // Folder row exists at root level.
    const docsRow = container.querySelector('.file-item.folder[data-path="Docs"]');
    assert.ok(docsRow, 'Docs folder row should render');

    // Expand Docs.
    click(docsRow.querySelector('.folder-toggle'));
    const toggle = container.querySelector('.file-item.folder[data-path="Docs"] .folder-toggle');
    assert.equal(toggle.textContent, '▾');

    // No .gitkeep row in the tree.
    assert.equal(
      container.querySelector('.file-item[data-path="Docs/.gitkeep"]'),
      null,
      '.gitkeep must not render as a file row'
    );

    // (empty) row is present at child indent level.
    const emptyRow = container.querySelector('.tree-empty');
    assert.ok(emptyRow, '(empty) row should appear for a gitkeep-only folder');
    assert.equal(emptyRow.textContent, '(empty)');
  } finally {
    restore();
  }
});

test('.gitkeep alongside a real file: real file shows, no (empty)', () => {
  const { container, tree, restore } = mountTree([
    { path: 'Docs/.gitkeep' },
    { path: 'Docs/a.md' },
  ]);
  try {
    const docsRow = container.querySelector('.file-item.folder[data-path="Docs"]');
    assert.ok(docsRow);

    click(docsRow.querySelector('.folder-toggle'));

    assert.ok(container.querySelector('.file-item.folder[data-path="Docs"]'), 'Docs row still present after re-render');
    assert.ok(container.querySelector('.file-item[data-path="Docs/a.md"]'), 'a.md should render');
    assert.equal(
      container.querySelector('.file-item[data-path="Docs/.gitkeep"]'),
      null,
      '.gitkeep must not render'
    );
    assert.equal(
      container.querySelector('.tree-empty'),
      null,
      'no (empty) row when a real file exists'
    );
  } finally {
    restore();
  }
});

test('.gitkeep with a subfolder: subfolder row shows, no (empty)', () => {
  const { container, tree, restore } = mountTree([
    { path: 'Docs/.gitkeep' },
    { path: 'Docs/Sub/b.md' },
  ]);
  try {
    const docsRow = container.querySelector('.file-item.folder[data-path="Docs"]');
    assert.ok(docsRow);

    click(docsRow.querySelector('.folder-toggle'));

    assert.ok(container.querySelector('.file-item.folder[data-path="Docs"]'), 'Docs row still present after re-render');
    assert.ok(container.querySelector('.file-item.folder[data-path="Docs/Sub"]'), 'Docs/Sub folder row should render');
    assert.equal(
      container.querySelector('.file-item[data-path="Docs/.gitkeep"]'),
      null,
      '.gitkeep must not render'
    );
    assert.equal(
      container.querySelector('.tree-empty'),
      null,
      'no (empty) row when a subfolder exists'
    );
  } finally {
    restore();
  }
});

test('setActiveFolder survives setFiles when folder has only .gitkeep', () => {
  const { container, tree, restore } = mountTree([{ path: 'Docs/.gitkeep' }]);
  try {
    tree.setActiveFolder('Docs');
    assert.equal(tree.getActiveFolder(), 'Docs');

    // Reloading with the same gitkeep-only file must NOT reset activeFolder.
    tree.setFiles([{ path: 'Docs/.gitkeep' }]);
    assert.equal(tree.getActiveFolder(), 'Docs', 'gitkeep-only folder must remain the active target');
  } finally {
    restore();
  }
});

test('folder rows are draggable and dragstart publishes the folder payload', () => {
  const { container, restore } = mountTree([{ path: 'Notes/a.md' }]);
  try {
    const row = container.querySelector('.file-item.folder[data-path="Notes"]');
    assert.equal(row.draggable, true, 'folder row must be draggable');
    const dt = makeDataTransfer();
    fireDrag(row, 'dragstart', dt);
    assert.equal(dt.getData('application/x-md-folder'), 'Notes', 'custom folder type is set');
    assert.equal(dt.getData('text/plain'), 'Notes', 'text/plain fallback is set');
    assert.equal(dt.effectAllowed, 'move');
    assert.equal(row.classList.contains('dragging'), true, 'visual dragging state on the row');
    fireDrag(row, 'dragend', makeDataTransfer());
    assert.equal(row.classList.contains('dragging'), false, 'dragging cleared on dragend');
  } finally {
    restore();
  }
});

test('a folder drop calls onMoveFolder; a file payload still calls onMoveFile', async () => {
  const calls = [];
  const { container, restore } = mountTree(
    [{ path: 'Notes/a.md' }, { path: 'Other/b.md' }],
    {
      onMoveFolder: async (src, target) => { calls.push(['folder', src, target]); },
      onMoveFile: async (src, target) => { calls.push(['file', src, target]); },
    }
  );
  try {
    const target = container.querySelector('.file-item.folder[data-path="Other"]');

    // Folder payload — the text/plain fallback must NOT route it to onMoveFile.
    const folderDt = makeDataTransfer();
    folderDt.setData('application/x-md-folder', 'Notes');
    folderDt.setData('text/plain', 'Notes');
    fireDrag(target, 'drop', folderDt);

    // Plain file payload — unchanged behaviour.
    const fileDt = makeDataTransfer();
    fileDt.setData('text/plain', 'Notes/a.md');
    fireDrag(target, 'drop', fileDt);

    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, [
      ['folder', 'Notes', 'Other'],
      ['file', 'Notes/a.md', 'Other'],
    ]);
  } finally {
    restore();
  }
});

test('dragover refuses the folder itself, its descendants and its current parent', () => {
  const { container, restore } = mountTree([
    { path: 'Notes/Sub/a.md' },
    { path: 'Other/b.md' },
  ]);
  try {
    // Expand Notes so its Sub row exists (folders start collapsed).
    click(container.querySelector('.file-item.folder[data-path="Notes"] .folder-toggle'));
    const notesRow = container.querySelector('.file-item.folder[data-path="Notes"]');
    const subRow = container.querySelector('.file-item.folder[data-path="Notes/Sub"]');
    const otherRow = container.querySelector('.file-item.folder[data-path="Other"]');
    const rootStrip = container.querySelector('.tree-root-drop-root');
    assert.ok(subRow, 'precondition: Notes/Sub row is visible');

    // A real drag of Notes: dragstart sets the tree-internal dragged-folder
    // state (getData is empty during dragover in real browsers).
    fireDrag(notesRow, 'dragstart', makeDataTransfer());

    for (const [label, el] of [
      ['the folder itself', notesRow],
      ['a descendant', subRow],
      ['its current parent (the root strip)', rootStrip],
    ]) {
      const ev = fireDrag(el, 'dragover', makeDataTransfer());
      assert.equal(el.classList.contains('drop-target'), false, `no highlight on ${label}`);
      assert.equal(ev.dataTransfer.dropEffect, 'none', `dropEffect none on ${label}`);
    }

    // A different folder is still a valid target.
    const ok = fireDrag(otherRow, 'dragover', makeDataTransfer());
    assert.equal(otherRow.classList.contains('drop-target'), true, 'valid target is highlighted');
    assert.equal(ok.dataTransfer.dropEffect, 'move');

    // dragend clears the state — afterwards it is not a folder drag any more.
    fireDrag(notesRow, 'dragend', makeDataTransfer());
    const after = fireDrag(otherRow, 'dragover', makeDataTransfer());
    assert.equal(otherRow.classList.contains('drop-target'), true);
    assert.equal(after.dataTransfer.dropEffect, 'move');
  } finally {
    restore();
  }
});