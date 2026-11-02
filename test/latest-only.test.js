import { test } from 'node:test';
import assert from 'node:assert/strict';

// Imported inside every test: until js/latest-only.js exists each test fails
// on its own (ERR_MODULE_NOT_FOUND) instead of the whole file failing to load.
const load = () => import('../js/latest-only.js');

function deferred() {
  let resolve;
  let reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}

// loadTree() is called from many places; a slow older response must not
// overwrite the tree a newer call has already loaded.
test('latest-only: a slower earlier call that lands after a newer one is stale', async () => {
  const { createLatestOnly } = await load();
  const run = createLatestOnly();
  const a = deferred();
  const b = deferred();
  const ra = run(() => a.p);
  const rb = run(() => b.p);
  b.resolve('new');
  a.resolve('old');
  assert.deepEqual(await rb, { stale: false, value: 'new' });
  assert.deepEqual(await ra, { stale: true });
});

test('latest-only: a single call is fresh and carries its value', async () => {
  const { createLatestOnly } = await load();
  const run = createLatestOnly();
  assert.deepEqual(await run(async () => 42), { stale: false, value: 42 });
});

test('latest-only: calls that do not overlap are both fresh', async () => {
  const { createLatestOnly } = await load();
  const run = createLatestOnly();
  assert.deepEqual(await run(async () => 'first'), { stale: false, value: 'first' });
  assert.deepEqual(await run(async () => 'second'), { stale: false, value: 'second' });
});

test('latest-only: an error of a stale call is ignored, an error of the latest call is thrown', async () => {
  const { createLatestOnly } = await load();
  const run = createLatestOnly();
  const a = deferred();
  const b = deferred();
  const ra = run(() => a.p);
  const rb = run(() => b.p);
  a.reject(new Error('old failed'));
  assert.deepEqual(await ra, { stale: true });
  b.reject(new Error('new failed'));
  await assert.rejects(rb, /new failed/);
});
