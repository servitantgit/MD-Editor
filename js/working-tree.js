// working-tree.js
// Tracks local dirty files (modified / added) relative to the last known GitHub SHA.
// Pure state — no DOM. UI reads snapshots via listChanges() / getChangeCount().

/**
 * @typedef {{ path: string, text: string, baseSha: string|null, status: 'M'|'A' }} Change
 */

export class WorkingTree {
  constructor() {
    /** @type {Map<string, { text: string, baseSha: string|null }>} */
    this._map = new Map();
  }

  /** Mark path as dirty with current text. baseSha=null means newly added. */
  setDirty(path, text, baseSha) {
    if (path == null) return;
    this._map.set(path, { text, baseSha: baseSha ?? null });
  }

  /** Clear dirty state after a successful commit (or discard). */
  clear(path) {
    if (path == null) this._map.clear();
    else this._map.delete(path);
  }

  clearAll() {
    this._map.clear();
  }

  isDirty(path) {
    return this._map.has(path);
  }

  get(path) {
    return this._map.get(path) || null;
  }

  /** @returns {Change[]} */
  listChanges() {
    const out = [];
    for (const [path, { text, baseSha }] of this._map) {
      out.push({
        path,
        text,
        baseSha,
        status: baseSha ? 'M' : 'A',
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  getChangeCount() {
    return this._map.size;
  }

  /** Status map for file-tree badges: path -> 'M'|'A' */
  statusMap() {
    /** @type {Record<string, 'M'|'A'>} */
    const m = {};
    for (const [path, { baseSha }] of this._map) {
      m[path] = baseSha ? 'M' : 'A';
    }
    return m;
  }

  /** Rename path key when a file is moved/renamed. */
  rename(oldPath, newPath) {
    const entry = this._map.get(oldPath);
    if (!entry) return;
    this._map.delete(oldPath);
    this._map.set(newPath, entry);
  }
}
