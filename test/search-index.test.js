import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import {
  SearchIndex,
  buildDocument,
  buildSnippet,
  createBodyCache,
  createSearchIndex,
  createSearcherOptions,
  diffTree,
  extractTitle,
  isMarkdownPath,
  queryTerms,
  stripMarkdown,
  titleFromPath,
} from '../js/search-index.js';

/** A fresh index, built the way search-sync.js builds one. */
function newIndex() {
  return new SearchIndex(MiniSearch);
}

const NOTES = [
  {
    path: 'Notes/Ideas.md',
    body: '# Ideas\n\nRemember the pancake recipe with blueberries and lemon zest.\n',
  },
  {
    path: 'Notes/Shopping.md',
    body: '# Shopping\n\n- buy milk\n- buy bread\n- buy apples\n',
  },
  {
    path: 'README.md',
    body: 'No heading here, just the word zeppelin in a sentence about airships.\n',
  },
];

function populated() {
  const index = newIndex();
  index.addAll(NOTES);
  return index;
}

test('isMarkdownPath accepts .md in any case and rejects everything else', () => {
  assert.equal(isMarkdownPath('Notes/Ideas.md'), true);
  assert.equal(isMarkdownPath('NOTES/UPPER.MD'), true);
  // Search is markdown-only: images, PDFs and other binaries are never fetched.
  assert.equal(isMarkdownPath('Asset/pic.jpg'), false);
  assert.equal(isMarkdownPath('docs/manual.pdf'), false);
  assert.equal(isMarkdownPath('archive.zip'), false);
  assert.equal(isMarkdownPath('Notes/no-extension'), false);
});

test('title comes from the first heading, or the file name when there is none', () => {
  assert.equal(extractTitle('Notes/Ideas.md', '# Ideas\n\nbody'), 'Ideas');
  assert.equal(extractTitle('Notes/Ideas.md', '## Deeper heading\n\nbody'), 'Deeper heading');
  // An ATX closing sequence is part of the heading text, not content.
  assert.equal(extractTitle('a.md', '# Title ###\n\nbody'), 'Title');
  // No heading at all -> basename without the extension.
  assert.equal(extractTitle('Notes/Shopping.md', 'just a list'), 'Shopping');
  assert.equal(extractTitle('README.md', ''), 'README');
});

test('titleFromPath strips only the .md extension', () => {
  assert.equal(titleFromPath('Notes/My Ideas.md'), 'My Ideas');
  assert.equal(titleFromPath('archive.tar.md'), 'archive.tar');
  assert.equal(titleFromPath('Notes/plain.txt'), 'plain.txt');
});
test('stripMarkdown drops fences and image syntax but keeps link text', () => {
  const md = [
    '# Title',
    '',
    '```js',
    'const secret = 1;',
    '```',
    '',
    '![diagram](assets/diagram.png)',
    '',
    'See [the docs](https://example.com) for details.',
  ].join('\n');

  const text = stripMarkdown(md);
  assert.ok(!text.includes('secret'), `fenced code survived: ${text}`);
  assert.ok(!text.includes('diagram'), `image alt text survived: ${text}`);
  assert.ok(text.includes('the docs'), `link text was lost: ${text}`);
  assert.ok(!text.includes('example.com'), `link target survived: ${text}`);
});

test('stripMarkdown keeps raw HTML — that is why snippets must escape', () => {
  // If this ever starts stripping HTML, the escaping test below becomes
  // vacuous, so keep the two pinned together.
  assert.ok(stripMarkdown('a <script>b</script> c').includes('<script>'));
});

test('query returns the right paths for a fixture of three markdown blobs', () => {
  const index = populated();
  assert.deepEqual(index.query('pancake').map((r) => r.path), ['Notes/Ideas.md']);
  assert.deepEqual(index.query('zeppelin').map((r) => r.path), ['README.md']);
  // AND semantics: both words must appear somewhere in the file.
  assert.deepEqual(index.query('buy milk').map((r) => r.path), ['Notes/Shopping.md']);
  assert.deepEqual(index.query('buy zeppelin'), []);
});

test('prefix and fuzzy matching are both active', () => {
  const index = populated();
  assert.deepEqual(index.query('blueberr').map((r) => r.path), ['Notes/Ideas.md']); // fuzzy
  assert.deepEqual(index.query('blueb').map((r) => r.path), ['Notes/Ideas.md']); // prefix
});

test('a query that matches nothing returns an empty list', () => {
  assert.deepEqual(populated().query('nothingmatchesthis'), []);
});

test('the title and the path are searchable, not just the body', () => {
  const index = populated();
  assert.deepEqual(index.query('Ideas').map((r) => r.path), ['Notes/Ideas.md']);
  assert.deepEqual(index.query('README').map((r) => r.path), ['README.md']);
});

test('results carry the stored fields and honour the limit', () => {
  const index = populated();
  const [hit] = index.query('pancake');
  assert.equal(hit.path, 'Notes/Ideas.md');
  assert.equal(hit.title, 'Ideas');
  assert.equal(typeof hit.score, 'number');
  assert.deepEqual(index.query('pancake', { limit: 0 }), []);
});

test('the body is never stored in the index', () => {
  // This is what keeps the serialized blob small enough for IndexedDB.
  const index = populated();
  assert.deepEqual(index.searcher.getStoredFields('Notes/Ideas.md'), {
    path: 'Notes/Ideas.md',
    title: 'Ideas',
  });
  assert.deepEqual(createSearcherOptions().storeFields, ['path', 'title']);
  assert.ok(!createSearcherOptions().fields.includes('rawBody'));
});

test('an empty or whitespace-only query returns nothing rather than everything', () => {
  const index = populated();
  assert.deepEqual(index.query(''), []);
  assert.deepEqual(index.query('   '), []);
});

test('queryTerms splits a query into lowercase words', () => {
  assert.deepEqual(queryTerms('Buy  MILK\tand bread'), ['buy', 'milk', 'and', 'bread']);
  assert.deepEqual(queryTerms('   '), []);
  assert.deepEqual(queryTerms(null), []);
});
test('the snippet wraps the matched term in <mark>', () => {
  const body = 'Remember the pancake recipe with blueberries and lemon zest.';
  const snippet = buildSnippet(body, 'pancake');
  assert.ok(snippet.includes('<mark>pancake</mark>'), snippet);
  // Context on both sides of the term, not just the term itself.
  const plain = snippet.replace(/<\/?mark>/g, '');
  assert.ok(plain.includes('Remember the'), snippet);
  assert.ok(plain.includes('recipe with'), snippet);
});

test('the snippet ESCAPES html-unsafe neighbours', () => {
  // The body is untrusted and the UI assigns this to innerHTML. If escaping were
  // dropped, "<script>" would execute when a search result is rendered.
  // The unsafe text is placed INSIDE the context window on purpose: outside it,
  // it would be sliced away and this test would pass vacuously.
  const body = 'intro <script>alert(1)</script> needle word right here';
  const snippet = buildSnippet(body, 'needle', { before: 60 });

  assert.ok(snippet.includes('<mark>needle</mark>'), snippet);
  assert.ok(!snippet.includes('<script>'), `raw <script> leaked into the snippet: ${snippet}`);
  assert.ok(snippet.includes('&lt;script&gt;'), snippet);
  // Only our own <mark> tags may be markup in the snippet.
  assert.deepEqual(snippet.match(/<[^>]+>/g) || [], ['<mark>', '</mark>'], snippet);
});

test('escaping also covers the text AFTER the match', () => {
  const snippet = buildSnippet('needle <img src=x onerror=alert(1)> after', 'needle');
  assert.ok(!snippet.includes('<img'), snippet);
  assert.ok(snippet.includes('&lt;img'), snippet);
});

test('the snippet escapes ampersands and quotes too', () => {
  const snippet = buildSnippet('a & b "quoted" needle & more', 'needle');
  assert.ok(!snippet.includes('& b'), snippet);
  assert.ok(snippet.includes('&amp;'), snippet);
  assert.ok(snippet.includes('&quot;'), snippet);
});

test('a term that is not in the body still yields an escaped excerpt', () => {
  const snippet = buildSnippet('<b>bold</b> text with no match here', 'zzzz');
  assert.ok(!snippet.includes('<b>'), snippet);
  assert.ok(snippet.includes('&lt;b&gt;'), snippet);
  assert.ok(!snippet.includes('<mark>'), 'nothing matched, so nothing is highlighted');
});

test('snippet context is bounded on both sides', () => {
  const body = 'x'.repeat(500) + ' needle ' + 'y'.repeat(500);
  const snippet = buildSnippet(body, 'needle').replace(/<\/?mark>/g, '');
  // 15 before + the term + 60 after, plus the two ellipses.
  assert.ok(snippet.length <= 15 + 6 + 60 + 2, `snippet is too long: ${snippet.length}`);
});

test('an empty body produces an empty snippet', () => {
  assert.equal(buildSnippet('', 'anything'), '');
  assert.equal(buildSnippet('   \n\n ', 'anything'), '');
});

test('removeDocument makes a previously-matching file stop appearing', () => {
  const index = populated();
  assert.deepEqual(index.query('pancake').map((r) => r.path), ['Notes/Ideas.md']);

  index.removeDocument('Notes/Ideas.md');

  assert.equal(index.has('Notes/Ideas.md'), false);
  assert.deepEqual(index.query('pancake'), []);
  // The rest of the index is untouched.
  assert.deepEqual(index.query('zeppelin').map((r) => r.path), ['README.md']);
  assert.equal(index.size, 2);
});

test('removing an unknown path is a no-op, not a crash', () => {
  const index = populated();
  index.removeDocument('Notes/Never existed.md');
  index.removeDocument('Asset/pic.jpg');
  assert.equal(index.size, 3);
});

test('removeDocument also drops the cached body', () => {
  const index = populated();
  index.removeDocument('Notes/Ideas.md');
  assert.equal(index.bodyCache.has('Notes/Ideas.md'), false);
});

test('serialize -> deserialize -> query returns the same results as the live index', () => {
  // This is the round-trip pin for the IndexedDB path: search-store.js stores
  // exactly this string and hands it back on the next login.
  const live = populated();
  const serialized = live.serialize();

  assert.equal(typeof serialized, 'string');
  assert.ok(serialized.length > 0);

  const restored = createSearchIndex(MiniSearch, serialized);
  assert.deepEqual(restored.query('pancake'), live.query('pancake'));
  assert.deepEqual(restored.query('zeppelin'), live.query('zeppelin'));
  assert.deepEqual(restored.query('buy milk'), live.query('buy milk'));
  assert.equal(restored.size, live.size);

  // Stored fields survive, otherwise results would render with no title.
  assert.equal(restored.query('pancake')[0].title, 'Ideas');
});

test('a restored index can be updated and removed like a live one', () => {
  const restored = createSearchIndex(MiniSearch, populated().serialize());
  restored.removeDocument('README.md');
  assert.deepEqual(restored.query('zeppelin'), []);

  restored.add('Notes/Added.md', '# Added\n\na brand new needle\n');
  assert.deepEqual(restored.query('needle').map((r) => r.path), ['Notes/Added.md']);
});

test('the serialized index stays small because the body is not stored', () => {
  const index = newIndex();
  index.add('Big.md', '# Big\n\n' + 'lorem ipsum dolor sit amet '.repeat(500));
  const serialized = index.serialize();
  // ~12KB of body text; the serialized index must be nowhere near that.
  assert.ok(serialized.length < 6000, `index unexpectedly large: ${serialized.length} bytes`);
  // ...and it still finds a word from deep inside that body.
  assert.deepEqual(index.query('lorem').map((r) => r.path), ['Big.md']);
});

test('a corrupt serialized blob degrades to an empty index instead of throwing', () => {
  const index = createSearchIndex(MiniSearch, 'this is not a minisearch index');
  assert.equal(index.size, 0);
  assert.deepEqual(index.query('anything'), []);
  // ...and it is still usable afterwards.
  index.add('a.md', '# A\n\ncontent\n');
  assert.deepEqual(index.query('content').map((r) => r.path), ['a.md']);
});

test('createSearchIndex with no serialized blob starts empty', () => {
  const index = createSearchIndex(MiniSearch, null);
  assert.equal(index.size, 0);
});

test('createSearcherOptions does not share mutable state between calls', () => {
  const a = createSearcherOptions();
  const b = createSearcherOptions();
  assert.notEqual(a, b);
  a.fields.push('sneaky');
  assert.deepEqual(createSearcherOptions().fields, ['title', 'path', 'body']);
  assert.deepEqual(b.fields, ['title', 'path', 'body']);
});

test('the store fields exclude the body', () => {
  assert.deepEqual(createSearcherOptions().storeFields, ['path', 'title']);
});

test('the body cache is bounded and evicts the least recently used entry', () => {
  const cache = createBodyCache(2);
  cache.set('a.md', 'A');
  cache.set('b.md', 'B');
  assert.equal(cache.get('a.md'), 'A'); // 'a' is now the most recent

  cache.set('c.md', 'C'); // evicts 'b' (least recently used)

  assert.equal(cache.has('b.md'), false, 'the LRU entry was not evicted');
  assert.equal(cache.has('a.md'), true);
  assert.equal(cache.has('c.md'), true);
  assert.equal(cache.size, 2);
});

test('indexing fills the body cache, clearing empties it', () => {
  const index = populated();
  assert.equal(index.bodyCache.get('Notes/Ideas.md'), NOTES[0].body);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.bodyCache.size, 0);
});

test('diffTree splits added / removed / changed by path', () => {
  const tree = [
    { path: 'a.md', sha: 'sha-a' },
    { path: 'b.md', sha: 'sha-b2' }, // changed
    { path: 'c.md', sha: 'sha-c' }, // added
  ];
  const manifest = {
    'a.md': 'sha-a', // unchanged
    'b.md': 'sha-b1', // changed
    'gone.md': 'sha-gone', // removed
  };

  assert.deepEqual(diffTree(tree, manifest), {
    added: ['c.md'],
    removed: ['gone.md'],
    changed: ['b.md'],
  });
});

test('diffTree against an empty manifest reports everything as added', () => {
  const tree = [{ path: 'a.md', sha: '1' }, { path: 'b/c.md', sha: '2' }];
  assert.deepEqual(diffTree(tree, {}), { added: ['a.md', 'b/c.md'], removed: [], changed: [] });
  assert.deepEqual(diffTree(tree), { added: ['a.md', 'b/c.md'], removed: [], changed: [] });
});

test('diffTree finds nothing to do when nothing changed', () => {
  const tree = [{ path: 'a.md', sha: '1' }];
  assert.deepEqual(diffTree(tree, { 'a.md': '1' }), { added: [], removed: [], changed: [] });
});

test('buildDocument carries the id, path, title and a stripped body', () => {
  const doc = buildDocument('Notes/Ideas.md', '# Ideas\n\n```\nhidden\n```\ntext\n');
  assert.equal(doc.id, 'Notes/Ideas.md');
  assert.equal(doc.path, 'Notes/Ideas.md');
  assert.equal(doc.title, 'Ideas');
  assert.ok(!doc.body.includes('hidden'));
  assert.ok(doc.body.includes('text'));
});

// -------------------------------------------------------------- the diff ---

test('diffTree reports every file as REMOVED for an emptied repository', () => {
  // Caught in a real browser: deleting the last note left the old file in the
  // search results. An empty tree is a legitimate diff input, not a no-op.
  const { added, removed, changed } = diffTree([], { 'only.md': 'sha-1' });
  assert.deepEqual(added, []);
  assert.deepEqual(changed, []);
  assert.deepEqual(removed, ['only.md']);
});
test('add on an already-indexed path replaces the old version', () => {
  const index = populated();
  // The new body must not contain "zeppelin" anywhere — including in a sentence
  // like "no zeppelin here" — or this test proves nothing.
  index.add('README.md', '# Fresh\n\nentirely rewritten without the old term\n');

  assert.deepEqual(index.query('zeppelin'), [], 'the old body is still reachable');
  assert.deepEqual(index.query('Fresh').map((r) => r.path), ['README.md']);
  assert.deepEqual(index.query('rewritten').map((r) => r.path), ['README.md']);
  assert.equal(index.size, 3, 're-adding must not duplicate the document');
  // The title is refreshed from the new body.
  assert.equal(index.query('Fresh')[0].title, 'Fresh');
});

test('updateDocument replaces a note and keeps its body cache fresh', () => {
  const index = populated();
  index.updateDocument('Notes/Ideas.md', '# Ideas\n\nnow it is waffles\n');

  assert.deepEqual(index.query('pancake'), []);
  assert.deepEqual(index.query('waffles').map((r) => r.path), ['Notes/Ideas.md']);
  assert.ok(index.bodyCache.get('Notes/Ideas.md').includes('waffles'));
});

test('updateDocument works for a path that was never indexed', () => {
  const index = populated();
  index.updateDocument('Notes/New.md', '# New\n\nbrand new content\n');
  assert.deepEqual(index.query('brand').map((r) => r.path), ['Notes/New.md']);
  assert.equal(index.size, 4);
});