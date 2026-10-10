import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../js/demo-client.js';
import { ImageResolver } from '../js/image-resolver.js';

// Regression: 'Notes/Sample note.md' embedded `assets/demo-note.svg`,
// which resolves (relative to Notes/) to `Notes/assets/demo-note.svg`
// — a path that does not exist in the demo store, so Live/Preview showed
// a broken image. The seed must reference `../assets/demo-note.svg`.
test('demo Sample note image resolves to the seeded svg (not broken)', async () => {
  const client = new DemoClient();
  const tree = await client.getTree('main');
  const paths = tree.map((f) => f.path);
  assert.ok(paths.includes('Notes/Sample note.md'));
  assert.ok(paths.includes('assets/demo-note.svg'));

  const { b64 } = await client.getFileB64('Notes/Sample note.md');
  const text = Buffer.from(b64, 'base64').toString('utf-8');
  const m = text.match(/!\[Demo diagram\]\(([^)]+)\)/);
  assert.ok(m, 'Sample note must contain the Demo diagram image');
  const src = m[1];

  const resolver = new ImageResolver(client);
  const url = await resolver.resolve(src, 'Notes/Sample note.md');
  assert.ok(
    url.startsWith('data:image/svg+xml;base64,'),
    `image src "${src}" must resolve to an svg data URL, got: ${url.slice(0, 60)}`
  );
});
