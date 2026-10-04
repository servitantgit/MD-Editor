// draft-store.js
// IndexedDB wrapper for UNSAVED local drafts — the crash-recovery layer.
// One database (`md-editor-drafts`, deliberately a different one from
// `md-editor-search`), one object store, one record per
// `${owner}/${repo}@${branch}:${path}`.
//
// This is NOT the search index and must never be merged into it: the index is
// derived from committed GitHub state and is safe to rebuild, a draft is user
// work that exists nowhere else. Indexing drafts would put half-written
// sentences into search results.
//
// Only ever stores TEXT. A draft is a JS string that was in the editor a moment
// ago, so it never goes through the base64 helpers and never meets the
// `b64ToUtf8` fatal-decode trap (that only exists on the OPEN path, where bytes
// come back from GitHub). No DOM, no network — unit-tested against
// `fake-indexeddb`.

import { IdbBackend, TTL_DAYS, TTL_MS } from './idb-backend.js';

export const DB_NAME = 'md-editor-drafts';
export const DB_VERSION = 1;
export const STORE_NAME = 'drafts';
export { TTL_DAYS, TTL_MS };

/**
 * The key one draft is stored under.
 *
 * Repository AND branch are part of the key, not metadata: switching branches
 * must never surface the other branch's drafts, and switching repositories must
 * not either (the user may well switch back and expect their work to be there).
 */
export function draftKey(owner, repo, branch, path) {
  return `${owner}/${repo}@${branch || 'HEAD'}:${path}`;
}

/** Every draft of one repository/branch shares this prefix. */
export function scopePrefix(owner, repo, branch) {
  return `${owner}/${repo}@${branch || 'HEAD'}:`;
}

/** Normalises the {owner, repo, branch, path} reference callers pass around. */
function refKey(ref) {
  return draftKey(ref.owner, ref.repo, ref.branch, ref.path);
}

export class DraftStore {
  /**
   * @param {object} [options]
   * @param {IDBFactory} [options.indexedDB] injected for tests
   * @param {() => number} [options.now] injected clock, so the TTL is testable
   * @param {(reason: string) => void} [options.onDegrade] the UI turns this
   *   into "local drafts are unavailable" — a real loss of crash protection.
   */
  constructor({ indexedDB, now, onDegrade } = {}) {
    this.backend = new IdbBackend({
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      storeName: STORE_NAME,
      indexedDB,
      now,
      onDegrade,
    });
    this.now = now || (() => Date.now());
  }

  /** False once the store fell back to memory (drafts die with the tab). */
  get persistent() { return this.backend.persistent; }
  get degraded() { return this.backend.degraded; }

  open() { return this.backend.open(); }

  /**
   * Writes a draft. `dirty` defaults to true: everything still in the store is
   * by definition work that never made it to GitHub (a successful push deletes
   * the record instead of clearing the flag).
   */
  async put({ owner, repo, branch, path, text, baseSha = null, dirty = true }) {
    return this.backend.put(
      { key: draftKey(owner, repo, branch, path), path, text, baseSha, dirty },
      // Under quota pressure the whole CURRENT scope is untouchable: those are
      // the drafts the user is actually editing right now.
      { protectPrefix: scopePrefix(owner, repo, branch) }
    );
  }

  /** The stored draft for one file, or null. Never throws. */
  async get(ref) { return this.backend.get(refKey(ref)); }

  async delete(ref) { return this.backend.delete(refKey(ref)); }

  /** Deletes by the stored key itself (used by the sweep, which reads records). */
  async deleteByKey(key) { return this.backend.delete(key); }

  /** Every stored draft, whatever repository it belongs to. */
  async all() { return this.backend.all(); }

  /**
   * Drops drafts nobody can use any more, and returns how many went.
   *
   * Stale means: older than the 30-day TTL, OR a path that is not in
   * `knownPaths` (the file was deleted / renamed in the repository). Same TTL
   * and the same justification as the search index sweep — without it a
   * repository deleted on GitHub would keep its drafts forever.
   *
   * `scope` limits the sweep to ONE repository/branch. That is the normal call
   * (on tree load) and it is deliberately narrow: logging into another repo must
   * never delete the drafts of the repo you were just editing.
   */
  async sweepStaleDrafts(knownPaths, now = this.now(), scope = null) {
    const known = new Set(knownPaths || []);
    const prefix = scope ? scopePrefix(scope.owner, scope.repo, scope.branch) : null;
    const records = await this.all();
    const stale = records.filter((r) => {
      if (!r) return false;
      if (prefix && !String(r.key).startsWith(prefix)) return false; // another repo's work
      const expired = !(r.savedAt >= now - TTL_MS);
      return expired || !known.has(r.path);
    });
    for (const record of stale) await this.deleteByKey(record.key);
    return stale.length;
  }

  /** TTL-only sweep across every repository. */
  async evictExpired(now = this.now()) {
    const records = await this.all();
    const stale = records.filter((r) => r && !(r.savedAt >= now - TTL_MS));
    for (const record of stale) await this.deleteByKey(record.key);
    return stale.length;
  }

  close() { this.backend.close(); }
}