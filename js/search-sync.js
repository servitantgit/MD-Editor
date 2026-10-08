// search-sync.js
// Orchestrator: hydrate the persisted index, diff the current getTree() against
// the stored manifest, fetch only the new/changed .md files, feed them to
// search-index.js and persist the result.
//
// Deliberately owns NO network code of its own: it drives the existing
// GitHubClient rather than moving getTree/getFileB64 in here, so the client
// stays thin and no request can bypass its cache-busting / CORS rules.

import { b64ToUtf8 } from './github-client.js';
import { createSearchIndex, diffTree, isSearchablePath } from './search-index.js';
import { recordKey } from './search-store.js';

/** Parallel getFileB64 calls. Enough to be quick, far below the rate limit. */
export const FETCH_CONCURRENCY = 4;

/** Persist every N files: put() of a multi-MB blob is not free. */
export const BATCH_SIZE = 20;

export class SearchSync {
  /**
   * @param {object} deps
   * @param {import('./github-client.js').GitHubClient} deps.client
   * @param {import('./search-store.js').SearchStore} deps.store
   * @param {string} deps.owner
   * @param {string} deps.repo
   * @param {string} deps.branch
   * @param {any} deps.MiniSearchCtor the MiniSearch constructor (global in the browser)
   * @param {(done: number, total: number) => void} [deps.onProgress]
   * @param {(info: {indexed: number, total: number, persistent: boolean}) => void} [deps.onDone]
   */
  constructor({ client, store, owner, repo, branch, MiniSearchCtor, onProgress, onDone, onFileIndexed, onFileRemoved }) {
    this.client = client;
    this.store = store;
    this.key = recordKey(owner, repo, branch);
    this.branch = branch;
    this.MiniSearchCtor = MiniSearchCtor;
    this.onProgress = onProgress || (() => {});
    this.onDone = onDone || (() => {});
    this.onFileIndexed = onFileIndexed || (() => {});
    this.onFileRemoved = onFileRemoved || (() => {});
    this.index = null;
    this.manifest = {};
    this.lastSyncedAt = 0;
    this.destroyed = false;
  }

  /**
   * Loads the persisted record and hydrates MiniSearch from it.
   *
   * Awaited by the caller BEFORE the tree is fetched so that a returning login
   * can answer queries from memory immediately, while the background sync only
   * re-fetches what actually changed.
   */
  async hydrate() {
    const record = await this.store.get(this.key);
    if (this.destroyed) return 0;
    this.index = createSearchIndex(this.MiniSearchCtor, record ? record.serializedIndex : null);
    this.manifest = (record && record.manifest) || {};
    return this.index.size;
  }

  /** Runs `worker` over `items` with at most `limit` in flight at a time. */
  async _pool(items, limit, worker) {
    const queue = items.slice();
    const width = Math.max(1, Math.min(limit, queue.length));
    const runners = [];
    for (let i = 0; i < width; i++) {
      runners.push(
        (async () => {
          while (queue.length) {
            if (this.destroyed) return;
            await worker(queue.shift());
          }
        })()
      );
    }
    await Promise.all(runners);
  }
/**
   * Diff + fetch + persist. Safe to call repeatedly: when nothing changed the
   * diff is empty and no request is made at all.
   * @param {{path: string, sha: string}[]} tree fresh getTree() output
   * @param {{force?: boolean}} [options] force = ignore the manifest and rebuild
   */
  async run(tree, { force = false } = {}) {
    if (this.destroyed || !this.index) return { indexed: 0, removed: 0 };

    if (force) {
      this.index.clear();
      this.manifest = {};
      try { this.onFileRemoved(null); } catch (_) {} // signal full rebuild start
    }

    const files = tree.filter((f) => isSearchablePath(f.path));
    const { added, removed, changed } = diffTree(files, this.manifest);

    // Removed and changed paths must leave the index BEFORE their new versions
    // go in, otherwise the old version can survive alongside the new one.
    for (const path of removed) {
      this.index.removeDocument(path);
      try { this.onFileRemoved(path); } catch (_) {}
    }
    for (const path of changed) {
      this.index.removeDocument(path);
      try { this.onFileRemoved(path); } catch (_) {}
    }

    const manifest = {};
    files.forEach((f) => { manifest[f.path] = f.sha; });

    const pending = added.concat(changed);
    if (!pending.length) {
      // Nothing to fetch, but removals still have to be persisted. This is the
      // common returning-login path, so it MUST also stamp lastSyncedAt —
      // otherwise the status line would report the epoch and read
      // "last synced 20731d ago" on every single visit.
      this.manifest = manifest;
      if (removed.length) await this._persist();
      this.lastSyncedAt = Date.now();
      this._finish(0);
      return { indexed: 0, removed: removed.length };
    }

    // `done` counts files that really entered the index (it is what run() returns
    // and what onDone reports); `processed` counts every file we TRIED, including
    // ones skipped as unreadable or not valid UTF-8. Progress follows `processed`
    // so the status line still reaches N/N when a file is skipped, and the batch
    // persistence below follows it too, exactly as before.
    let done = 0;
    let processed = 0;
    let sinceSave = 0;

    await this._pool(pending, FETCH_CONCURRENCY, async (path) => {
      if (this.destroyed) return;
      try {
        const { b64 } = await this.client.getFileB64(path);
        // b64ToUtf8 THROWS on content that is not valid UTF-8. That throw is the
        // signal to skip the file — a binary blob with a .md extension must not
        // be indexed as a string of U+FFFD replacement characters.
        const body = b64ToUtf8(b64);
        this.index.add(path, body);
        try { this.onFileIndexed(path, body); } catch (_) {}
        done++;
      } catch (_) {
        // A skipped file stays absent from the index, but it is still listed in
        // the manifest below so we do not re-fetch it on every single sync.
      }

      processed++;
      sinceSave++;
      this.onProgress(processed, pending.length);

      // Persist in batches, not per file: put() of a multi-MB blob is not free.
      if (sinceSave >= BATCH_SIZE) {
        sinceSave = 0;
        this.manifest = manifest;
        await this._persist();
      }
    });

    if (!this.destroyed) {
      this.manifest = manifest;
      await this._persist();
    }
    this.lastSyncedAt = Date.now();
    this._finish(done);
    return { indexed: done, removed: removed.length };
  }

  _finish(indexed) {
    if (this.destroyed) return;
    this.onDone({
      indexed,
      total: this.index.size,
      persistent: !!this.store.persistent,
    });
  }

  /**
   * Lazily loads one body for a snippet the LRU cache does not have.
   * Returns undefined (never throws) when the file cannot be read or decoded.
   */
  async fetchBody(path) {
    try {
      const { b64 } = await this.client.getFileB64(path);
      const body = b64ToUtf8(b64);
      if (this.index) this.index.bodyCache.set(path, body);
      return body;
    } catch (_) {
      return undefined;
    }
  }

  async _persist() {
    if (this.destroyed) return;
    await this.store.put({
      key: this.key,
      serializedIndex: this.index.serialize(),
      manifest: this.manifest,
    });
  }

  /**
   * Stops an in-flight sync. Called from showApp() teardown for the same reason
   * the editor handle is destroyed there: a re-login must not leave the previous
   * indexer running and writing into the new session's store.
   */
  destroy() {
    this.destroyed = true;
  }
}