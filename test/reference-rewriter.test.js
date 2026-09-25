import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteOwnRelativeLinks, updateReferencesInFile } from '../js/reference-rewriter.js';

test('rewriteOwnRelativeLinks keeps pointing at the same target after the file moves deeper', () => {
  const text = '![sensor](../../Asset/Laser_sensor_image_0001.jpg)\n';
  const out = rewriteOwnRelativeLinks(text, 'AI corrected/BOBAM', 'AI corrected/BOBAM/sub');
  assert.equal(out, '![sensor](../../../Asset/Laser_sensor_image_0001.jpg)\n');
});

test('rewriteOwnRelativeLinks leaves root-relative and external links untouched', () => {
  const text = '![a](/Asset/x.jpg) [ext](https://example.com) [note](onenote:Page)\n';
  const out = rewriteOwnRelativeLinks(text, 'a/b', 'a/b/c');
  assert.equal(out, text);
});

test('rewriteOwnRelativeLinks is a no-op when the directory does not actually change', () => {
  const text = '![a](../Asset/x.jpg)\n';
  assert.equal(rewriteOwnRelativeLinks(text, 'a/b', 'a/b'), text);
});

test('rewriteOwnRelativeLinks also fixes plain markdown links, not just images', () => {
  const text = 'See [BOBAM notes](../BOBAM/README.md) for details.\n';
  const out = rewriteOwnRelativeLinks(text, 'AI corrected/Hardware', 'AI corrected/Hardware/sub');
  assert.equal(out, 'See [BOBAM notes](../../BOBAM/README.md) for details.\n');
});

test('updateReferencesInFile rewrites a relative reference that resolves to the moved file', () => {
  const text = '![img](../../Asset/Laser_sensor_image_0001.jpg)\n';
  const { changed, text: out } = updateReferencesInFile(
    text,
    'AI corrected/BOBAM',
    'Asset/Laser_sensor_image_0001.jpg',
    'Asset/renamed.jpg'
  );
  assert.equal(changed, true);
  assert.equal(out, '![img](../../Asset/renamed.jpg)\n');
});

test('updateReferencesInFile rewrites a root-relative reference to the moved file', () => {
  const text = '![img](/Asset/old.jpg)\n';
  const { changed, text: out } = updateReferencesInFile(text, 'docs', 'Asset/old.jpg', 'Asset/new.jpg');
  assert.equal(changed, true);
  assert.equal(out, '![img](/Asset/new.jpg)\n');
});

test('updateReferencesInFile does not touch unrelated references', () => {
  const text = '![img](../../Asset/other.jpg)\n';
  const { changed, text: out } = updateReferencesInFile(
    text,
    'AI corrected/BOBAM',
    'Asset/Laser_sensor_image_0001.jpg',
    'Asset/renamed.jpg'
  );
  assert.equal(changed, false);
  assert.equal(out, text);
});

test('updateReferencesInFile fixes a plain markdown link pointing at a moved .md file', () => {
  const text = 'Дивись [BOBAM ON-OFF](../BOBAM/BOBAM%20ON-OFF.md)\n';
  const { changed, text: out } = updateReferencesInFile(
    text,
    'AI corrected/Other',
    'AI corrected/BOBAM/BOBAM ON-OFF.md',
    'AI corrected/BOBAM/sub/BOBAM ON-OFF.md'
  );
  assert.equal(changed, true);
  assert.match(out, /BOBAM\/sub\/BOBAM%20ON-OFF\.md/);
});
