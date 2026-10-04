// idb-backend.js
// The generic half of every IndexedDB store in this app: open once, run one
// transaction at a time, degrade to an in-memory map when the browser refuses.
//
// This is the pattern search-store.js grew on its own, extracted so the SECOND
// database (drafts) does not become a third slightly different variant of the
// same open/degrade/quota code. search-store.js deliberately still carries its
// own copy — the search feature is read-only over committed GitHub state and
// was not to be touched (see AGENTS.md). If that module is ever migrated here,
// its tests must stay green unchanged — they are what pins this behaviour.
//
// EVERY call is wrapped. indexedDB.open() can throw outright (private windows,
// Safari ITP, disabled storage) and a transaction can fail asynchronously long
// after the call that started it, so "it worked in my browser" is not evidence
// that any of this is safe to unwrap.

/** Shared TTL: a stale record is worthless to both consumers. */
export const TTL_DAYS = 30;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

export function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
}

/** In-memory stand-in used whenever IndexedDB is unavailable. */
export function createMemoryBackend() {
  const map = new Map();
  return {
    async get(key) { return map.get(key) || null; },
    async put(record) { map.set(record.key, record); },
    async delete(key) { map.delete(key); },
    async all() { return Array.from(map.values()); },
  };
}

export class IdbBackend {
  /**
   * @param {object} options
   * @param {string} options.dbName
   * @param {number} options.dbVersion
   * @param {string} options.storeName
   * @param {IDBFactory} [options.indexedDB] injected for tests
   * @param {() => number} [options.now] injected clock, so the TTL is testable
   * @param {(reason: string) => void} [options.onDegrade] called when the store
   *   becomes unusable; the caller turns this into its own banner.
   */
  constructor({ dbName, dbVersion, storeName, indexedDB, now = () => Date.now(), onDegrade } = {}) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.storeName = storeName;
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
    try { this.onDegrade(reason); } catch (_) { /* a broken callback must not break the store */ }
  }

  /**
   * Opens the database (once). Never rejects: on any failure the store degrades
   * to memory and every read/write falls through silently.
   */
  async open() {
    // Degradation is STICKY. Without this, the very next call would re-open the
    // database (opening still works — it is the writes that fail) and quietly
    // resume reading a store that has nothing in it, so the session would look
    // like it lost everything it had just written.
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
        request = this.idb.open(this.dbName, this.dbVersion);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
      // Safari in private mode can leave the request pending forever; treat
      // "blocked" as unavailable rather than hanging the caller forever.
      request.onblocked = () => reject(new Error('indexedDB.open blocked'));
    });
  }
/**
   * Runs `fn(store)` inside one transaction. The returned promise settles with
   * whatever the request assigned to the result holder — reading a value requires
   * waiting for the request, so the callback stashes it instead of returning it
   * from a synchronous function.
   */
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        if (!this.db) throw new Error('database is not open');
        tx = this.db.transaction(this.storeName, mode);
      } catch (err) {
        reject(err);
        return;
      }
      // Local holder, not a field: two overlapping transactions would otherwise
      // overwrite each other's result.
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      try {
        fn(tx.objectStore(this.storeName), (value) => { result = value; });
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
   *
   * On a quota error it frees space by dropping the oldest record that is NOT
   * protected and retries ONCE; a second failure degrades to memory. Protection
   * matters more than space here: for drafts, the record being written (and its
   * whole repo scope) is unsaved user work, while the victims are other
   * repositories' leftovers.
   */
  async put(record, { protectKey = null, protectPrefix = null } = {}) {
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
        await this.evictOldest(full.key, { protectPrefix });
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

  /** Every stored record. */
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
   * Frees space for `keepKey` by deleting the oldest UNPROTECTED record.
   * `protectPrefix` spares a whole key prefix (one repository/branch scope).
   * Returns false when there was nothing safe to drop.
   */
  async evictOldest(keepKey, { protectPrefix = null } = {}) {
    const records = (await this.all()).filter((r) => r && r.key !== keepKey
      && !(protectPrefix && String(r.key).startsWith(protectPrefix)));
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