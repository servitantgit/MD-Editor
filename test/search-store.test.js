import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  SearchStore,
  TTL_MS,
  recordKey,
} from '../js/search-store.js';

/** A store on a private fake database, with a controllable clock. */
function newStore({ now = () => 1_000_000 } = {}) {
  return new SearchStore({ indexedDB: new IDBFactory(), now });
}

const KEY = recordKey('owner', 'repo', 'main');
const OTHER_KEY = recordKey('someone', 'elsewhere', 'main');

test('recordKey is owner/repo@branch, defaulting the branch to HEAD', () => {
  assert.equal(recordKey('o', 'r', 'main'), 'o/r@main');
  assert.equal(recordKey('o', 'r', ''), 'o/r@HEAD');
  assert.equal(recordKey('o', 'r', null), 'o/r@HEAD');
  assert.equal(recordKey('o', 'r', undefined), 'o/r@HEAD');
});

test('the database shape is the one the task pins', () => {
  assert.equal(DB_NAME, 'md-editor-search');
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, 'indexes');
});

test('put then get round-trips the record for a specific key', async () => {
  const store = newStore();
  const record = {
    key: KEY,
    serializedIndex: '{"invertedIndex":{}}',
    manifest: { 'Notes/a.md': 'sha-a', 'README.md': 'sha-readme' },
  };

  assert.equal(await store.put(record), true);
  const loaded = await store.get(KEY);

  assert.ok(loaded, 'the record was not stored');
  assert.equal(loaded.key, KEY);
  assert.equal(loaded.serializedIndex, record.serializedIndex);
  assert.deepEqual(loaded.manifest, record.manifest);
  assert.equal(loaded.savedAt, 1_000_000, 'savedAt is stamped from the injected clock');
});

test('a record for a different repo does not leak into this one', async () => {
  const store = newStore();
  await store.put({ key: KEY, serializedIndex: 'INDEX-A', manifest: { 'a.md': 'sha-a' } });
  await store.put({ key: OTHER_KEY, serializedIndex: 'INDEX-B', manifest: { 'b.md': 'sha-b' } });

  const first = await store.get(KEY);
  const second = await store.get(OTHER_KEY);

  assert.equal(first.serializedIndex, 'INDEX-A');
  assert.equal(second.serializedIndex, 'INDEX-B');
  assert.deepEqual(Object.keys(first.manifest), ['a.md']);

  // An unknown key must read as null, not as some other repository's record.
  assert.equal(await store.get(recordKey('nobody', 'nothing', 'main')), null);
});

test('the same repo on a different branch is a different record', async () => {
  const store = newStore();
  await store.put({ key: recordKey('o', 'r', 'main'), serializedIndex: 'MAIN' });
  await store.put({ key: recordKey('o', 'r', 'dev'), serializedIndex: 'DEV' });

  assert.equal((await store.get(recordKey('o', 'r', 'main'))).serializedIndex, 'MAIN');
  assert.equal((await store.get(recordKey('o', 'r', 'dev'))).serializedIndex, 'DEV');
});

test('put overwrites the previous record for the same key', async () => {
  const store = newStore();
  await store.put({ key: KEY, serializedIndex: 'OLD', manifest: { 'a.md': '1' } });
  await store.put({ key: KEY, serializedIndex: 'NEW', manifest: { 'b.md': '2' } });

  const loaded = await store.get(KEY);
  assert.equal(loaded.serializedIndex, 'NEW');
  assert.deepEqual(Object.keys(loaded.manifest), ['b.md']);
  assert.equal((await store.all()).length, 1, 'overwriting must not leave a second record');
});

test('get on a store that was never written to returns null', async () => {
  const store = newStore();
  assert.equal(await store.get('nothing/here@main'), null);
});

test('delete removes a record', async () => {
  const store = newStore();
test('TTL eviction removes a record older than 30 days', async () => {
  // A repository deleted on GitHub must not leave an index behind forever.
  const NOW = 1_700_000_000_000;
  let clock = NOW;
  const store = new SearchStore({ indexedDB: new IDBFactory(), now: () => clock });

  await store.open(); // the sweep runs on open, with nothing stored yet
  await store.put({ key: KEY, serializedIndex: 'OLD' });

  clock = NOW + TTL_MS + 1000; // 30 days + a second later
  const evicted = await store.evictExpired();

  assert.equal(evicted, 1);
  assert.equal(await store.get(KEY), null);
});

test('opening a store later than the TTL evicts the stale record', async () => {
  const NOW = 1_700_000_000_000;
  const idb = new IDBFactory();
  const first = new SearchStore({ indexedDB: idb, now: () => NOW });
  await first.put({ key: KEY, serializedIndex: 'OLD' });
  first.close();

  // A fresh page load 31 days later: open() itself sweeps the record away.
  const later = new SearchStore({ indexedDB: idb, now: () => NOW + TTL_MS + 1000 });
  assert.equal(await later.open(), true);
  assert.equal(await later.get(KEY), null);
});

test('TTL eviction keeps records inside the 30-day window', async () => {
  const NOW = 1_700_000_000_000;
  let clock = NOW;
  const store = new SearchStore({ indexedDB: new IDBFactory(), now: () => clock });

  await store.open();
  await store.put({ key: KEY, serializedIndex: 'RECENT' });

  clock = NOW + TTL_MS - 1000; // 29 days and 23:59:59 later
  assert.equal(await store.evictExpired(), 0);
  assert.equal((await store.get(KEY)).serializedIndex, 'RECENT');
});

test('evictExpired removes the stale record and keeps the fresh one', async () => {
  const NOW = 1_700_000_000_000;
  let clock = NOW;
  const store = new SearchStore({ indexedDB: new IDBFactory(), now: () => clock });

  await store.open();
  await store.put({ key: OTHER_KEY, serializedIndex: 'STALE' });

  // The clock jumps past the TTL, then a NEW record is written for this repo.
  clock = NOW + TTL_MS + 5000;
  await store.put({ key: KEY, serializedIndex: 'FRESH' });

  assert.equal(await store.evictExpired(), 1);
  assert.equal(await store.get(OTHER_KEY), null, 'the stale record should be gone');
  assert.equal((await store.get(KEY)).serializedIndex, 'FRESH', 'the fresh record must survive');
});

test('evictOldest drops the oldest record of ANOTHER repo, never the one being saved', async () => {
  const store = newStore({ now: () => 1000 });
  await store.put({ key: OTHER_KEY, serializedIndex: 'OLDER', savedAt: 1 });
  await store.put({ key: recordKey('third', 'party', 'main'), serializedIndex: 'NEWER' });

  const evicted = await store.evictOldest(KEY);

  assert.equal(evicted, true);
  assert.equal(await store.get(OTHER_KEY), null, 'the oldest foreign record was not dropped');
  assert.ok(await store.get(recordKey('third', 'party', 'main')));
});

test('evictOldest returns false when the only record is the one being saved', async () => {
  const store = newStore();
test('with no indexedDB at all the store degrades to memory and says so', async () => {
  // A private window / Safari ITP: indexedDB.open can be missing or throw.
  // Search must still WORK for the session — only persistence is lost.
  const reasons = [];
  const store = new SearchStore({
    indexedDB: undefined,
    onDegrade: (reason) => reasons.push(reason),
  });

  assert.equal(await store.open(), false);
  assert.equal(store.degraded, true);
  assert.equal(store.persistent, false);
  assert.deepEqual(reasons, ['no-indexeddb']);

  // The in-memory fallback still round-trips.
  await store.put({ key: KEY, serializedIndex: 'MEM', manifest: { 'a.md': '1' } });
  assert.equal((await store.get(KEY)).serializedIndex, 'MEM');
});

test('a throwing indexedDB.open degrades instead of propagating', async () => {
  const reasons = [];
  const store = new SearchStore({
    indexedDB: {
      open() { throw new DOMException('denied', 'SecurityError'); },
    },
    onDegrade: (r) => reasons.push(r),
  });

  assert.equal(await store.open(), false);
  assert.equal(store.degraded, true);
  assert.ok(reasons.length === 1, 'the UI must be told exactly once');
});

test('a quota error frees another repo record and retries once', async () => {
  // A 10k-file repo can push the serialized index past the origin quota.
  let failing = true;
  const store = newStore({ now: () => 1000 });
  await store.put({ key: OTHER_KEY, serializedIndex: 'OTHER', savedAt: 1 });

  // Make the NEXT write fail with a quota error exactly once.
  const realTx = store._tx.bind(store);
  store._tx = async (mode, fn) => {
    if (mode === 'readwrite' && failing) {
      failing = false;
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return realTx(mode, fn);
  };

  const ok = await store.put({ key: KEY, serializedIndex: 'BIG' });

  assert.equal(ok, true, 'the retry after eviction should have succeeded');
  assert.equal((await store.get(KEY)).serializedIndex, 'BIG');
  assert.equal(await store.get(OTHER_KEY), null, 'the other repo made way');
  assert.equal(store.degraded, false, 'a single quota error must not degrade the session');
});

test('a persistent quota error degrades to memory rather than throwing', async () => {
  const reasons = [];
  const store = new SearchStore({ indexedDB: new IDBFactory(), onDegrade: (r) => reasons.push(r) });
  await store.open();

  // Only WRITES fail — reads keep working, which is what makes this a quota
  // problem rather than a dead database.
  const realTx = store._tx.bind(store);
  store._tx = async (mode, fn) => {
    if (mode === 'readwrite') {
      const err = new Error('quota exhausted');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return realTx(mode, fn);
  };

  await store.put({ key: KEY, serializedIndex: 'TOOBIG', manifest: { 'a.md': 'sha-a' } });

  assert.equal(store.degraded, true);
  assert.ok(reasons.some((r) => r.startsWith('quota:')), reasons.join('|'));
  // ...and the session keeps working from memory.
  const loaded = await store.get(KEY);
  assert.equal(loaded.serializedIndex, 'TOOBIG');
  assert.deepEqual(loaded.manifest, { 'a.md': 'sha-a' });
});

test('records survive a store restart (that is the whole point of IndexedDB)', async () => {
  const idb = new IDBFactory();
  const first = new SearchStore({ indexedDB: idb, now: () => 500 });
  await first.put({ key: KEY, serializedIndex: 'PERSISTED', manifest: { 'a.md': 'sha-a' } });
  first.close();

  // A brand new store over the same database, as after a page reload.
  const second = new SearchStore({ indexedDB: idb, now: () => 600 });
  const loaded = await second.get(KEY);
  assert.equal(loaded.serializedIndex, 'PERSISTED');
  assert.deepEqual(loaded.manifest, { 'a.md': 'sha-a' });
});

test('open() is idempotent and concurrent callers share one open', async () => {
  const store = newStore();
  const [a, b, c] = await Promise.all([store.open(), store.open(), store.open()]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(await store.open(), true, 'a second call must not reopen');
});

test('a record whose manifest is empty still round-trips', async () => {
  // The diff produces exactly this when a repo has no .md files at all.
  const store = newStore();
  await store.put({ key: KEY, serializedIndex: '{}', manifest: {} });
  const loaded = await store.get(KEY);
  assert.deepEqual(loaded.manifest, {});
  assert.equal(loaded.serializedIndex, '{}');
});
  await store.put({ key: KEY, serializedIndex: 'ONLY' });
  assert.equal(await store.evictOldest(KEY), false);
  assert.ok(await store.get(KEY), 'evictOldest must never delete the key it is protecting');
});
  await store.put({ key: KEY, serializedIndex: 'X' });
  await store.delete(KEY);
  assert.equal(await store.get(KEY), null);
});