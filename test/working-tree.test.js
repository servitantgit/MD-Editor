import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkingTree } from '../js/working-tree.js';

test('workingTree.rename moves the dirty entry from old path to new path', () => {
  const wt = new WorkingTree();
  wt.setDirty('old.md', 'local text', 'sha-old');
  assert.equal(wt.isDirty('old.md'), true);
  assert.equal(wt.isDirty('new.md'), false);
  assert.equal(wt.getChangeCount(), 1);

  wt.rename('old.md', 'new.md');

  assert.equal(wt.isDirty('old.md'), false, 'old path no longer dirty');
  assert.equal(wt.isDirty('new.md'), true, 'new path is dirty');
  assert.equal(wt.getChangeCount(), 1, 'still one dirty entry');
  const entry = wt.get('new.md');
  assert.equal(entry.text, 'local text', 'text carried over');
  assert.equal(entry.baseSha, 'sha-old', 'baseSha carried over');
});

test('workingTree.rename is a no-op when old path is not dirty', () => {
  const wt = new WorkingTree();
  wt.setDirty('other.md', 'text', 'sha-1');
  wt.rename('nonexistent.md', 'new.md');
  assert.equal(wt.isDirty('nonexistent.md'), false);
  assert.equal(wt.isDirty('new.md'), false, 'no new entry created');
  assert.equal(wt.getChangeCount(), 1, 'only the original dirty entry remains');
  assert.equal(wt.isDirty('other.md'), true, 'other entry untouched');
});

test('workingTree.rename to an already-dirty new path overwrites it', () => {
  const wt = new WorkingTree();
  wt.setDirty('a.md', 'text-a', 'sha-a');
  wt.setDirty('b.md', 'text-b', 'sha-b');
  wt.rename('a.md', 'b.md');
  assert.equal(wt.isDirty('a.md'), false);
  assert.equal(wt.isDirty('b.md'), true);
  assert.equal(wt.get('b.md').text, 'text-a', 'renamed entry overwrote existing');
  assert.equal(wt.getChangeCount(), 1);
});

test('workingTree.statusMap and listChanges reflect renamed paths', () => {
  const wt = new WorkingTree();
  wt.setDirty('Notes/a.md', 'text-a', 'sha-a');
  wt.setDirty('Notes/b.md', 'text-b', null); // newly added
  wt.rename('Notes/a.md', 'Docs/a.md');

  const map = wt.statusMap();
  assert.equal(map['Docs/a.md'], 'M');
  assert.equal(map['Notes/a.md'], undefined);
  assert.equal(map['Notes/b.md'], 'A');

  const changes = wt.listChanges();
  assert.deepEqual(changes.map((c) => c.path).sort(), ['Docs/a.md', 'Notes/b.md']);
});
