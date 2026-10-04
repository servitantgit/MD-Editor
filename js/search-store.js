// search-store.js
// Thin IndexedDB wrapper for the persisted search index. One database, one
// object store, one record per `${owner}/${repo}@${branch}`.
// No DOM, no network — unit-tested against `fake-indexeddb`.
//
// EVERY call is wrapped. indexedDB.open() can throw outright (private windows,
// Safari ITP, disabled storage) and a transaction can fail asynchronously long
// after the call that started it, so "it worked in my browser" is not evidence
// that any of this is safe to unwrap. When the store cannot be used the caller
// falls back to an in-memory index for the session — see _degrade().

export const DB_NAME = 'md-editor-search';
export const DB_VERSION = 1;
export const STORE_NAME = 'indexes';
export const TTL_DAYS = 30;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

/** The key one record per repository/branch is stored under. */
export function recordKey(owner, repo, branch) {
  return `${owner}/${repo}@${branch || 'HEAD'}`;
}

function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
}

/** In-memory stand-in used whenever IndexedDB is unavailable. */
function createMemoryBackend() {
  const map = new Map();
  return {
    async get(key) { return map.get(key) || null; },
    async put(record) { map.set(record.key, record); },
    async delete(key) { map.delete(key); },
    async all() { return Array.from(map.values()); },
  };
}

export class SearchStore {
  /**
   * @param {object} [options]
   * @param {IDBFactory} [options.indexedDB] injected for tests
   * @param {() => number} [options.now] injected clock, so the TTL is testable
   * @param {(reason: string) => void} [options.onDegrade] called when the store
   *   becomes unusable; the UI turns this into the "session-only" banner.
   */
  constructor({ indexedDB, now = () => Date.now(), onDegrade } = {}) {
    this.idb = indexedDB !== undefined ? indexedDB : globalThis.indexedDB;
    this.now = now;
    this.onDegrade = onDegrade || (() => {});
    this.db = null;
    this.opening = null;
    this.persistent = false;
    this.degraded = false;
    this.memory = createMemoryBackend();
  }

  _degrade(reason) {
    if (this.degraded) return;
    this.degraded = true;
    this.persistent = false;
    this.db = null;
    try { this.onDegrade(reason); } catch (_) { /* a broken callback must not break search */ }
  }

  /**
   * Opens the database (once) and evicts expired records.
   * Never rejects: on any failure the store degrades to memory.
   */
  async open() {
    // Degradation is STICKY. Without this, the very next call would re-open the
    // database (it still opens fine — it is the writes that fail) and quietly
    // resume reading a store that has nothing in it, so the session would look
    // like it lost the index it just built.
    if (this.degraded) return false;
    if (this.db) return true;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      if (!this.idb) {
        this._degrade('no-indexeddb');
        return false;
      }
      try {
        const db = await this._openDb();
        this.db = db;
        this.persistent = true;
        db.onversionchange = () => db.close();
        await this.evictExpired();
        return true;
      } catch (err) {
        this._degrade(String((err && err.message) || err));
        return false;
      } finally {
        this.opening = null;
      }
    })();

    return this.opening;
  }

  _openDb() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = this.idb.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
      // Safari in private mode can leave the request pending forever; treat
      // "blocked" as unavailable rather than hanging the app forever.
      request.onblocked = () => reject(new Error('indexedDB.open blocked'));
    });
  }

  /**
   * Runs `fn(store)` inside one transaction. The returned promise settles with
   * whatever the request assigned to `request.onsuccess`'s `result` holder —
   * reading a value requires waiting for the request, so the caller stashes it
   * on `this._result` rather than returning it from a synchronous callback.
   */
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(STORE_NAME, mode);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(this._result);
      tx.onerror = () => reject(tx.error || new Error('transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      this._result = undefined;
      try {
        fn(tx.objectStore(STORE_NAME), (value) => { this._result = value; });
      } catch (err) {
        try { tx.abort(); } catch (_) { /* already finishing */ }
        reject(err);
      }
    });
  }

  /** Reads one record, or null when absent. Never throws. */
  async get(key) {
    if (!(await this.open())) return this.memory.get(key);
    try {
      return (
        (await this._tx('readonly', (store, setResult) => {
          const req = store.get(key);
          req.onsuccess = () => setResult(req.result || null);
        })) || null
      );
    } catch (err) {
      this._degrade(String((err && err.message) || err));
      return this.memory.get(key);
    }
  }

  /**
   * Writes the record, stamping `savedAt` with the injected clock.
   * On a quota error it frees space by dropping another repository's oldest
   * record and retries ONCE; a second failure degrades to memory.
   */
  async put(record) {
    const full = { ...record, savedAt: this.now() };
    if (!(await this.open())) return this.memory.put(full);

    const write = () => this._tx('readwrite', (store) => { store.put(full); });

    try {
      await write();
      return true;
    } catch (err) {
      if (!isQuotaError(err)) {
        this._degrade(String((err && err.message) || err));
        return this.memory.put(full);
      }
      try {
        await this.evictOldest(full.key);
        await write();
        return true;
      } catch (retryErr) {
        this._degrade('quota: ' + String((retryErr && retryErr.message) || retryErr));
        return this.memory.put(full);
      }
    }
  }

  async delete(key) {
    if (!(await this.open())) return this.memory.delete(key);
    try {
      await this._tx('readwrite', (store) => { store.delete(key); });
    } catch (_) { /* best-effort; the TTL sweep will catch it eventually */ }
  }

  /** Every stored record. Used by the TTL and quota paths. */
  async all() {
    if (!(await this.open())) return this.memory.all();
    try {
      return (
        (await this._tx('readonly', (store, setResult) => {
          const req = store.getAll();
          req.onsuccess = () => setResult(req.result || []);
        })) || []
      );
    } catch (_) {
      return [];
    }
  }

  /**
   * Drops records older than the TTL, so a repository deleted on GitHub does not
   * leave a stale index behind forever. Runs on every open().
   */
  async evictExpired() {
    if (!this.db) return 0;
    const cutoff = this.now() - TTL_MS;
    const records = await this.all();
    const stale = records.filter((r) => !r || !(r.savedAt >= cutoff));
    for (const record of stale) await this.delete(record.key);
    return stale.length;
  }

  /**
   * Frees space for `keepKey` by deleting the oldest record belonging to a
   * DIFFERENT repository. Never touches the record we are trying to write.
   */
  async evictOldest(keepKey) {
    const records = (await this.all()).filter((r) => r && r.key !== keepKey);
    if (!records.length) return false;
    const oldest = records.reduce((a, b) => ((a.savedAt || 0) <= (b.savedAt || 0) ? a : b));
    await this.delete(oldest.key);
    return true;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) { /* already closed */ }
      this.db = null;
    }
    this.persistent = false;
  }
}