import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DraftStore } from '../js/draft-store.js';

const REF = { owner: 'o', repo: 'r', branch: 'main', path: 'a.md' };
const makeStore = (idb = new IDBFactory()) =>
  new DraftStore({ indexedDB: idb, now: () => 1000 });

function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('draft rebase: one readwrite transaction changes only the existing base SHA', async () => {
  const store = makeStore();
  try {
    assert.equal(typeof store.rebase, 'function', 'rebase must exist');
    await store.put({ ...REF, text: 'NEWER TEXT', baseSha: 'old-sha' });
    const before = await store.get(REF);
    const operations = [];
    const originalTx = store.backend._tx.bind(store.backend);
    store.backend._tx = (mode, fn) => {
      const operation = { mode, requests: [] };
      operations.push(operation);
      return originalTx(mode, (objectStore, setResult) => {
        const wrapped = new Proxy(objectStore, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return (...args) => {
              if (property === 'get' || property === 'put') {
                operation.requests.push(String(property));
              }
              return value.apply(target, args);
            };
          }
        });
        return fn(wrapped, setResult);
      });
    };
    assert.equal(await store.rebase(REF, 'committed-sha'), true);
    assert.deepEqual(operations, [
      { mode: 'readwrite', requests: ['get', 'put'] }
    ]);
    store.backend._tx = originalTx;
    assert.deepEqual(await store.get(REF), {
      ...before, baseSha: 'committed-sha'
    });
    assert.equal(await store.rebase({ ...REF, path: 'missing.md' }, 'sha'), false);
    assert.equal(await store.get({ ...REF, path: 'missing.md' }), null);
  } finally {
    store.close();
  }
});

test('draft rebase: memory fallback preserves empty text and record metadata', async () => {
  const store = makeStore(null);
  try {
    assert.equal(typeof store.rebase, 'function', 'rebase must exist');
    await store.put({ ...REF, text: '', baseSha: 'old-sha' });
    const before = await store.get(REF);
    assert.equal(await store.rebase(REF, 'empty-sha'), true);
    assert.deepEqual(await store.get(REF), { ...before, baseSha: 'empty-sha' });
    assert.equal(store.degraded, true);
  } finally {
    store.close();
  }
});

test('draft rebase: revoked permission at IDB read completion prevents the update', async () => {
  const store = makeStore();
  try {
    assert.equal(typeof store.rebase, 'function', 'rebase must exist');
    await store.put({ ...REF, text: 'NEWER', baseSha: 'other-base' });
    const before = await store.get(REF);
    const originalTx = store.backend._tx.bind(store.backend);
    let allowed = true;
    let readCompleted = false;
    let puts = 0;
    store.backend._tx = (mode, fn) => originalTx(mode, (objectStore, setResult) => {
      const wrapped = new Proxy(objectStore, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (property === 'put') puts++;
            const request = value.apply(target, args);
            if (mode === 'readwrite' && property === 'get') {
              request.addEventListener('success', () => {
                allowed = false;
                readCompleted = true;
              });
            }
            return request;
          };
        }
      });
      return fn(wrapped, setResult);
    });
    assert.equal(await store.rebase(REF, 'committed-sha', () => allowed), false);
    assert.equal(readCompleted, true);
    assert.equal(puts, 0);
    store.backend._tx = originalTx;
    assert.deepEqual(await store.get(REF), before);
    assert.equal(await store.rebase(REF, 'sha', () => {
      throw new Error('stale session');
    }), false);
    assert.deepEqual(await store.get(REF), before);
  } finally {
    store.close();
  }
});

test('draft rebase: queued update preserves text from the preceding delayed put', async () => {
  const store = makeStore();
  const entered = gate();
  const release = gate();
  let put;
  let rebased;
  try {
    assert.equal(typeof store.rebase, 'function', 'rebase must exist');
    await store.open();
    const originalPut = store.backend.put.bind(store.backend);
    store.backend.put = async (...args) => {
      entered.resolve();
      await release.promise;
      return originalPut(...args);
    };
    put = store.put({ ...REF, text: 'LATEST TEXT', baseSha: 'old-sha' });
    await entered.promise;
    rebased = store.rebase(REF, 'committed-sha');
    release.resolve();
    await put;
    assert.equal(await rebased, true);
    const saved = await store.get(REF);
    assert.equal(saved.text, 'LATEST TEXT');
    assert.equal(saved.baseSha, 'committed-sha');
    assert.equal(saved.savedAt, 1000);
  } finally {
    release.resolve();
    await Promise.allSettled([put, rebased].filter(Boolean));
    store.close();
  }
});
