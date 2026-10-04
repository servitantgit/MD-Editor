import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';

// Buffer is used as an INDEPENDENT reference codec, so this proves the new
// TextEncoder/TextDecoder path agrees with a real UTF-8 implementation rather
// than just agreeing with the previous escape/unescape trick.
const SAMPLES = ['', 'hello world', 'a\nb\tc', 'Привіт, світе!', '€ — 100 £', '🎉🚀 emoji', '日本語のテキスト', 'Ω≈ç√∫˜µ≤≥÷'];

test('utf8ToB64 produces the same base64 as a reference UTF-8 encoder', () => {
  for (const s of SAMPLES) {
    assert.equal(utf8ToB64(s), Buffer.from(s, 'utf8').toString('base64'), `for ${JSON.stringify(s)}`);
  }
});

test('b64ToUtf8 decodes what the reference encoder produced', () => {
  for (const s of SAMPLES) {
    assert.equal(b64ToUtf8(Buffer.from(s, 'utf8').toString('base64')), s, `for ${JSON.stringify(s)}`);
  }
});

test('round-trip survives every sample', () => {
  for (const s of SAMPLES) assert.equal(b64ToUtf8(utf8ToB64(s)), s);
});

test('b64ToUtf8 THROWS on bytes that are not valid UTF-8', () => {
  // A lone continuation byte can never start a UTF-8 sequence. Callers depend on
  // this throwing so they can leave such content untouched — a silent U+FFFD
  // substitution would instead get written back to GitHub as corruption.
  assert.throws(() => b64ToUtf8(Buffer.from([0x80]).toString('base64')));
  assert.throws(() => b64ToUtf8(Buffer.from([0x68, 0x80, 0x69]).toString('base64')));
  // Truncated multi-byte sequence.
  assert.throws(() => b64ToUtf8(Buffer.from([0xe2, 0x82]).toString('base64')));
  // Overlong encoding of "/" — rejected by both decoders.
  assert.throws(() => b64ToUtf8(Buffer.from([0xc0, 0xaf]).toString('base64')));
});

test('malformed base64 still throws', () => {
  assert.throws(() => b64ToUtf8('not valid base64!!!'));
});