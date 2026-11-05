import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DraftStore } from '../js/draft-store.js';

const REF = { owner: 'o', repo: 'r', branch: 'main', path: 'a.md' };

async function invalidatedIdbCleanup(throws) {
  const store = new DraftStore({ indexedDB: new IDBFactory(), now: () => 1000 });
  let invalidated = false;
  let readCompleted = false;
  let deleteRequests = 0;
  try {
    await store.put({ ...REF, text: 'SNAPSHOT', baseSha: 'old-sha' });
    const before = await store.get(REF);
    const originalTx = store.backend._tx.bind(store.backend);
    store.backend._tx = (mode, fn) => originalTx(mode, (objectStore, setResult) => {
      const wrapped = new Proxy(objectStore, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (property === 'delete') deleteRequests++;
            const request = value.apply(target, args);
            if (mode === 'readwrite' && property === 'get') {
              request.addEventListener('success', () => {
                readCompleted = true;
                invalidated = true;
              });
            }
            return request;
          };
        }
      });
      return fn(wrapped, setResult);
    });
    const result = await store.deleteIfText(REF, 'SNAPSHOT', () => {
      if (invalidated && throws) throw new Error('invalidated generation');
      return !invalidated;
    });
    assert.equal(result, false);
    assert.equal(readCompleted, true, 'must reach the real read callback');
    assert.equal(deleteRequests, 0, 'no delete after invalidation');
    store.backend._tx = originalTx;
    assert.deepEqual(await store.get(REF), before);
    assert.equal(store.degraded, false);
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT'), true);
    assert.equal(await store.get(REF), null);
  } finally {
    store.close();
  }
}

test('draft confirmation (guard): revoked permission at IDB read completion preserves draft', async () => {
  await invalidatedIdbCleanup(false);
});

test('draft confirmation (guard): throwing permission at IDB read completion preserves draft', async () => {
  await invalidatedIdbCleanup(true);
});

test('draft confirmation (guard): memory queue and backend reject false or throwing permission', async () => {
  const store = new DraftStore({ indexedDB: null, now: () => 1000 });
  try {
    await store.put({ ...REF, text: 'SNAPSHOT' });
    const before = await store.get(REF);
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT', () => false), false);
    assert.deepEqual(await store.get(REF), before);
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT', () => {
      throw new Error('invalidated generation');
    }), false);
    assert.deepEqual(await store.get(REF), before);
    assert.equal(await store.backend.memory.deleteIfText(before.key, 'SNAPSHOT',
      () => false), false);
    assert.equal(await store.backend.memory.deleteIfText(before.key, 'SNAPSHOT',
      () => { throw new Error('invalidated generation'); }), false);
    assert.deepEqual(await store.get(REF), before);
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT'), true);
    assert.equal(await store.get(REF), null);
  } finally {
    store.close();
  }
});
