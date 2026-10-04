import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  DraftStore,
  TTL_MS,
  draftKey,
  scopePrefix,
} from '../js/draft-store.js';

/** A store on a private fake database, with a clock the test moves by hand. */
function newStore({ now = () => 1_000_000, indexedDB = new IDBFactory(), ...rest } = {}) {
  return new DraftStore({ indexedDB, now, ...rest });
}

const SCOPE = { owner: 'owner', repo: 'repo', branch: 'main' };
const draft = (path, text, extra = {}) => ({ ...SCOPE, path, text, ...extra });

test('draftKey is owner/repo@branch:path, defaulting the branch to HEAD', () => {
  assert.equal(draftKey('o', 'r', 'main', 'Notes/a.md'), 'o/r@main:Notes/a.md');
  assert.equal(draftKey('o', 'r', '', 'a.md'), 'o/r@HEAD:a.md');
  assert.equal(draftKey('o', 'r', null, 'a.md'), 'o/r@HEAD:a.md');
  assert.equal(scopePrefix('o', 'r', 'main'), 'o/r@main:');
});

test('drafts live in their own database, not in the search index one', () => {
  // Two INDEPENDENT databases on purpose: the index is derived from GitHub and
  // can be rebuilt at will, a draft is the only copy of the user's unsaved text.
  assert.equal(DB_NAME, 'md-editor-drafts');
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, 'drafts');
});

test('put then get round-trips text, baseSha, dirty and the stamped clock', async () => {
  const store = newStore();
  assert.equal(await store.put(draft('Notes/a.md', '# Draft', { baseSha: 'sha-1' })), true);

  const loaded = await store.get(SCOPE_PATH('Notes/a.md'));
  assert.ok(loaded, 'the draft was not stored');
  assert.equal(loaded.text, '# Draft');
  assert.equal(loaded.baseSha, 'sha-1');
  assert.equal(loaded.dirty, true);
  assert.equal(loaded.path, 'Notes/a.md');
  assert.equal(loaded.savedAt, 1_000_000, 'savedAt comes from the injected clock');
});

function SCOPE_PATH(path) {
  return { ...SCOPE, path };
}

test('two paths in the same file are two different drafts', async () => {
  const store = newStore();
  await store.put(draft('a.md', 'TEXT-A', { baseSha: 'sha-a' }));
  await store.put(draft('b.md', 'TEXT-B', { baseSha: 'sha-b' }));

  assert.equal((await store.get(SCOPE_PATH('a.md'))).text, 'TEXT-A');
  assert.equal((await store.get(SCOPE_PATH('b.md'))).text, 'TEXT-B');
  assert.equal((await store.get(SCOPE_PATH('c.md'))), null, 'an unknown path must read as null');
});

test('the same repo on another branch does not surface these drafts', async () => {
  // Switching branches must not resurrect the other branch's half-written text.
  const store = newStore();
  await store.put(draft('a.md', 'MAIN-TEXT', { baseSha: 'sha-main' }));
  await store.put({ ...SCOPE, branch: 'dev', path: 'a.md', text: 'DEV-TEXT', baseSha: 'sha-dev' });

  assert.equal((await store.get(SCOPE_PATH('a.md'))).text, 'MAIN-TEXT');
  assert.equal((await store.get({ ...SCOPE, branch: 'dev', path: 'a.md' })).text, 'DEV-TEXT');
});

test('another repository keeps its own drafts', async () => {
  const store = newStore();
  await store.put(draft('a.md', 'MINE'));
  await store.put({ owner: 'someone', repo: 'elsewhere', branch: 'main', path: 'a.md', text: 'THEIRS' });

  assert.equal((await store.get(SCOPE_PATH('a.md'))).text, 'MINE');
  assert.equal(
    (await store.get({ owner: 'someone', repo: 'elsewhere', branch: 'main', path: 'a.md' })).text,
    'THEIRS'
  );
});

test('sweepStaleDrafts drops what is too old OR no longer in the tree', async () => {
  let clock = 10_000_000;
  const store = newStore({ now: () => clock });

  clock -= TTL_MS + 10_000;
  await store.put(draft('ancient.md', 'OLDER THAN THE TTL'));
  clock += 5_000;
  await store.put(draft('deleted.md', 'GONE FROM THE TREE'));
  clock += 5_000;
  await store.put(draft('kept.md', 'FRESH'));

  const swept = await store.sweepStaleDrafts(['kept.md'], clock, SCOPE);

  assert.equal(swept, 2, 'exactly the unknown path and the expired one go');
  assert.ok(await store.get(SCOPE_PATH('kept.md')), 'a current draft must survive');
  assert.equal(await store.get(SCOPE_PATH('deleted.md')), null, 'a path not in the tree is not recoverable');
  assert.equal(await store.get(SCOPE_PATH('ancient.md')), null, 'a draft past the 30-day TTL is not recoverable');
});

test('a draft one second inside the TTL is kept', async () => {
  const now = 10_000_000;
  const store = newStore({ now: () => now });
  await store.put(draft('a.md', 'RECENT'));

  const swept = await store.sweepStaleDrafts(['a.md'], now + TTL_MS - 1000, SCOPE);
  assert.equal(swept, 0);
  assert.ok(await store.get(SCOPE_PATH('a.md')), 'the TTL boundary must not eat a day-old draft');
});

test("a scoped sweep never touches another repository's drafts", async () => {
  const store = newStore();
  await store.put(draft('mine.md', 'MINE'));
  await store.put({ owner: 'someone', repo: 'elsewhere', branch: 'main', path: 'theirs.md', text: 'THEIRS' });

  // Signing into another repo must not delete the work of the repo you left.
  const swept = await store.sweepStaleDrafts([], Date.now(), SCOPE);

  assert.equal(swept, 1, 'only the draft whose path is unknown to this tree is swept');
  assert.ok(
    await store.get({ owner: 'someone', repo: 'elsewhere', branch: 'main', path: 'theirs.md' }),
    "another repository's draft was deleted by an unrelated sweep"
  );
});

test('drafts survive a store restart — that is the whole point of IndexedDB', async () => {
  const idb = new IDBFactory();
  const first = newStore({ indexedDB: idb, now: () => 500 });
  await first.put(draft('a.md', 'SURVIVED', { baseSha: 'sha-a' }));
  first.close();

  // A brand new store over the same database, as after a page reload — this is
  // exactly the crash-recovery path.
  const second = newStore({ indexedDB: idb, now: () => 600 });
  const loaded = await second.get(SCOPE_PATH('a.md'));
test('a successful commit deletes the draft rather than clearing the flag', async () => {
  const store = newStore();
  await store.put(draft('a.md', 'TEXT'));
  await store.delete(SCOPE_PATH('a.md'));
  assert.equal(await store.get(SCOPE_PATH('a.md')), null);
});

test('without IndexedDB the store degrades to memory instead of throwing', async () => {
  const reasons = [];
  const store = new DraftStore({ onDegrade: (r) => reasons.push(r) });
  // A real browser without IndexedDB (private window, Safari ITP, disabled
  // storage): autosave must keep working for the session.
  store.backend.idb = null;

  assert.equal(await store.open(), false);
  assert.equal(store.degraded, true);
  assert.ok(reasons.includes('no-indexeddb'), reasons.join('|'));

  await store.put(draft('a.md', 'IN MEMORY'));
  assert.equal((await store.get(SCOPE_PATH('a.md'))).text, 'IN MEMORY');
  assert.equal(store.persistent, false);
});

test('degradation is sticky: a second open() does not re-open the database', async () => {
  const store = new DraftStore({ indexedDB: null });
  await store.open();
  assert.equal(store.degraded, true);

  let reopened = 0;
  store.backend._openDb = () => { reopened++; return Promise.resolve(null); };

  assert.equal(await store.open(), false);
  assert.equal(await store.open(), false);
  assert.equal(reopened, 0, 'a degraded store must stop asking for a database');
});

test('an open() that throws degrades rather than rejecting', async () => {
  const reasons = [];
  const store = new DraftStore({ indexedDB: new IDBFactory(), onDegrade: (r) => reasons.push(r) });
  store.backend.idb = { open() { throw new Error('storage disabled'); } };

  assert.equal(await store.open(), false);
  assert.ok(reasons.some((r) => r.includes('storage disabled')), reasons.join('|'));
});

test('a quota error evicts the oldest OTHER repository draft and retries once', async () => {
  let clock = 1_000;
  const store = newStore({ now: () => clock });
  await store.open();
  await store.put({ owner: 'other', repo: 'repo', branch: 'main', path: 'old.md', text: 'OLD' });
  clock += 5_000;
  await store.put(draft('keep.md', 'KEEP'));

  // Make the NEXT write fail with a quota error exactly once.
  const realTx = store.backend._tx.bind(store.backend);
  let failing = true;
  store.backend._tx = async (mode, fn) => {
    if (mode === 'readwrite' && failing) {
      failing = false;
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return realTx(mode, fn);
  };

  assert.equal(await store.put(draft('big.md', 'BIG')), true);
  assert.equal((await store.get(SCOPE_PATH('big.md'))).text, 'BIG');
  assert.ok(await store.get(SCOPE_PATH('keep.md')), 'the scope being edited is untouchable');
  assert.equal(
    await store.get({ owner: 'other', repo: 'repo', branch: 'main', path: 'old.md' }),
    null,
    'the other repository made way'
  );
  assert.equal(store.degraded, false, 'a single quota error must not degrade the session');
});

test('a persistent quota error degrades to memory rather than throwing', async () => {
  const reasons = [];
  const store = newStore({ onDegrade: (r) => reasons.push(r) });
  await store.open();

  const realTx = store.backend._tx.bind(store.backend);
  store.backend._tx = async (mode, fn) => {
    if (mode === 'readwrite') {
      const err = new Error('quota exhausted');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return realTx(mode, fn);
  };

  await store.put(draft('a.md', 'TOOBIG'));

  assert.equal(store.degraded, true);
  assert.ok(reasons.some((r) => r.startsWith('quota:')), reasons.join('|'));
  assert.equal((await store.get(SCOPE_PATH('a.md'))).text, 'TOOBIG', 'the session still works');
});
  assert.equal(loaded.text, 'SURVIVED');
  assert.equal(loaded.baseSha, 'sha-a');
});