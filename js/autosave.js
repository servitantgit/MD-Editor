// autosave.js
// Two independent layers, on purpose:
//
//   LOCAL  (IndexedDB) — every keystroke, debounced 400ms. Crash recovery.
//                        Nothing here talks to GitHub.
//   REMOTE (GitHub)    — only on explicit Save (or multi-file Commit in app.js).
//                        Idle / max timers do NOT push — they only finish the
//                        local draft so Commit can accumulate changes.
//
// No DOM at all: the UI hands in a status setter and gets back a label to
// paint. Everything about the two timers is in AGENTS.md — read it before
// changing anything here, because collapsing them into one is the tempting
// mistake.

import { b64ToUtf8, utf8ToB64 } from './github-client.js';

/** "Finished the current word" — writing IDB per keystroke causes jank. */
export const LOCAL_WRITE_DEBOUNCE_MS = 400;
/** No keystrokes for this long means commit. Reset by every onChange. */
export const IDLE_MS = 10_000;
/** Hard ceiling: commit even mid-sentence. NOT reset by onChange. */
export const MAX_MS = 5 * 60 * 1000;

/**
 * The states. Transitions (pinned by test/autosave.test.js):
 *
 *   clean      --onChange-->            dirtyLocal   ● Unsaved
 *   dirtyLocal --400ms draft write-->   dirtyIdle    ○ Draft saved locally
 *   dirtyIdle  --onChange-->            dirtyLocal   (idle timer restarts)
 *   dirtyLocal --10s idle / local draft--> dirtyIdle  ○ Local only (not on GitHub)
 *   dirtyLocal --saveNow() / Commit----> pushing      ⟳ Saving to GitHub…
 *   dirtyIdle  --saveNow()-------------> pushing
 *   pushing    --putFile resolves-->    clean        ✓ Saved to GitHub
 *   pushing    --409 twice in a row-->   error        ⚠ reload or overwrite
 *   pushing    --any other error-->     dirtyLocal   ⚠ Save failed — use Save again
 *   error      --reload-->              clean        (fresh from GitHub)
 *   error      --overwrite-->           pushing      (push with the fresh sha)
 */
export const STATE = {
  CLEAN: 'clean',
  DIRTY_LOCAL: 'dirtyLocal',
  DIRTY_IDLE: 'dirtyIdle',
  PUSHING: 'pushing',
  ERROR: 'error',
};

/**
 * What the label next to Save shows. `fade: true` is the ONLY thing allowed to
 * disappear on its own (4s, like every other status message): the rest describe
 * the live state of the editor, and errors must stay until the next action.
 */
export const STATUS = {
  unsaved: { key: 'unsaved', text: '● Unsaved', variant: 'unsaved', fade: false },
  drafted: { key: 'drafted', text: '○ Local only — Save or Commit to push', variant: 'drafted', fade: false },
  saving: { key: 'saving', text: '⟳ Saving to GitHub…', variant: 'saving', fade: false },
  saved: { key: 'saved', text: '✓ Saved to GitHub', variant: 'ok', fade: true },
  error: (reason) => ({ key: 'error', text: `⚠ Save failed: ${reason}`, variant: 'err', fade: false }),
  conflict: (reason) => ({ key: 'conflict', text: `⚠ ${reason}`, variant: 'err', fade: false }),
};
export class Autosave {
  /**
   * @param {object} deps
   * @param {import('./github-client.js').GitHubClient} deps.client
   * @param {import('./draft-store.js').DraftStore} deps.store
   * @param {string} deps.owner
   * @param {string} deps.repo
   * @param {string} deps.branch
   * @param {() => string} deps.getText the editor's current value
   * @param {(status: object|null) => void} [deps.onStatus] receives the label to
   *   paint, or null to clear it
   * @param {(path: string, sha: string|null) => void} [deps.onRemoteCommit]
   *   after every successful commit, including a background one
   * @param {(info: {path: string, text: string}) => void} [deps.onConflict]
   *   second 409 in a row — the UI shows "reload / overwrite"
   * @param {(path: string, text: string, sha: string) => void} [deps.onReloadRemote]
   *   the user picked "reload": put this text in the editor
   * @param {number} [deps.debounceMs]
   * @param {number} [deps.idleMs]
   * @param {number} [deps.maxMs]
   */
  constructor({
    client, store, owner, repo, branch, getText,
    onStatus, onRemoteCommit, onConflict, onReloadRemote,
    debounceMs = LOCAL_WRITE_DEBOUNCE_MS, idleMs = IDLE_MS, maxMs = MAX_MS,
  }) {
    this.client = client;
    this.store = store;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.getText = getText || (() => '');
    this.onStatus = onStatus || (() => {});
    this.onRemoteCommit = onRemoteCommit || (() => {});
    this.onConflict = onConflict || (() => {});
    this.onReloadRemote = onReloadRemote || (() => {});
    this.debounceMs = debounceMs;
    this.idleMs = idleMs;
    this.maxMs = maxMs;

    this.state = STATE.CLEAN;
    this.path = null;
    this.baseSha = null;
    this.destroyed = false;

    this._text = '';
    this._draftTimer = null;
    this._idleTimer = null;
    this._maxTimer = null;
    this._pending = null;              // the push in flight for the CURRENT file
    this._backgroundErrors = new Map(); // path -> reason, surfaced on reopen
  }

  // ===== timers =====
  // setTimeout/clearTimeout are resolved at CALL time, not captured in the
  // constructor, so node:test's MockTimers can swap them underneath us.
  _after(fn, ms) { return setTimeout(fn, ms); }
  _cancel(timer) { if (timer !== null) clearTimeout(timer); }

  _clearTimers() {
    this._cancel(this._draftTimer); this._draftTimer = null;
    this._cancel(this._idleTimer); this._idleTimer = null;
    this._cancel(this._maxTimer); this._maxTimer = null;
  }

  _draftRef(path) {
    return { owner: this.owner, repo: this.repo, branch: this.branch, path };
  }

  _setStatus(status) {
    try { this.onStatus(status); } catch (_) { /* a broken UI must not break saving */ }
  }

  // ===== opening a file =====
  /**
   * Adopts `path` as the file being edited and reports whether a local draft
   * exists for it.
   *
   * The caller loads `text` into the editor and shows the banner when
   * `hasDraft` — there is no automatic merge, the user picks a side.
   * @returns {Promise<{hasDraft: boolean, draftText: string|null,
   *   remoteText: string, text: string, draftSavedAt: number}>}
   */
  async onOpen(path, remoteText, remoteSha) {
    if (this.destroyed) {
      return { hasDraft: false, draftText: null, remoteText, text: remoteText, draftSavedAt: 0 };
    }
    this._clearTimers();
    this._pending = null;
    this.path = path;
    this.baseSha = remoteSha || null;
    this._text = remoteText;
    this.state = STATE.CLEAN;

    const draft = await this.store.get(this._draftRef(path));
    if (this.destroyed || this.path !== path) {
      // Reopened another file while IndexedDB was answering — this answer is
      // about a file nobody is looking at any more.
      return { hasDraft: false, draftText: null, remoteText, text: remoteText, draftSavedAt: 0 };
    }

    const hasDraft = !!draft && draft.dirty !== false
      && (draft.baseSha !== remoteSha || draft.text !== remoteText);

    // A failure from a background flush is only ever shown when its own file
    // comes back — reporting it on whatever is open now would be a lie.
    const backgroundError = this._backgroundErrors.get(path);
    this._backgroundErrors.delete(path);
    if (backgroundError) {
      this.state = STATE.DIRTY_LOCAL;
      this._setStatus(STATUS.error(backgroundError));
    } else {
      this._setStatus(null);
    }

    return {
      hasDraft,
      draftText: hasDraft ? draft.text : null,
      remoteText,
      text: remoteText,
      draftSavedAt: draft ? draft.savedAt || 0 : 0,
    };
  }

  /** "Keep local": the draft becomes the edited text and is committed on the
   *  next window, on top of the sha we just loaded. */
  resumeDraft(path, text) {
    if (this.destroyed || this.path !== path) return;
    this._text = text;
    this._markDirty();
  }

  /** "Discard": drop the draft, keep the GitHub version already on screen. */
  async discardDraft(path) {
    if (this.destroyed) return;
    await this.store.delete(this._draftRef(path));
    if (this.path !== path) return;
    // The timers MUST go too. resumeDraft()/onChange() armed them for the text
    // the user just threw away, and an idle timer still ticking here would
    // commit the discarded draft a few seconds later — the exact opposite of
    // what "Discard" means.
    this._clearTimers();
    this._text = this.getText();
    this.state = STATE.CLEAN;
    this._setStatus(null);
  }
  // ===== typing =====
  /**
   * Called from the editor's change handler on EVERY keystroke. Deliberately
   * cheap and synchronous: it only arms timers and remembers the text. The
   * editor's own debounced preview render is a separate concern and is not
   * delayed by this.
   */
  onChange(text) {
    if (this.destroyed || !this.path) return;
    this._text = String(text == null ? '' : text);

    // A push already in flight captured its own snapshot. When it resolves it
    // notices the text moved on and re-arms, so there is nothing to do here —
    // arming a second push now would race it.
    if (this.state === STATE.PUSHING) return;
    this._markDirty();
  }

  _markDirty() {
    this.state = STATE.DIRTY_LOCAL;
    this._setStatus(STATUS.unsaved);
    this._armDraftWrite();
    this._armIdle();
    this._armMax();
  }

  /** Writing the draft is not user activity: this timer is NOT restarted by a
   *  draft write, only by a real keystroke. */
  _armDraftWrite() {
    this._cancel(this._draftTimer);
    this._draftTimer = this._after(() => {
      this._draftTimer = null;
      this._writeDraft();
    }, this.debounceMs);
  }

  /**
   * Restarted by every onChange. After idle: finish local draft only.
   * Does NOT push to GitHub (hybrid model: Save / Commit own the remote).
   */
  _armIdle() {
    this._cancel(this._idleTimer);
    this._idleTimer = this._after(() => {
      this._idleTimer = null;
      void this._onIdleLocal();
    }, this.idleMs);
  }

  /** Max timer kept for API compat but no longer auto-pushes. */
  _armMax() {
    // Intentionally empty: continuous typing no longer forces a GitHub commit.
    // Remote writes are Save / multi-file Commit only.
  }

  async _onIdleLocal() {
    if (this.destroyed || !this.path) return;
    if (this.state === STATE.PUSHING || this.state === STATE.CLEAN) return;
    // Ensure draft is on disk; paint "local only" status.
    this._cancel(this._draftTimer);
    this._draftTimer = null;
    await this._writeDraft();
    if (this.destroyed) return;
    if (this.state === STATE.DIRTY_LOCAL || this.state === STATE.DIRTY_IDLE) {
      this.state = STATE.DIRTY_IDLE;
      this._setStatus(STATUS.drafted);
    }
  }

  /** The LOCAL layer. Nothing here can touch the network. */
  async _writeDraft() {
    if (this.destroyed || !this.path) return false;
    const path = this.path;
    const written = await this.store.put({
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      path,
      text: this._text,
      baseSha: this.baseSha,
      dirty: true,
    });
    if (this.destroyed || this.path !== path) return written;
    // The debounced write IS the "local layer is done" boundary: before it the
    // label says Unsaved, after it "Draft saved locally" — still not on GitHub.
    if (this.state === STATE.DIRTY_LOCAL) {
      this.state = STATE.DIRTY_IDLE;
      this._setStatus(STATUS.drafted);
    }
    return written;
  }
  // ===== committing to GitHub =====
  /**
   * Commits the current file. `reason` is only for readability and for telling
   * a background flush apart.
   *
   * The draft is written FIRST and unconditionally: by the time we talk to the
   * network the user's text is already recoverable, whatever GitHub answers.
   */
  async _push(reason, { onDraftWritten } = {}) {
    if (this.destroyed || !this.path) return null;
    const task = {
      path: this.path,
      text: this._text,
      baseSha: this.baseSha,
      reason,
      // A flush must not report its failure on whatever the user opened next.
      background: reason === 'flush',
    };
    await this._writeDraft();
    if (onDraftWritten) onDraftWritten();
    if (this.destroyed) return null;

    // Deliberately NOT bailing out when the editor has already moved on to
    // another file. The task snapshot above (path/text/sha) is complete and
    // still exactly what the user asked to commit — dropping it here would lose
    // a commit the flush was explicitly started for. What must not happen is
    // the OUTCOME being painted on a different file, and that is guarded in
    // _afterCommit/_afterFailure, which compare against this.path.

    this._clearTimers();
    // A push for a file the user has already left must not put the CURRENT file
    // into "pushing" — the label next to Save describes what is on screen.
    if (this.path === task.path) {
      this.state = STATE.PUSHING;
      this._setStatus(STATUS.saving);
    }
    this._pending = this._runPush(task);
    return this._pending;
  }

  async _runPush(task) {
    let result;
    try {
      const data = await this._putWithRetry(task);
      const sha = (data && data.content && data.content.sha) || null;
      result = { ok: true, sha, status: 200 };
    } catch (err) {
      result = {
        ok: false,
        sha: null,
        status: (err && err.status) || 0,
        reason: String((err && err.message) || err),
      };
    }
    if (this.destroyed) return result;
    if (result.ok) this._afterCommit(task, result);
    else this._afterFailure(task, result);
    return result;
  }

  _put(task, sha) {
    // Same message format as the old manual Save: an autosave commit must be
    // indistinguishable from a manual one in the git log.
    return this.client.putFile(task.path, utf8ToB64(task.text), `Update ${task.path}`, sha);
  }

  /**
   * ONE silent retry on the FIRST sha conflict.
   *
   * With a 5-minute max timer a second tab editing the same file hits 409
   * constantly, and almost every one of those is just "the other tab committed
   * first" — a race we can settle ourselves by re-reading the sha and putting
   * again. Only a SECOND 409 in a row means both tabs keep committing on top of
   * each other, and that is the user's call, not ours.
   */
  async _putWithRetry(task) {
    try {
      return await this._put(task, task.baseSha);
    } catch (err) {
      if (!err || err.status !== 409) throw err;
      const fresh = await this.client.getFileB64(task.path);
      if (this.path === task.path) this.baseSha = fresh.sha;
      // A second 409 escapes from here and becomes the conflict UI.
      return this._put(task, fresh.sha);
    }
  }

  _afterCommit(task, result) {
    const sha = result.sha || task.baseSha;
    this.store.delete(this._draftRef(task.path)).catch(() => {});
    this.onRemoteCommit(task.path, sha);

    // A commit for a file that is no longer open changes nothing on screen.
    if (this.path !== task.path) return;
    this.baseSha = sha;

    // The user kept typing while the request was in flight, so what just landed
    // on GitHub is ALREADY stale. Going to `clean` here would throw those
    // keystrokes away — the file would look saved while differing from GitHub.
    if (this._text !== task.text) {
      this._markDirty();
      return;
    }
    this.state = STATE.CLEAN;
    this._setStatus(STATUS.saved);
  }

  _afterFailure(task, result) {
    if (result.status === 409) {
      this._backgroundErrors.set(task.path, 'remote version changed');
      if (this.path !== task.path) return;
      this.state = STATE.ERROR;
      this._setStatus(STATUS.conflict('remote changed, [reload] [overwrite]'));
      this.onConflict({ path: task.path, text: task.text });
      return;
    }
    // Any other failure: keep the draft; user must Save again (no auto-retry push).
    this._backgroundErrors.set(task.path, result.reason);
    if (this.path !== task.path) return;
    this.state = STATE.DIRTY_LOCAL;
    this._setStatus(STATUS.error(result.reason));
    this._armDraftWrite();
    this._armIdle();
  }

  /** The Save button: immediate commit, both timers cancelled. They stay
   *  cancelled afterwards — the next keystroke arms fresh ones. */
  /**
   * Cancel the 400ms debounce and write the draft now (fire-and-forget).
   * Used on pagehide so a reload milliseconds after the last keystroke still
   * recovers the text. IndexedDB is async — we cannot block unload, only start
   * the write as early as possible.
   */
  flushDraftSync() {
    if (this.destroyed || !this.path) return;
    if (this.state === STATE.CLEAN || this.state === STATE.PUSHING) return;
    this._cancel(this._draftTimer);
    this._draftTimer = null;
    // Keep current text from the editor if available
    try {
      if (this.getText) this._text = String(this.getText() || this._text || '');
    } catch (_) { /* ignore */ }
    this._writeDraft();
  }

  async saveNow() {
    if (this.destroyed || !this.path) return null;
    if (this.state === STATE.PUSHING) return this._pending;
    if (!this.hasUnsavedDraft() && this.state !== STATE.ERROR) return null;
    return this._push('manual');
  }
  /**
   * Called when the editor is about to show a different file (or none).
   *
   * Writes the draft and kicks the commit, and resolves as soon as the draft is
   * on disk — the commit continues in the background on purpose. Switching files
   * must feel instant, and the failure of a background commit is stored per-path
   * so it surfaces on THAT file, never on the one the user just opened.
   */
  /**
   * Leaving a file: persist the local draft only (no GitHub push).
   * Remote is Save on this file or Commit for the whole working tree.
   */
  async flushCurrentFile() {
    if (this.destroyed || !this.path) return;
    if (!this.hasUnsavedDraft()) {
      this._clearTimers();
      return;
    }
    this._cancel(this._draftTimer);
    this._draftTimer = null;
    this._cancel(this._idleTimer);
    this._idleTimer = null;
    await this._writeDraft();
    if (this.state === STATE.DIRTY_LOCAL || this.state === STATE.DIRTY_IDLE) {
      this.state = STATE.DIRTY_IDLE;
      this._setStatus(STATUS.drafted);
    }
  }

  /** The user hid the tab: local draft checkpoint only (no GitHub push). */
  onVisibilityChange(hidden) {
    if (!hidden || this.destroyed) return;
    // Local draft only — do not auto-push when switching browser tabs.
    this.flushDraftSync();
  }

  /** True while there is work that GitHub does not have yet. */
  hasUnsavedDraft() {
    return !this.destroyed && !!this.path
      && (this.state === STATE.DIRTY_LOCAL || this.state === STATE.DIRTY_IDLE);
  }

  /** The user's answer to the conflict dialog. */
  async resolveConflict(choice) {
    if (this.destroyed || !this.path || this.state !== STATE.ERROR) return null;
    const path = this.path;

    if (choice === 'reload') {
      const fresh = await this.client.getFileB64(path);
      let text;
      try {
        text = b64ToUtf8(fresh.b64);
      } catch (_) {
        // b64ToUtf8 THROWS on content that is not valid UTF-8, by design. Here
        // that means the "remote" file is a binary blob wearing a .md name:
        // do not decode it, do not overwrite it. Leave everything alone.
        this._setStatus(STATUS.error('the file on GitHub is not valid UTF-8 — nothing was changed'));
        return null;
      }
      await this.store.delete(this._draftRef(path));
      this._backgroundErrors.delete(path);
      this.baseSha = fresh.sha;
      this._text = text;
      this._clearTimers();
      this.state = STATE.CLEAN;
      this._setStatus(STATUS.saved);
      this.onReloadRemote(path, text, fresh.sha);
      return { reloaded: true, text };
    }

    // 'overwrite': take the fresh sha and put our text on top of it.
    const fresh = await this.client.getFileB64(path);
    this.baseSha = fresh.sha;
    return this._push('overwrite');
  }

  /** Clears every timer and stops accepting input. Idempotent, never throws —
   *  teardown code should never be the thing that breaks. */
  /**
   * Lets go of the current file WITHOUT stopping the instance (closing a tab,
   * deleting the open file). Timers are cancelled and typing is ignored from here
   * on because there is no path any more, but a push that is already in flight
   * keeps going and cleans up after itself — deletes its draft and reports the
   * new sha. destroy() would abandon it: a destroyed instance skips that
   * clean-up, which leaves a stale draft that later looks like unsaved work.
   */
  release() {
    if (this.destroyed) return;
    this._clearTimers();
    this.path = null;
    this.baseSha = null;
    this._text = '';
    this._pending = null;
    this.state = STATE.CLEAN;
    this._setStatus(null);
  }

  destroy() {
    this._clearTimers();
    this.destroyed = true;
  }
}