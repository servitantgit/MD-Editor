import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';
import { Autosave, IDLE_MS, MAX_MS, LOCAL_WRITE_DEBOUNCE_MS, STATE, STATUS } from '../js/autosave.js';

const SCOPE = { owner: 'owner', repo: 'repo', branch: 'main' };

/**
 * An in-memory stand-in for DraftStore with the same public shape. The real
 * IndexedDB behaviour is pinned in test/draft-store.test.js; what matters HERE is
 * the state machine and the timers, and those must not depend on transaction
 * timing.
 */
function newFakeStore() {
  const records = new Map();
  const key = (ref) => `${ref.owner}/${ref.repo}@${ref.branch}:${ref.path}`;
  return {
    records,
    persistent: true,
    writes: 0,
    deletes: [],
    async put(rec) {
      this.writes++;
      records.set(key(rec), { ...rec, savedAt: 1234 });
      return true;
    },
    async get(ref) { return records.get(key(ref)) || null; },
    async delete(ref) { this.deletes.push(ref.path); records.delete(key(ref)); },
  };
}

/** A GitHubClient double that records every PUT and answers with a new sha. */
function newFakeClient({ failWith = null, sha = 'sha-fresh' } = {}) {
  const puts = [];
  const reads = [];
  let counter = 0;
  return {
    puts,
    reads,
    failWith, // read per call, so a test can make GitHub stop fighting back
    async putFile(path, b64, message, shaArg) {
      puts.push({ path, text: b64ToUtf8(b64), message, sha: shaArg });
      if (this.failWith) {
        const err = new Error('conflict');
        err.status = this.failWith;
        throw err;
      }
      return { content: { sha: `${sha}-${++counter}` } };
    },
    async getFileB64(path) {
      reads.push(path);
      return { b64: utf8ToB64('REMOTE-TEXT'), sha: 'sha-from-github' };
    },
  };
}

function newAutosave(overrides = {}) {
  const store = overrides.store || newFakeStore();
  const client = overrides.client || newFakeClient();
  const statuses = [];
  const conflicts = [];
  const commits = [];
  const reloads = [];
  const autosave = new Autosave({
    client,
    store,
    ...SCOPE,
    getText: () => autosave._text,
    onStatus: (s) => statuses.push(s),
    onConflict: (info) => conflicts.push(info),
    onRemoteCommit: (path, s) => commits.push({ path, sha: s }),
    onReloadRemote: (path, text, s) => reloads.push({ path, text, sha: s }),
    ...overrides.deps,
  });
  return { autosave, store, client, statuses, conflicts, commits, reloads };
}

const lastStatus = (statuses) => statuses[statuses.length - 1];
const statusTexts = (statuses) => statuses.filter(Boolean).map((s) => s.text);

/** Runs with a fake clock, so a "5 minutes" test costs no wall-clock time. */
function withTimers(fn) {
  return async (t) => {
    // reset() first as well as last: a test whose body throws part-way through
    // must never leave the clock enabled for the next one.
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await fn(t);
    } finally {
      mock.timers.reset();
    }
  };
}

/** Lets pending promise jobs settle without advancing the clock. */
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

/**
 * Advances the fake clock and then lets the microtask queue run.
 * node:test's MockTimers only ticks SYNCHRONOUSLY in this Node version, and
 * almost everything autosave does after a timer fires is promise-driven
 * (write the draft, then PUT), so ticking alone would assert nothing.
 */
const advance = async (ms) => { mock.timers.tick(ms); await drain(); };

test('a keystroke marks the file dirty and arms all three timers', withTimers(async () => {
  const { autosave, store, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('a');
  assert.equal(autosave.state, STATE.DIRTY_LOCAL);
  assert.equal(lastStatus(statuses).text, STATUS.unsaved.text);
  assert.equal(autosave.hasUnsavedDraft(), true);

  // Nothing is written per keystroke â€” 400ms is "finished the current word".
  await advance(LOCAL_WRITE_DEBOUNCE_MS - 1);
  assert.equal(store.writes, 0, 'the draft must be debounced, not written per keystroke');
  assert.equal(client.puts.length, 0, 'typing must never commit');

  await advance(1);
  assert.equal(store.writes, 1, 'the draft lands in the store after the debounce');
  assert.equal(store.records.get('owner/repo@main:a.md').text, 'a');
  assert.equal(autosave.state, STATE.DIRTY_IDLE);
  assert.equal(lastStatus(statuses).text, STATUS.drafted.text);

  // Still no commit: 400ms is nowhere near the idle window.
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  assert.equal(client.puts.length, 0, 'the local layer alone must never commit');
}));

test('the idle timer restarts on every keystroke (local only, no GitHub push)', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('v1');
  await advance(9_000);
  autosave.onChange('v2');           // 9s in: restarts the 10s idle timer
  await advance(9_000);
  assert.equal(client.puts.length, 0, 'the idle timer was restarted, so 10s is not reached');

  await advance(1_000); // t = 19s = 10s after the LAST keystroke
  await drain();
  assert.equal(client.puts.length, 0, 'idle never auto-pushes to GitHub');
  assert.equal(autosave.state, STATE.DIRTY_IDLE);
  assert.equal(lastStatus(statuses).text, STATUS.drafted.text);
  assert.equal(autosave.hasUnsavedDraft(), true);
}));

test('idle and continuous typing never auto-push; only saveNow does', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  let i = 0;
  while (i * 9_000 < MAX_MS) {
    autosave.onChange(`keystroke ${i}`);
    await advance(9_000);
    i++;
  }
  await advance(IDLE_MS + 1_000);
  await drain();
  assert.equal(client.puts.length, 0, 'no auto-push on idle or max');
  assert.equal(autosave.hasUnsavedDraft(), true);

  await autosave.saveNow();
  await drain();
  assert.equal(client.puts.length, 1, 'explicit Save writes to GitHub');
  assert.equal(autosave.state, STATE.CLEAN);
}));

test('a successful commit clears the draft and reports the new sha', withTimers(async () => {
  const { autosave, store, client, statuses, commits } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('NEW-TEXT');
  await autosave.saveNow();
  await drain();

  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0].sha, 'sha-0', 'the first commit needs the sha we loaded');
  assert.equal(client.puts[0].message, 'Update a.md', 'autosave commits look like manual ones');
  assert.equal(lastStatus(statuses).text, STATUS.saved.text);
  assert.equal(lastStatus(statuses).fade, true, 'only the saved label fades');
  assert.equal(autosave.baseSha, 'sha-fresh-1');
  assert.deepEqual(commits, [{ path: 'a.md', sha: 'sha-fresh-1' }]);
  assert.deepEqual(store.deletes, ['a.md'], 'a committed file keeps no draft');
}));

test('saveNow cancels timers and the next keystroke stays local until Save', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('v1');
  await autosave.saveNow();
  await drain();

  await advance(MAX_MS + IDLE_MS);
  assert.equal(client.puts.length, 1, 'no spurious commit after Save');

  autosave.onChange('v2');
  await advance(IDLE_MS);
  await drain();
  assert.equal(client.puts.length, 1, 'idle after edit does not push');
  await autosave.saveNow();
  await drain();
  assert.equal(client.puts.length, 2, 'second Save pushes v2');
}));

test('saveNow on a clean file does not create an empty commit', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  await autosave.saveNow();
  await drain();
  assert.equal(client.puts.length, 0, 'there is nothing to commit');
}));

test('typing during a push does not report the file as saved', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('FIRST');
  const pending = autosave.saveNow();

  // The user keeps typing while the request is in flight.
  autosave.onChange('SECOND');
  await pending;
  await drain();

  assert.equal(client.puts[0].text, 'FIRST', 'the in-flight snapshot is what was committed');
  assert.equal(autosave.state, STATE.DIRTY_LOCAL, 'the newer keystrokes are still unsaved');
  assert.notEqual(lastStatus(statuses).text, STATUS.saved.text);
  assert.equal(autosave.hasUnsavedDraft(), true);
}));

test('keystroke → Unsaved → idle → Local only (no auto GitHub save)', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('x');
  assert.deepEqual(statusTexts(statuses), [STATUS.unsaved.text]);

  await advance(IDLE_MS);
  await drain();

  assert.equal(statusTexts(statuses)[0], STATUS.unsaved.text);
  assert.equal(lastStatus(statuses).text, STATUS.drafted.text);
  assert.equal(client.puts.length, 0, 'idle does not commit');
  assert.equal(autosave.state, STATE.DIRTY_IDLE);

  await autosave.saveNow();
  await drain();
  assert.equal(client.puts.length, 1);
  assert.equal(autosave.state, STATE.CLEAN);
}));

test('the first 409 is retried silently with the fresh sha', withTimers(async () => {
  const { autosave, client, statuses, conflicts } = newAutosave({ client: newFakeClient({ failWith: 409 }) });
  // Fail only the FIRST put; the silent retry must succeed.
  const realPut = client.putFile.bind(client);
  let first = true;
  client.putFile = async (...args) => {
    if (first) { first = false; return realPut(...args); }
    client.failWith = null;
    return realPut(...args);
  };

  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('TEXT');
  await autosave.saveNow();
  await drain();

  assert.equal(client.puts.length, 2, 'the first attempt and exactly one retry');
  assert.equal(client.puts[0].sha, 'sha-0');
  assert.equal(client.puts[1].sha, 'sha-from-github', 'the retry carries the freshly read sha');
  assert.deepEqual(client.reads, ['a.md'], 'the fresh sha comes from the API');
  assert.equal(autosave.state, STATE.CLEAN);
  assert.deepEqual(conflicts, [], 'a single 409 is a race we settle ourselves, not an error');
  assert.equal(lastStatus(statuses).text, STATUS.saved.text);
}));

test('a second 409 in a row surfaces the reload / overwrite conflict and stops', withTimers(async () => {
  const { autosave, client, statuses, conflicts } = newAutosave({ client: newFakeClient({ failWith: 409 }) });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('TEXT');
  await autosave.saveNow();
  await drain();

  assert.equal(client.puts.length, 2, 'the silent retry happens, and then we stop');
  assert.equal(autosave.state, STATE.ERROR);
  assert.equal(conflicts.length, 1, 'the UI is asked to resolve it');
  assert.equal(conflicts[0].path, 'a.md');
  assert.match(lastStatus(statuses).text, /remote changed/);
  assert.equal(lastStatus(statuses).fade, false, 'a conflict must not fade away');

  // No third attempt, ever, until the user decides.
  await advance(MAX_MS + IDLE_MS);
  assert.equal(client.puts.length, 2, 'nothing retries behind the user’s back');
}));

test('overwrite pushes the local text on top of the fresh sha', withTimers(async () => {
  const { autosave, client } = newAutosave({ client: newFakeClient({ failWith: 409 }) });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('MY-TEXT');
  await autosave.saveNow();
  await drain();
  assert.equal(autosave.state, STATE.ERROR);

  client.failWith = null; // GitHub stops fighting back
  await autosave.resolveConflict('overwrite');
  await drain();

  const last = client.puts[client.puts.length - 1];
  assert.equal(last.sha, 'sha-from-github');
  assert.equal(last.text, 'MY-TEXT');
  assert.equal(autosave.state, STATE.CLEAN);
}));

test('reload drops the draft and hands the fresh GitHub text back', withTimers(async () => {
  const { autosave, store, reloads, conflicts } = newAutosave({ client: newFakeClient({ failWith: 409 }) });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('MY-TEXT');
  await autosave.saveNow();
  await drain();
  assert.equal(autosave.state, STATE.ERROR);
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  await autosave.resolveConflict('reload');
  await drain();

  assert.deepEqual(reloads, [{ path: 'a.md', text: 'REMOTE-TEXT', sha: 'sha-from-github' }]);
  assert.equal(autosave.state, STATE.CLEAN);
  assert.equal(autosave.hasUnsavedDraft(), false);
  assert.deepEqual(store.deletes, ['a.md'], 'the rejected draft is gone');
  assert.equal(conflicts.length, 1);
}));

test('a non-409 failure keeps the draft; user must Save again', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave({ client: newFakeClient({ failWith: 500 }) });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('x');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  await autosave.saveNow();
  await drain();
  assert.match(lastStatus(statuses).text, /Save failed/);
  assert.equal(autosave.hasUnsavedDraft(), true, 'the local draft survives a failed push');
  assert.equal(client.puts.length, 1);

  client.failWith = null;
  await advance(IDLE_MS);
  await drain();
  assert.equal(client.puts.length, 1, 'idle does not retry the push');

  await autosave.saveNow();
  await drain();
  assert.equal(client.puts.length, 2, 'explicit Save retries');
  assert.equal(autosave.state, STATE.CLEAN);
}));

test('flushCurrentFile writes the local draft only (no GitHub push)', withTimers(async () => {
  const { autosave, store, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('MID-EDIT');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  let pushedDuringFlush = null;
  client.putFile = (...args) => {
    pushedDuringFlush = args;
    return new Promise(() => {});
  };

  await autosave.flushCurrentFile();

  assert.equal(store.records.get('owner/repo@main:a.md').text, 'MID-EDIT',
    'the draft is already safe when the caller continues');
  assert.equal(pushedDuringFlush, null, 'flush does not start a GitHub put');
  assert.equal(autosave.state, STATE.DIRTY_IDLE);
  assert.equal(autosave.hasUnsavedDraft(), true);
}));

test('flushing a dirty file then opening another keeps the first draft local', withTimers(async () => {
  const { autosave, client, statuses, store } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE-A', 'sha-a');
  autosave.onChange('WORK-A');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  await autosave.flushCurrentFile();
  assert.equal(client.puts.length, 0, 'no push on flush');
  assert.equal(store.records.get('owner/repo@main:a.md').text, 'WORK-A');

  await autosave.onOpen('b.md', 'REMOTE-B', 'sha-b');
  assert.equal(client.puts.length, 0);
  assert.equal(autosave.state, STATE.CLEAN);

  const reopened = await autosave.onOpen('a.md', 'REMOTE-A', 'sha-a');
  assert.equal(reopened.hasDraft, true, 'the draft is still there');
}));

test('opening a file with a newer local draft offers it instead of merging', withTimers(async () => {
  const store = newFakeStore();
  const first = newAutosave({ store });
  await first.autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  first.autosave.onChange('DRAFT-TEXT');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  first.autosave.destroy();

  // A fresh session (page reload) opening the same file: GitHub still has the
  // old sha, the browser still has the newer text.
  const second = newAutosave({ store }).autosave;
  const opened = await second.onOpen('a.md', 'REMOTE', 'sha-0');

  assert.equal(opened.hasDraft, true);
  assert.equal(opened.draftText, 'DRAFT-TEXT');
  assert.equal(opened.remoteText, 'REMOTE');
  assert.equal(opened.text, 'REMOTE', 'the GitHub version loads until the user picks');
  assert.ok(opened.draftSavedAt > 0, 'the banner needs the age of the draft');
}));

test('a draft identical to the remote version raises no banner', withTimers(async () => {
  const { autosave, store } = newAutosave();
  autosave.onChange('SAME');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  autosave.destroy();

  const opened = await newAutosave({ store }).autosave.onOpen('a.md', 'SAME', 'sha-0');
  assert.equal(opened.hasDraft, false, 'nothing was changed, nothing to offer');
}));

test('a clean file opens with no label and no banner', withTimers(async () => {
  const { autosave, statuses } = newAutosave();
  const opened = await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  assert.equal(opened.hasDraft, false);
  assert.equal(opened.text, 'REMOTE');
  assert.equal(autosave.state, STATE.CLEAN);
  assert.equal(lastStatus(statuses), null);
  assert.equal(autosave.hasUnsavedDraft(), false);
}));

test('Keep local commits the draft on top of the sha we just loaded', withTimers(async () => {
  const store = newFakeStore();
  const first = newAutosave({ store });
  await first.autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  first.autosave.onChange('DRAFT-TEXT');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  first.autosave.destroy();

  const { autosave, client } = newAutosave({ store });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-fresh');
  autosave.resumeDraft('a.md', 'DRAFT-TEXT');

  assert.equal(autosave.hasUnsavedDraft(), true);
  await autosave.saveNow();
  await drain();

  assert.equal(client.puts[0].text, 'DRAFT-TEXT');
  assert.equal(client.puts[0].sha, 'sha-fresh', 'the draft lands on the CURRENT remote sha');
  assert.equal(autosave.state, STATE.CLEAN);
}));

test('Discard throws the draft away and leaves the remote text alone', withTimers(async () => {
  const store = newFakeStore();
  const first = newAutosave({ store });
  await first.autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  first.autosave.onChange('DRAFT-TEXT');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  first.autosave.destroy();

  const { autosave, client } = newAutosave({ store });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-fresh');
  autosave.resumeDraft('a.md', 'DRAFT-TEXT');
  await autosave.discardDraft('a.md');

  assert.equal(await store.get({ ...SCOPE, path: 'a.md' }), null);
  assert.equal(autosave.hasUnsavedDraft(), false);
  await advance(IDLE_MS + MAX_MS);
  assert.equal(client.puts.length, 0, 'a discarded draft must never be committed behind the user');
}));

test('hiding the tab checkpoints the local draft without pushing', withTimers(async () => {
  const { autosave, client, store } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('TAB-SWITCH');
  // Do not wait for debounce — visibility should force draft write
  autosave.onVisibilityChange(true);
  await drain();

  assert.equal(client.puts.length, 0, 'tab hide does not push');
  assert.equal(store.records.get('owner/repo@main:a.md').text, 'TAB-SWITCH');

  autosave.onVisibilityChange(false);
  await advance(IDLE_MS + MAX_MS);
  assert.equal(client.puts.length, 0);
}));

test('destroy() clears both timers and the autosave stops listening', withTimers(async () => {
  const { autosave, store, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('v1');

  autosave.destroy();

  await advance(LOCAL_WRITE_DEBOUNCE_MS + IDLE_MS + MAX_MS);
  assert.equal(client.puts.length, 0, 'no timer may survive destroy()');

  const writesBefore = store.writes;
  const statusesBefore = statuses.length;
  autosave.onChange('AFTER-DESTROY');
  await advance(LOCAL_WRITE_DEBOUNCE_MS + IDLE_MS + MAX_MS);

  assert.equal(store.writes, writesBefore, 'a destroyed autosave must not write drafts');
  assert.equal(client.puts.length, 0);
  assert.equal(autosave.hasUnsavedDraft(), false);
  assert.equal(statuses.length, statusesBefore, 'and it must not touch the status line either');

  // Teardown must be safe to repeat.
  autosave.destroy();
}));

test('release() forgets the file, ignores typing, and keeps the instance usable', withTimers(async () => {
  const { autosave, store, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('v1');
  assert.equal(autosave.hasUnsavedDraft(), true);

  autosave.release();
  assert.equal(autosave.hasUnsavedDraft(), false);
  assert.equal(lastStatus(statuses), null, 'the label is cleared');

  const writesBefore = store.writes;
  autosave.onChange('typed into the empty editor');
  await advance(LOCAL_WRITE_DEBOUNCE_MS + IDLE_MS + MAX_MS);
  assert.equal(client.puts.length, 0, 'with no file open, typing must never reach GitHub');
  assert.equal(store.writes, writesBefore, '...nor create a draft for a file that is not open');

  // Not destroyed: the next file opens normally.
  assert.equal(autosave.destroyed, false);
  await autosave.onOpen('b.md', 'B-REMOTE', 'sha-b');
  autosave.onChange('b edit');
  await advance(LOCAL_WRITE_DEBOUNCE_MS + IDLE_MS);
  assert.equal(client.puts.length, 0, 'idle still does not push after reopen');
  await autosave.saveNow();
  await drain();
  assert.deepEqual(client.puts.map((p) => [p.path, p.text]), [['b.md', 'b edit']]);
}));

test('a push already in flight when release() is called still finishes and deletes its draft', withTimers(async () => {
  const { autosave, store, client, commits } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('closing now');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  let finish;
  client.putFile = async (path, b64, message, sha) => {
    await new Promise((resolve) => { finish = resolve; });
    return { content: { sha: 'sha-landed' } };
  };

  const pending = autosave.saveNow(); // explicit Save starts the push
  // Let putFile run until it parks on `finish`
  for (let i = 0; i < 30 && typeof finish !== 'function'; i++) await Promise.resolve();
  assert.equal(typeof finish, 'function', 'push must be in flight');
  autosave.release();                // the tab is closed before the commit lands
  finish();
  await pending;
  await drain();

  assert.deepEqual(commits, [{ path: 'a.md', sha: 'sha-landed' }], 'the caller still hears about the new sha');
  assert.deepEqual(store.deletes, ['a.md'], 'and the draft is gone, so reopening shows no phantom banner');
}));

test('destroy() abandons an in-flight push without cleaning up (why release() exists)', withTimers(async () => {
  const { autosave, store, client, commits } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('closing now');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  let finish;
  client.putFile = async () => {
    await new Promise((resolve) => { finish = resolve; });
    return { content: { sha: 'sha-landed' } };
  };

  const pending = autosave.saveNow();
  for (let i = 0; i < 30 && typeof finish !== 'function'; i++) await Promise.resolve();
  assert.equal(typeof finish, 'function', 'push must be in flight');
  autosave.destroy();
  finish();
  try { await pending; } catch (_) {}
  await drain();

  assert.deepEqual(commits, []);
  assert.deepEqual(store.deletes, [], 'the stale draft stays behind');
}));
