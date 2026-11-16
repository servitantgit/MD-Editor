import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { getPurifier } from '../js/purifier.js';

const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window;

test('sanitize keeps safe content', () => {
  const purifier = getPurifier(win);
  const result = purifier.sanitize('<img src=x onerror=alert(1)><p>ok</p>');
  assert.doesNotMatch(result, /onerror/);
  assert.match(result, /<p>ok<\/p>/);
});

test('returns the same instance twice with the same window', () => {
  const purifier1 = getPurifier(win);
  const purifier2 = getPurifier(win);
  assert.strictEqual(purifier1, purifier2);
});

test('returns different instances for different windows', () => {
  const win2 = new JSDOM('<!DOCTYPE html><html><body></body></html>').window;
  const purifier1 = getPurifier(win);
  const purifier2 = getPurifier(win2);
  assert.notStrictEqual(purifier1, purifier2);
});

test('throws when called with null', () => {
  assert.throws(() => getPurifier(null), /window/);
});