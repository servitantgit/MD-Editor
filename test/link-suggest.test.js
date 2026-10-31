import { test } from 'node:test';
import assert from 'node:assert/strict';

// Imported inside every test: until js/link-suggest.js exists each test fails
// on its own (ERR_MODULE_NOT_FOUND) instead of the whole file failing to load.
const load = () => import('../js/link-suggest.js');

test('buildFileLink: a root-absolute link with the .md stripped from the name', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/b.md'), '[b](/Notes/b.md)');
});

test('buildFileLink: a path with spaces goes into angle brackets', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('AI corrected/SSAM 1 - 2/Lasery Hood.md'), '[Lasery Hood](</AI corrected/SSAM 1 - 2/Lasery Hood.md>)');
});

test('buildFileLink: a path with parentheses goes into angle brackets', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/a (1).md'), '[a (1)](</Notes/a (1).md>)');
});

test('buildFileLink: a non-.md file keeps its extension in the name', async () => {
  const { buildFileLink } = await load();
  assert.equal(buildFileLink('Notes/image.png'), '[image.png](/Notes/image.png)');
});

test('rankLinkSuggestions: name prefix, then name contains, then path only; .md first', async () => {
  const { rankLinkSuggestions } = await load();
  const files = ['Archive/pan/notes.md', 'Recipes/pancakes.md', 'Recipes/crepe-pan.md', 'pan.png'];
  assert.deepEqual(rankLinkSuggestions(files, 'pan'), [
    'Recipes/pancakes.md',
    'pan.png',
    'Recipes/crepe-pan.md',
    'Archive/pan/notes.md',
  ]);
});

test('rankLinkSuggestions: ignores case, accepts {path} objects, drops files without a match', async () => {
  const { rankLinkSuggestions } = await load();
  const files = [{ path: 'Notes/Ideas.md', sha: 'x' }, { path: 'Notes/b.md', sha: 'y' }];
  assert.deepEqual(rankLinkSuggestions(files, 'IDEA'), ['Notes/Ideas.md']);
});

test('rankLinkSuggestions: an empty query lists files by the same order, cut to the limit', async () => {
  const { rankLinkSuggestions } = await load();
  const files = ['b/long/path/x.md', 'a.md', 'c.png'];
  assert.deepEqual(rankLinkSuggestions(files, '', 2), ['a.md', 'b/long/path/x.md']);
});

test('rankLinkSuggestions: within the same group a shorter path comes first', async () => {
  const { rankLinkSuggestions } = await load();
  assert.deepEqual(rankLinkSuggestions(['Deep/Folder/note.md', 'note.md'], 'note'), ['note.md', 'Deep/Folder/note.md']);
});
