import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as searchUi from '../js/search-ui.js';

test('formatResultCount: singular and plural', () => {
  assert.equal(searchUi.formatResultCount(1, 1), '1 result');
  assert.equal(searchUi.formatResultCount(12, 12), '12 results');
});

test('formatResultCount: says "N of M" when results were cut', () => {
  assert.equal(searchUi.formatResultCount(50, 73), '50 of 73 results');
  assert.equal(searchUi.formatResultCount(1, 5), '1 of 5 results');
});
