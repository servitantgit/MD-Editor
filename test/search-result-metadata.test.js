import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { SearchIndex } from '../js/search-index.js';

function compareMetadata(query, body) {
  const index = new SearchIndex(MiniSearch);
  index.add('Notes/example.md', body);
  const raw = index.searcher.search(query);
  const returned = index.query(query);
  assert.equal(raw.length, 1, 'fixture must produce exactly one result');
  assert.equal(returned.length, 1);
  assert.deepEqual(returned[0].terms, raw[0].terms);
  assert.deepEqual(returned[0].queryTerms, raw[0].queryTerms);
  assert.deepEqual(returned[0].match, raw[0].match);
  return returned[0];
}

test('search result metadata: exact result retains terms, queryTerms and matched fields', () => {
  const hit = compareMetadata('printer', 'A printer needs maintenance.');
  assert.deepEqual(hit.terms, ['printer']);
  assert.deepEqual(hit.match, { printer: ['body'] });
});

test('search result metadata: prefix result retains the actual longer token', () => {
  const hit = compareMetadata('print', 'A printing machine.');
  assert.deepEqual(hit.terms, ['printing']);
  assert.deepEqual(hit.queryTerms, ['print']);
});

test('search result metadata: fuzzy result retains the actual different token', () => {
  const hit = compareMetadata('printer', 'A pronter needs maintenance.');
  assert.deepEqual(hit.terms, ['pronter']);
  assert.deepEqual(hit.queryTerms, ['printer']);
});
