import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../js/demo-client.js';
import { ImageResolver } from '../js/image-resolver.js';
import { extractOutgoingLinks, linkMatchesPath } from '../js/backlinks.js';

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

// The enriched demo vault must be self-consistent: every embedded image must
// resolve through the real ImageResolver, and every wikilink/md-link target
// must match a seeded path (backlinks.js matcher). Catches moved/renamed
// seeds and wrong relative image paths.
test('demo vault: all images resolve, all internal links match a file', async () => {
  const client = new DemoClient();
  const tree = await client.getTree('main');
  const paths = tree.map((f) => f.path);
  assert.ok(paths.includes('Welcome.md'), 'vault must keep Welcome.md landing');
  assert.ok(paths.includes('Knowledge-base/index.md'), 'vault must keep KB hub');
  assert.ok(paths.length >= 20, `vault looks thin: only ${paths.length} files`);

  const resolver = new ImageResolver(client);
  const imgFail = [];
  const linkFail = [];
  for (const f of tree) {
    if (!f.path.endsWith('.md')) continue;
    const { b64 } = await client.getFileB64(f.path);
    const text = Buffer.from(b64, 'base64').toString('utf-8');
    for (const mm of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      try {
        await resolver.resolve(mm[1], f.path);
      } catch (e) {
        imgFail.push(`${f.path} -> ${mm[1]} (${e.message})`);
      }
    }
    for (const target of extractOutgoingLinks(f.path, text)) {
      if (!paths.some((p) => linkMatchesPath(target, p))) {
        linkFail.push(`${f.path} -> [[${target}]]`);
      }
    }
  }
  assert.deepEqual(imgFail, [], `broken demo images:\n${imgFail.join('\n')}`);
  assert.deepEqual(linkFail, [], `dangling demo links:\n${linkFail.join('\n')}`);
});
