import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DraftStore } from '../js/draft-store.js';

const SCOPE = { owner: 'o', repo: 'r', branch: 'main' };
const REF = { ...SCOPE, path: 'a.md' };
const draft = (text, extra = {}) => ({ ...REF, text, ...extra });
const newStore = () => new DraftStore({
  indexedDB: new IDBFactory(), now: () => 1000
});

function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('draft confirmation (guard): pending key does not block another path, branch or repo', async () => {
  const store = newStore();
  const entered = gate();
  const release = gate();
  let pending;
  let othersPending;
  let timer;
  try {
    await store.open();
    const originalPut = store.backend.put.bind(store.backend);
    store.backend.put = async (record, options) => {
      if (record.key === 'o/r@main:a.md') {
        entered.resolve();
        await release.promise;
      }
      return originalPut(record, options);
    };
    pending = store.put(draft('BLOCKED'));
    await entered.promise;
    const others = [
      draft('OTHER PATH', { path: 'b.md' }),
      draft('OTHER BRANCH', { branch: 'dev' }),
      draft('OTHER REPO', { repo: 'other' })
    ];
    othersPending = Promise.all(others.map((r) => store.put(r)));
    await Promise.race([
      othersPending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('other keys blocked')), 3000);
      })
    ]);
    clearTimeout(timer);
    for (const record of others) {
      assert.equal((await store.get(record)).text, record.text);
    }
    release.resolve();
    await pending;
    assert.equal((await store.get(REF)).text, 'BLOCKED');
  } finally {
    clearTimeout(timer);
    release.resolve();
    await Promise.allSettled([pending, othersPending].filter(Boolean));
    store.close();
  }
});

test('draft confirmation (guard): rejected put does not poison the queue or retain settled keys', async () => {
  const store = newStore();
  try {
    await store.open();
    const originalPut = store.backend.put.bind(store.backend);
    let first = true;
    store.backend.put = (...args) => {
      if (first) {
        first = false;
        return Promise.reject(new Error('controlled put rejection'));
      }
      return originalPut(...args);
    };
    const failed = store.put(draft('FAILED'));
    const next = store.put(draft('NEXT'));
    await assert.rejects(failed, /controlled put rejection/);
    assert.equal(await next, true);
    assert.equal((await store.get(REF)).text, 'NEXT');
    assert.equal(await store.deleteIfText(REF, 'NEXT'), true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(store._operations.size, 0);
  } finally {
    store.close();
  }
});

test('draft confirmation (guard): abort after delete request preserves draft and returns false', async () => {
  const store = newStore();
  try {
    await store.put(draft('SNAPSHOT'));
    const before = await store.get(REF);
    const originalTx = store.backend._tx.bind(store.backend);
    let aborted = false;
    store.backend._tx = (mode, fn) => originalTx(mode, (objectStore, setResult) => {
      const wrapped = new Proxy(objectStore, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args) => {
            const result = value.apply(target, args);
            if (mode === 'readwrite' && property === 'delete') {
              aborted = true;
              target.transaction.abort();
            }
            return result;
          };
        }
      });
      return fn(wrapped, setResult);
    });
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT'), false);
    assert.equal(aborted, true);
    store.backend._tx = originalTx;
    assert.deepEqual(await store.get(REF), before);
    assert.equal(store.degraded, false);
    assert.equal(await store.deleteIfText(REF, 'SNAPSHOT'), true);
    assert.equal(await store.get(REF), null);
  } finally {
    store.close();
  }
});
