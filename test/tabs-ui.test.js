import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTabBar } from '../js/tabs-ui.js';

function setup() {
  const dom = new JSDOM('<!doctype html><body><div id="bar" class="hidden"></div></body>');
  const { document, MouseEvent, KeyboardEvent } = dom.window;
  const bar = document.getElementById('bar');
  const calls = { activate: [], close: [] };
  const ui = createTabBar(bar, {
    onActivate: (p) => calls.activate.push(p),
    onClose: (p) => calls.close.push(p),
  });
  const view = (paths, active, dirty = []) => ({
    paths,
    active,
    labels: new Map(paths.map((p) => [p, p.split('/').pop()])),
    dirty: new Set(dirty),
  });
  const click = (el, init = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  return { dom, document, bar, ui, calls, view, click, MouseEvent, KeyboardEvent };
}

test('renders one tab per path, marks the active and the unsaved ones', () => {
  const { bar, ui, view } = setup();
  ui.render(view(['Notes/a.md', 'b.md'], 'b.md', ['Notes/a.md']));
  const tabs = bar.querySelectorAll('.tab');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].querySelector('.tab-label').textContent, 'a.md');
  assert.equal(tabs[0].getAttribute('title'), 'Notes/a.md');
  assert.ok(tabs[0].classList.contains('dirty'));
  assert.ok(!tabs[1].classList.contains('dirty'));
  assert.ok(tabs[1].classList.contains('active'));
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
});

test('the strip is hidden with no tabs and shown with some', () => {
  const { bar, ui, view } = setup();
  assert.ok(bar.classList.contains('hidden'));
  ui.render(view(['a.md'], 'a.md'));
  assert.ok(!bar.classList.contains('hidden'));
  ui.render(view([], null));
  assert.ok(bar.classList.contains('hidden'));
  assert.equal(bar.children.length, 0);
});

test('a path is shown as text, never parsed as HTML', () => {
  const { bar, ui, document } = setup();
  const evil = 'x/<img src=x onerror=alert(1)>.md';
  ui.render({ paths: [evil], active: evil, labels: new Map([[evil, '<img src=x onerror=alert(1)>.md']]) });
  assert.equal(bar.querySelectorAll('img').length, 0);
  assert.equal(document.querySelector('.tab-label').textContent, '<img src=x onerror=alert(1)>.md');
  assert.equal(document.querySelector('.tab').dataset.path, evil);
});

test('clicking a tab activates it; clicking its × closes it without activating', () => {
  const { bar, ui, view, calls, click } = setup();
  ui.render(view(['a.md', 'b.md'], 'a.md'));
  click(bar.querySelectorAll('.tab')[1].querySelector('.tab-label'));
  assert.deepEqual(calls.activate, ['b.md']);
  click(bar.querySelectorAll('.tab')[0].querySelector('.tab-close'));
  assert.deepEqual(calls.close, ['a.md']);
  assert.deepEqual(calls.activate, ['b.md'], 'the × click must not also activate the tab');
});

test('middle-click closes, other auxiliary buttons do nothing', () => {
  const { bar, ui, view, calls, MouseEvent } = setup();
  ui.render(view(['a.md', 'b.md'], 'a.md'));
  const tab = bar.querySelectorAll('.tab')[1];
  tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }));
  assert.deepEqual(calls.close, []);
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
  tab.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, 'mousedown must be cancelled or browsers start auto-scroll');
  tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  assert.deepEqual(calls.close, ['b.md']);
});

test('arrow keys, Home and End move between tabs and wrap around', () => {
  const { bar, ui, view, calls, KeyboardEvent } = setup();
  ui.render(view(['a.md', 'b.md', 'c.md'], 'a.md'));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k }));
  const tabs = () => bar.querySelectorAll('.tab');
  key(tabs()[0], 'ArrowRight');
  key(tabs()[0], 'ArrowLeft'); // wraps to the last one
  key(tabs()[1], 'End');
  key(tabs()[1], 'Home');
  assert.deepEqual(calls.activate, ['b.md', 'c.md', 'c.md', 'a.md']);
});

test('roving tabindex: only the active tab is a tab stop', () => {
  const { bar, ui, view } = setup();
  ui.render(view(['a.md', 'b.md'], 'b.md'));
  const [a, b] = bar.querySelectorAll('.tab');
  assert.equal(a.tabIndex, -1);
  assert.equal(b.tabIndex, 0);
  ui.render(view(['a.md', 'b.md'], null));
  assert.equal(bar.querySelectorAll('.tab')[0].tabIndex, 0, 'with no active tab the first one is reachable');
});

test('re-rendering keeps keyboard focus on the same tab', () => {
  const { bar, ui, view, document } = setup();
  ui.render(view(['a.md', 'b.md'], 'a.md'));
  bar.querySelectorAll('.tab')[1].focus();
  assert.equal(document.activeElement.dataset.path, 'b.md');
  ui.render(view(['a.md', 'b.md'], 'b.md', ['b.md']));
  assert.equal(document.activeElement.dataset.path, 'b.md');
});

test('destroy detaches the listeners and empties the strip', () => {
  const { bar, ui, view, calls, click } = setup();
  ui.render(view(['a.md'], 'a.md'));
  const tab = bar.querySelector('.tab');
  ui.destroy();
  assert.equal(bar.children.length, 0);
  click(tab);
  assert.deepEqual(calls.activate, []);
});
