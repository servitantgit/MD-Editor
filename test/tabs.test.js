import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabsModel, tabLabels, tabsStorageKey } from '../js/tabs.js';

const model = (paths, active = null) => new TabsModel(paths, active);

test('open adds at the end once and never changes the active tab', () => {
  const m = model(['a.md'], 'a.md');
  assert.equal(m.open('b.md'), true);
  assert.equal(m.open('b.md'), false, 'a path is never opened twice');
  assert.equal(m.open(''), false);
  assert.deepEqual(m.paths, ['a.md', 'b.md']);
  assert.equal(m.active, 'a.md');
});

test('constructor drops duplicates and an active path that is not a tab', () => {
  const m = model(['a.md', 'a.md', 'b.md'], 'zzz.md');
  assert.deepEqual(m.paths, ['a.md', 'b.md']);
  assert.equal(m.active, null);
});

test('activate only accepts open tabs', () => {
  const m = model(['a.md', 'b.md']);
  assert.equal(m.activate('b.md'), true);
  assert.equal(m.active, 'b.md');
  assert.equal(m.activate('nope.md'), false);
  assert.equal(m.active, 'b.md');
});

test('closing the active tab hands over to the right neighbour, else the left one', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'b.md');
  assert.deepEqual(m.close('b.md'), { closed: true, wasActive: true, next: 'c.md' });
  assert.deepEqual(m.close('c.md'), { closed: true, wasActive: true, next: 'a.md' });
  assert.deepEqual(m.close('a.md'), { closed: true, wasActive: true, next: null });
  assert.equal(m.active, null);
  assert.equal(m.size, 0);
});

test('closing a background tab leaves the active one alone', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'c.md');
  assert.deepEqual(m.close('a.md'), { closed: true, wasActive: false, next: 'c.md' });
  assert.equal(m.active, 'c.md');
  assert.deepEqual(m.close('missing.md'), { closed: false, wasActive: false, next: 'c.md' });
});

test('rename keeps the tab where it was and follows the active flag', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'b.md');
  assert.equal(m.rename('b.md', 'x/b.md'), true);
  assert.deepEqual(m.paths, ['a.md', 'x/b.md', 'c.md']);
  assert.equal(m.active, 'x/b.md');
  assert.equal(m.rename('nope.md', 'y.md'), false);
  assert.equal(m.rename('a.md', 'a.md'), false);
});

test('rename onto a path that already has a tab merges the two', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'a.md');
  m.rename('a.md', 'c.md'); // a move that replaced c.md
  assert.deepEqual(m.paths, ['b.md', 'c.md']);
  assert.equal(m.active, 'c.md');
});

test('renameFolder moves every tab inside it and nothing else', () => {
  const m = model(['Notes/a.md', 'Notes/sub/b.md', 'Notes2/c.md', 'd.md'], 'Notes/sub/b.md');
  const changed = m.renameFolder('Notes', 'Docs');
  assert.deepEqual(changed, [['Notes/a.md', 'Docs/a.md'], ['Notes/sub/b.md', 'Docs/sub/b.md']]);
  assert.deepEqual(m.paths, ['Docs/a.md', 'Docs/sub/b.md', 'Notes2/c.md', 'd.md']);
  assert.equal(m.active, 'Docs/sub/b.md');
});

test('removeUnder closes the tabs of a deleted folder and leaves a valid active tab', () => {
  const m = model(['Notes/a.md', 'Notes/b.md', 'keep.md'], 'Notes/a.md');
  assert.deepEqual(m.removeUnder('Notes'), ['Notes/a.md', 'Notes/b.md']);
  assert.deepEqual(m.paths, ['keep.md']);
  assert.equal(m.active, 'keep.md');
  assert.deepEqual(m.removeUnder('Nothing'), []);
});

test('removeUnder does not treat a name prefix as a folder ("Notes" is not "Notes2")', () => {
  const m = model(['Notes2/a.md'], 'Notes2/a.md');
  assert.deepEqual(m.removeUnder('Notes'), []);
  assert.equal(m.size, 1);
});

test('retainWhere drops tabs for files that no longer exist', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'b.md');
  const dropped = m.retainWhere((p) => p !== 'b.md');
  assert.deepEqual(dropped, ['b.md']);
  assert.deepEqual(m.paths, ['a.md', 'c.md']);
  assert.equal(m.active, 'c.md');
});

test('toJSON / fromJSON round-trip, filtering what no longer exists', () => {
  const m = model(['a.md', 'b.md', 'c.md'], 'b.md');
  const back = TabsModel.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), (p) => p !== 'c.md');
  assert.deepEqual(back.paths, ['a.md', 'b.md']);
  assert.equal(back.active, 'b.md');
  const gone = TabsModel.fromJSON(m.toJSON(), (p) => p !== 'b.md');
  assert.equal(gone.active, null, 'the active tab vanished, so nothing is active');
});

test('fromJSON survives garbage in sessionStorage', () => {
  for (const junk of [null, undefined, 42, 'x', {}, { paths: 'a.md' }, { paths: [1, null, {}], active: 7 }]) {
    const m = TabsModel.fromJSON(junk);
    assert.deepEqual(m.paths, [], String(JSON.stringify(junk)));
    assert.equal(m.active, null);
  }
});

test('tabLabels: unique names stay short', () => {
  const l = tabLabels(['Notes/a.md', 'Docs/b.md', 'c.md']);
  assert.equal(l.get('Notes/a.md'), 'a.md');
  assert.equal(l.get('Docs/b.md'), 'b.md');
  assert.equal(l.get('c.md'), 'c.md');
});

test('tabLabels: identical names get just enough parent folders to differ', () => {
  const l = tabLabels(['a/notes.md', 'b/notes.md', 'x/y/todo.md', 'x/z/todo.md', 'solo.md']);
  assert.equal(l.get('a/notes.md'), 'a/notes.md');
  assert.equal(l.get('b/notes.md'), 'b/notes.md');
  assert.equal(l.get('x/y/todo.md'), 'y/todo.md');
  assert.equal(l.get('x/z/todo.md'), 'z/todo.md');
  assert.equal(l.get('solo.md'), 'solo.md');
});

test('tabLabels: terminates and stays unique when one path is the tail of another', () => {
  const l = tabLabels(['notes.md', 'a/notes.md', 'a/b/notes.md']);
  assert.equal(new Set(l.values()).size, 3);
  assert.equal(l.get('notes.md'), 'notes.md');
  assert.equal(l.get('a/notes.md'), 'a/notes.md');
  assert.equal(l.get('a/b/notes.md'), 'b/notes.md', 'only as long as needed to be unique');
});

test('tabsStorageKey separates repositories and branches', () => {
  assert.notEqual(tabsStorageKey('o', 'r', 'main'), tabsStorageKey('o', 'r', 'dev'));
  assert.notEqual(tabsStorageKey('o', 'r', 'main'), tabsStorageKey('o', 'r2', 'main'));
});
