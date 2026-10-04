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

test('the idle timer restarts on every keystroke, the max timer does not', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('v1');
  await advance(9_000);
  autosave.onChange('v2');           // 9s in: restarts the 10s idle timer
  await advance(9_000);
  assert.equal(client.puts.length, 0, 'the idle timer was restarted, so 10s is not reached');

  await advance(1_000); // t = 19s = 10s after the LAST keystroke
  await drain();
  assert.equal(client.puts.length, 1, '10s after the last keystroke it commits');
  assert.equal(client.puts[0].text, 'v2', 'the commit carries the latest text');
}));

test('10s idle pushes, and 5 minutes of continuous typing pushes too', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  // Type every 9 seconds for 5 minutes: the idle timer NEVER fires, so only the
  // max timer can save the user here.
  let i = 0;
  while (i * 9_000 < MAX_MS) {
    autosave.onChange(`keystroke ${i}`);
    await advance(9_000);
    i++;
  }

  assert.equal(i, Math.ceil(MAX_MS / 9_000));
  assert.equal(client.puts.length, 1, 'the 5-minute max timer fires even mid-type');
  assert.equal(lastStatus(statuses).text, STATUS.saved.text);
  assert.equal(autosave.state, STATE.CLEAN);
  assert.ok(statusTexts(statuses).includes(STATUS.saving.text), 'the label went through saving');
  assert.ok(statusTexts(statuses).includes(STATUS.unsaved.text), 'and through unsaved while typing');
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

test('saveNow cancels both timers and the next keystroke arms fresh ones', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('v1');
  await autosave.saveNow();
  await drain();

  // 5 minutes later, nothing else may fire: the cancelled max timer must stay
  // cancelled, or a single Save would schedule a spurious commit.
  await advance(MAX_MS + IDLE_MS);
  assert.equal(client.puts.length, 1, 'a cancelled timer must stay cancelled');

  autosave.onChange('v2');
  await advance(IDLE_MS);
  await drain();
  assert.equal(client.puts.length, 2, 'the next keystroke arms the window again');
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

test('keystroke → Unsaved → 10s idle → Saving → Saved, in that order', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('x');
  assert.deepEqual(statusTexts(statuses), [STATUS.unsaved.text]);

  await advance(IDLE_MS); // 400ms draft + 10s idle
  await drain();

  assert.deepEqual(
    statusTexts(statuses),
    [STATUS.unsaved.text, STATUS.drafted.text, STATUS.saving.text, STATUS.saved.text]
  );
  assert.equal(client.puts.length, 1, 'exactly one commit for the whole sequence');
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

test('a non-409 failure keeps the draft and retries on the next idle window', withTimers(async () => {
  const { autosave, store, client, statuses } = newAutosave({ client: newFakeClient({ failWith: 500 }) });
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');

  autosave.onChange('KEEPME');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  await autosave.saveNow();
  await drain();

  assert.equal(autosave.state, STATE.DIRTY_LOCAL, 'a failed commit leaves the file dirty');
  assert.match(lastStatus(statuses).text, /Save failed/);
  assert.equal(lastStatus(statuses).fade, false, 'errors are sticky');
  assert.ok(store.records.get('owner/repo@main:a.md'), 'the local draft survives a failed push');

  client.failWith = null; // the network comes back
  await advance(IDLE_MS);
  await drain();
  assert.equal(autosave.state, STATE.CLEAN, 'the next idle window tries again and succeeds');
}));

test('flushCurrentFile resolves after the DRAFT is written, not after the push', withTimers(async () => {
  const { autosave, store, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('MID-EDIT');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  let pushedDuringFlush = null;
  // Park the push forever: the point of the test is that the caller gets its
  // promise back while the network call is still outstanding.
  client.putFile = (...args) => {
    pushedDuringFlush = args;
    return new Promise(() => {});
  };

  await autosave.flushCurrentFile();

  assert.equal(store.records.get('owner/repo@main:a.md').text, 'MID-EDIT',
    'the draft is already safe when the caller continues');
  assert.ok(pushedDuringFlush, 'the commit was kicked off...');
  assert.equal(autosave.state, STATE.PUSHING, '...and is still in flight');
  assert.deepEqual(store.deletes, [], 'and has not finished, because the caller never waited');
}));

test('a failed background flush is reported on ITS file, not on the new one', withTimers(async () => {
  const { autosave, client, statuses } = newAutosave({ client: newFakeClient({ failWith: 500 }) });
  await autosave.onOpen('a.md', 'REMOTE-A', 'sha-a');
  autosave.onChange('WORK-A');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);

  const flush = autosave.flushCurrentFile();
  // The user opens another file before the push fails — which it will.
  await autosave.onOpen('b.md', 'REMOTE-B', 'sha-b');
  await flush;
  await drain();

  assert.equal(lastStatus(statuses), null, "a.md's failure must not be painted on b.md");
  assert.equal(autosave.state, STATE.CLEAN);

  // ...and it is waiting for a.md, not lost.
  const reopened = await autosave.onOpen('a.md', 'REMOTE-A', 'sha-a');
  assert.match(lastStatus(statuses).text, /Save failed/);
  assert.equal(reopened.hasDraft, true, 'the draft is still there to save the work');
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

test('hiding the tab commits at once instead of waiting out the idle window', withTimers(async () => {
  const { autosave, client } = newAutosave();
  await autosave.onOpen('a.md', 'REMOTE', 'sha-0');
  autosave.onChange('TAB-SWITCH');
  await advance(LOCAL_WRITE_DEBOUNCE_MS);
  assert.equal(client.puts.length, 0);

  autosave.onVisibilityChange(true); // document became hidden
  await drain();

  assert.equal(client.puts.length, 1, 'a tab switch is a natural checkpoint');
  assert.equal(client.puts[0].text, 'TAB-SWITCH');

  // A tab that becomes VISIBLE again must not commit anything.
  autosave.onVisibilityChange(false);
  await advance(IDLE_MS + MAX_MS);
  assert.equal(client.puts.length, 1);
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
