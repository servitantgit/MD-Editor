import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave, STATE, STATUS, IDLE_MS, LOCAL_WRITE_DEBOUNCE_MS } from '../js/autosave.js';
import { DraftStore } from '../js/draft-store.js';

const SCOPE = { owner: 'o', repo: 'r', branch: 'main' };
const ref = (path) => ({ ...SCOPE, path });

function fixture() {
  // Real DraftStore in session-only mode; fake timers must not drive IDB.
  const store = new DraftStore({ indexedDB: null });
  const statuses = [];
  const commits = [];
  const puts = [];
  const autosave = new Autosave({
    ...SCOPE, store,
    client: { putFile: async (...args) => { puts.push(args); throw new Error('unexpected push'); } },
    getText: () => autosave._text,
    onStatus: (status) => statuses.push(status),
    onRemoteCommit: (...args) => commits.push(args)
  });
  return { store, autosave, statuses, commits, puts };
}

function timed(fn) {
  return async () => {
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    try {
      assert.equal(typeof f.autosave.confirmSnapshot, 'function', 'confirmSnapshot must exist');
      await fn(f);
    } finally {
      f.autosave.destroy();
      f.store.close();
      mock.timers.reset();
    }
  };
}

async function advance(ms) {
  mock.timers.tick(ms);
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

test('autosave confirmation: matching snapshot becomes clean and never recreates its draft', timed(async (f) => {
  const { autosave, store, statuses, commits, puts } = f;
  await autosave.onOpen('a.md', 'OLD', 'old-sha');
  autosave.onChange('SNAPSHOT');
  await autosave.flushCurrentFile();
  assert.equal(await autosave.confirmSnapshot({
    path: 'a.md', text: 'SNAPSHOT', sha: 'committed-sha'
  }), true);
  assert.equal(autosave.baseSha, 'committed-sha');
  assert.equal(autosave.state, STATE.CLEAN);
  assert.equal(autosave.hasUnsavedDraft(), false);
  assert.equal(statuses.at(-1).key, STATUS.saved.key);
  assert.equal(await store.get(ref('a.md')), null);
  await advance(IDLE_MS + LOCAL_WRITE_DEBOUNCE_MS + 1);
  await autosave.flushCurrentFile();
  assert.equal(await store.get(ref('a.md')), null);
  assert.deepEqual(commits, [], 'external confirmation must not notify remote commit again');
  assert.deepEqual(puts, []);
}));

test('autosave confirmation: newer text stays dirty and is checkpointed on the committed sha', timed(async (f) => {
  const { autosave, store, statuses, commits, puts } = f;
  await autosave.onOpen('a.md', 'OLD', 'old-sha');
  autosave.onChange('FIRST');
  await autosave.flushCurrentFile();
  autosave.onChange('SECOND');
  assert.equal(await autosave.confirmSnapshot({
    path: 'a.md', text: 'FIRST', sha: 'committed-sha'
  }), false);
  assert.equal(autosave._text, 'SECOND');
  assert.equal(autosave.baseSha, 'committed-sha');
  assert.equal(autosave.hasUnsavedDraft(), true);
  assert.notEqual(statuses.at(-1).key, STATUS.saved.key);
  const saved = await store.get(ref('a.md'));
  assert.equal(saved.text, 'SECOND');
  assert.equal(saved.baseSha, 'committed-sha');
  assert.deepEqual(commits, []);
  assert.deepEqual(puts, []);
}));

test('autosave confirmation: empty committed text is a valid clean snapshot', timed(async (f) => {
  const { autosave, store } = f;
  await autosave.onOpen('a.md', 'OLD', 'old-sha');
  autosave.onChange('');
  await autosave.flushCurrentFile();
  assert.equal(await autosave.confirmSnapshot({
    path: 'a.md', text: '', sha: 'empty-sha'
  }), true);
  assert.equal(autosave._text, '');
  assert.equal(autosave.baseSha, 'empty-sha');
  assert.equal(autosave.state, STATE.CLEAN);
  assert.equal(await store.get(ref('a.md')), null);
}));

test('autosave confirmation: another path does not change active state or either draft', timed(async (f) => {
  const { autosave, store, statuses } = f;
  await store.put({ ...ref('a.md'), text: 'A', baseSha: 'old-a' });
  await autosave.onOpen('b.md', 'B OLD', 'old-b');
  autosave.onChange('B NEW');
  await autosave.flushCurrentFile();
  const beforeStatus = statuses.at(-1);
  const beforeA = await store.get(ref('a.md'));
  const beforeB = await store.get(ref('b.md'));
  assert.equal(await autosave.confirmSnapshot({
    path: 'a.md', text: 'A', sha: 'new-a'
  }), false);
  assert.equal(autosave.path, 'b.md');
  assert.equal(autosave._text, 'B NEW');
  assert.equal(autosave.baseSha, 'old-b');
  assert.equal(statuses.at(-1), beforeStatus);
  assert.deepEqual(await store.get(ref('a.md')), beforeA);
  assert.deepEqual(await store.get(ref('b.md')), beforeB);
}));

test('autosave confirmation: typing while conditional cleanup waits remains recoverable', timed(async (f) => {
  const { autosave, store, statuses } = f;
  await autosave.onOpen('a.md', 'OLD', 'old-sha');
  autosave.onChange('FIRST');
  await autosave.flushCurrentFile();

  let release;
  let entered;
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  const originalDelete = store.deleteIfText.bind(store);
  store.deleteIfText = async (...args) => {
    entered();
    await gate;
    return originalDelete(...args);
  };
  let pending;
  try {
    pending = autosave.confirmSnapshot({
      path: 'a.md', text: 'FIRST', sha: 'committed-sha'
    });
    await started;
    autosave.onChange('SECOND');
    release();
    assert.equal(await pending, false);
    assert.equal(autosave._text, 'SECOND');
    assert.equal(autosave.baseSha, 'committed-sha');
    assert.equal(autosave.hasUnsavedDraft(), true);
    assert.notEqual(statuses.at(-1).key, STATUS.saved.key);
    const saved = await store.get(ref('a.md'));
    assert.equal(saved.text, 'SECOND');
    assert.equal(saved.baseSha, 'committed-sha');
  } finally {
    release();
    if (pending) await pending;
  }
}));
