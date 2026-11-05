import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from '../js/autosave.js';
import { DraftStore } from '../js/draft-store.js';

const SCOPE = { owner: 'o', repo: 'r', branch: 'main' };
const REF = { ...SCOPE, path: 'a.md' };

function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function invalidatedConfirmation(reopen) {
  const store = new DraftStore({ indexedDB: null });
  const statuses = [];
  const autosave = new Autosave({
    ...SCOPE, store, client: {},
    getText: () => autosave._text,
    onStatus: (status) => statuses.push(status)
  });
  const entered = gate();
  const release = gate();
  const originalDelete = store.deleteIfText.bind(store);
  let pending;

  try {
    await autosave.onOpen('a.md', 'OLD', 'old-sha');
    autosave.onChange('FIRST');
    await autosave.flushCurrentFile();

    store.deleteIfText = async (...args) => {
      entered.resolve();
      await release.promise;
      return originalDelete(...args);
    };
    pending = autosave.confirmSnapshot({
      path: 'a.md', text: 'FIRST', sha: 'committed-sha'
    });
    await entered.promise;

    if (reopen) {
      autosave.release();
      await autosave.onOpen('a.md', 'OTHER REMOTE', 'other-sha');
      autosave.onChange('FIRST');
      await autosave.flushCurrentFile();
    } else {
      autosave.destroy();
    }

    const before = await store.get(REF);
    assert.ok(before, 'fixture must contain a recovery draft');
    const statusCount = statuses.length;
    const baseSha = autosave.baseSha;
    const state = autosave.state;

    release.resolve();
    assert.equal(await pending, false);
    assert.equal(statuses.length, statusCount, 'invalidated result must not paint status');
    assert.equal(autosave.baseSha, baseSha);
    assert.equal(autosave.state, state);
    assert.deepEqual(await store.get(REF), before,
      'invalidated confirmation must preserve the recovery draft');
  } finally {
    release.resolve();
    if (pending) await pending;
    autosave.destroy();
    store.close();
  }
}

test('autosave confirmation: reopened same path keeps its same-text draft on a different base', async () => {
  await invalidatedConfirmation(true);
});

test('autosave confirmation: destroy while cleanup waits preserves the recovery draft', async () => {
  await invalidatedConfirmation(false);
});
