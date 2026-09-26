import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTreeStructure } from '../js/file-tree.js';

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
