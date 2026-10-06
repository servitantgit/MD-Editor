// tabs.js
// The list of open tabs and which one is active — nothing else. No DOM, no
// network, no editor: the heavy per-tab state (CodeMirror document, sha) lives in
// app.js, keyed by path, so this model stays small enough to cover completely
// with unit tests.
//
// A tab is identified by its repository path. There is never more than one tab
// per path: opening an already-open file just activates its tab.

import { basenameOf, dirnameOf } from './paths.js';

export class TabsModel {
  /**
   * @param {string[]} [paths]
   * @param {string|null} [active]
   */
  constructor(paths = [], active = null) {
    this._paths = [];
    for (const p of paths) if (p && !this._paths.includes(p)) this._paths.push(p);
    this._active = active && this._paths.includes(active) ? active : null;
  }

  get paths() {
    return this._paths.slice();
  }

  get active() {
    return this._active;
  }

  get size() {
    return this._paths.length;
  }

  has(path) {
    return this._paths.includes(path);
  }

  /** Adds a tab at the end if it is not open yet. Does not change the active tab. */
  open(path) {
    if (!path || this._paths.includes(path)) return false;
    this._paths.push(path);
    return true;
  }

  /** Makes an open tab the active one. Unknown paths are ignored. */
  activate(path) {
    if (!this._paths.includes(path)) return false;
    this._active = path;
    return true;
  }

  /**
   * Closes a tab. When it was the active one, the tab to its right takes over
   * (the way browsers do it), or the one to its left when it was the last.
   *
   * @returns {{closed: boolean, wasActive: boolean, next: string|null}}
   *   `next` is the active tab after the close (null when none are left).
   */
  close(path) {
    const idx = this._paths.indexOf(path);
    if (idx === -1) return { closed: false, wasActive: false, next: this._active };
    const wasActive = this._active === path;
    this._paths.splice(idx, 1);
    if (wasActive) this._active = this._neighbourAt(idx);
    return { closed: true, wasActive, next: this._active };
  }

  /**
   * A file was renamed or moved. The tab follows it. If a tab for the new path
   * already exists (a move that replaced it), the two merge into that one.
   */
  rename(oldPath, newPath) {
    if (oldPath === newPath) return false;
    const idx = this._paths.indexOf(oldPath);
    if (idx === -1) return false;
    const wasActive = this._active === oldPath;
    if (this._paths.includes(newPath)) {
      this._paths.splice(idx, 1);
    } else {
      this._paths[idx] = newPath;
    }
    if (wasActive) this._active = newPath;
    return true;
  }

  /**
   * A folder was renamed: every tab inside it follows.
   * @returns {Array<[string, string]>} the [old, new] pairs that changed
   */
  renameFolder(oldFolder, newFolder) {
    const prefix = oldFolder + '/';
    const changed = [];
    for (const p of this.paths) {
      if (p.startsWith(prefix)) {
        const next = newFolder + p.slice(oldFolder.length);
        this.rename(p, next);
        changed.push([p, next]);
      }
    }
    return changed;
  }

  /**
   * Drops every tab inside a deleted folder.
   * @returns {string[]} the paths that were closed
   */
  removeUnder(folder) {
    const prefix = folder + '/';
    const removed = [];
    for (const p of this.paths) {
      if (p.startsWith(prefix)) {
        this.close(p);
        removed.push(p);
      }
    }
    return removed;
  }

  /** Keeps only tabs whose path passes `exists` (used after the tree is reloaded). */
  retainWhere(exists) {
    const dropped = [];
    for (const p of this.paths) {
      if (!exists(p)) {
        this.close(p);
        dropped.push(p);
      }
    }
    return dropped;
  }

  toJSON() {
    return { paths: this.paths, active: this._active };
  }

  /**
   * Rebuilds a model from `toJSON()` output, tolerating anything that was
   * mangled on the way (it lives in sessionStorage, which anyone can edit).
   * Paths that `exists` rejects are left out.
   */
  static fromJSON(data, exists = () => true) {
    if (!data || !Array.isArray(data.paths)) return new TabsModel();
    const paths = data.paths.filter((p) => typeof p === 'string' && p && exists(p));
    const active = typeof data.active === 'string' && paths.includes(data.active) ? data.active : null;
    return new TabsModel(paths, active);
  }

  _neighbourAt(idx) {
    if (this._paths.length === 0) return null;
    return this._paths[Math.min(idx, this._paths.length - 1)];
  }
}

/**
 * Short, unambiguous labels for a set of paths: the file name, and as many parent
 * folders as it takes to tell identically named files apart
 * ("a/notes.md" and "b/notes.md" -> "a/notes.md", "b/notes.md").
 *
 * @param {string[]} paths
 * @returns {Map<string, string>}
 */
export function tabLabels(paths) {
  const labels = new Map();
  const depth = new Map(paths.map((p) => [p, 0]));
  const labelAt = (p) => {
    const parts = p.split('/');
    const take = Math.min(parts.length, depth.get(p) + 1);
    return parts.slice(parts.length - take).join('/');
  };

  // Grow the label of every member of a clashing group until the group is unique
  // (bounded by the longest path, so it always terminates).
  for (let guard = 0; guard <= 64; guard++) {
    const groups = new Map();
    for (const p of paths) {
      const l = labelAt(p);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(p);
    }
    let grew = false;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const p of members) {
        if (depth.get(p) + 1 < p.split('/').length) {
          depth.set(p, depth.get(p) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  for (const p of paths) labels.set(p, labelAt(p) || basenameOf(p) || dirnameOf(p));
  return labels;
}

/** sessionStorage key for the tabs of one repository + branch. */
export function tabsStorageKey(owner, repo, branch) {
  return `mdeditor.tabs:${owner}/${repo}@${branch}`;
}
