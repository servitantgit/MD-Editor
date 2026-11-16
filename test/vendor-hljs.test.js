// highlight.js "lib/core" ships ZERO languages: code blocks silently lose highlighting
// and no other test notices (found after the Vite phase 1 migration).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/vendor.js', import.meta.url), 'utf8');

test('vendor.js loads a highlight.js build that includes languages', () => {
  assert.ok(!/highlight\.js\/lib\/core/.test(src), 'lib/core has no languages');
  assert.match(src, /from 'highlight\.js(\/lib\/common)?'/);
});

test('highlight.js "common" build really has the languages the editor shows', async () => {
  const { default: hljs } = await import('highlight.js/lib/common');
  for (const lang of ['javascript', 'python', 'json', 'bash', 'css', 'xml', 'markdown']) {
    assert.ok(hljs.getLanguage(lang), lang);
  }
});
