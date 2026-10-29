import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindLifecycleListeners } from '../js/lifecycle.js';

function fakeTarget(extra = {}) {
  const handlers = {};
  return { ...extra, handlers, addEventListener(type, fn) { (handlers[type] ||= []).push(fn); } };
}

function fakeAutosave(unsaved) {
  return { unsaved, hidden: [], hasUnsavedDraft() { return this.unsaved; }, onVisibilityChange(h) { this.hidden.push(h); } };
}

function fakeEvent() {
  return { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
}

test('lifecycle: listeners are bound once per page, however many times it is called', () => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: 'visible' });
  assert.equal(bindLifecycleListeners({ win, doc, getAutosave: () => null }), true);
  assert.equal(bindLifecycleListeners({ win, doc, getAutosave: () => null }), false);
  assert.equal(win.handlers.beforeunload.length, 1);
  assert.equal(doc.handlers.visibilitychange.length, 1);
});

test('lifecycle: beforeunload prompts when there is an unsaved draft', () => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: 'visible' });
  bindLifecycleListeners({ win, doc, getAutosave: () => fakeAutosave(true) });
  const e = fakeEvent();
  win.handlers.beforeunload[0](e);
  assert.equal(e.prevented, true);
  assert.equal(e.returnValue, '');
});

test('lifecycle: no prompt when clean or when there is no autosave yet', () => {
  for (const autosave of [fakeAutosave(false), null]) {
    const win = fakeTarget();
    const doc = fakeTarget({ visibilityState: 'visible' });
    bindLifecycleListeners({ win, doc, getAutosave: () => autosave });
    const e = fakeEvent();
    win.handlers.beforeunload[0](e);
    assert.equal(e.prevented, false);
  }
});

test('lifecycle: hiding the tab checkpoints the draft, showing it does not', () => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: 'visible' });
  const autosave = fakeAutosave(true);
  bindLifecycleListeners({ win, doc, getAutosave: () => autosave });
  doc.handlers.visibilitychange[0]();
  assert.deepEqual(autosave.hidden, []);
  doc.visibilityState = 'hidden';
  doc.handlers.visibilitychange[0]();
  assert.deepEqual(autosave.hidden, [true]);
});

test('lifecycle: the autosave is read at event time (showApp rebuilds it)', () => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: 'visible' });
  let current = fakeAutosave(false);
  bindLifecycleListeners({ win, doc, getAutosave: () => current });
  current = fakeAutosave(true);
  const e = fakeEvent();
  win.handlers.beforeunload[0](e);
  assert.equal(e.prevented, true);
});