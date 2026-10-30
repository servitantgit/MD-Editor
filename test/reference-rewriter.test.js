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
  const text = 'See [BOBAM ON-OFF](../BOBAM/BOBAM%20ON-OFF.md)\n';
  const { changed, text: out } = updateReferencesInFile(
    text,
    'AI corrected/Other',
    'AI corrected/BOBAM/BOBAM ON-OFF.md',
    'AI corrected/BOBAM/sub/BOBAM ON-OFF.md'
  );
  assert.equal(changed, true);
  assert.match(out, /BOBAM\/sub\/BOBAM%20ON-OFF\.md/);
});

test('rewriteOwnRelativeLinks leaves links inside fenced code blocks untouched', () => {
  const text = [
    '![a](../Asset/x.jpg)',
    '```',
    '![a](../Asset/x.jpg)',
    '[n](../BOBAM/README.md)',
    '```',
    '~~~',
    '[n](../BOBAM/README.md)',
    '~~~',
    '',
  ].join('\n');
  const expected = [
    '![a](../../Asset/x.jpg)',
    '```',
    '![a](../Asset/x.jpg)',
    '[n](../BOBAM/README.md)',
    '```',
    '~~~',
    '[n](../BOBAM/README.md)',
    '~~~',
    '',
  ].join('\n');
  assert.equal(rewriteOwnRelativeLinks(text, 'a/b', 'a/b/c'), expected);
});

test('updateReferencesInFile rewrites a link outside fenced code but not the same link inside it', () => {
  const text = ['![img](/Asset/old.jpg)', '```', '![img](/Asset/old.jpg)', '```', ''].join('\n');
  const { changed, text: out } = updateReferencesInFile(text, 'docs', 'Asset/old.jpg', 'Asset/new.jpg');
  assert.equal(changed, true);
  assert.equal(out, ['![img](/Asset/new.jpg)', '```', '![img](/Asset/old.jpg)', '```', ''].join('\n'));
});

test('updateReferencesInFile reports no change when the only matching link is inside fenced code', () => {
  const text = 'Example:\n~~~\n[note](../BOBAM/README.md)\n~~~\n';
  const { changed, text: out } = updateReferencesInFile(
    text,
    'AI corrected/Other',
    'AI corrected/BOBAM/README.md',
    'AI corrected/BOBAM/sub/README.md'
  );
  assert.equal(changed, false);
  assert.equal(out, text);
});

test('updateReferencesInFile leaves links inside inline code untouched', () => {
  for (const text of ['See `[a](b.md)` here\n', 'x ``[a](b.md)`` y\n']) {
    const { changed, text: out } = updateReferencesInFile(text, '', 'b.md', 'x/b.md');
    assert.equal(changed, false, text);
    assert.equal(out, text);
  }
});

test('updateReferencesInFile rewrites a real link next to inline code but not the code', () => {
  const { changed, text: out } = updateReferencesInFile('`[a](b.md)` and [c](b.md)\n', '', 'b.md', 'x/b.md');
  assert.equal(changed, true);
  assert.equal(out, '`[a](b.md)` and [c](x/b.md)\n');
});

test('rewriteOwnRelativeLinks leaves an image inside inline code untouched', () => {
  const out = rewriteOwnRelativeLinks('`![i](../a.png)` ![j](../a.png)\n', 'd', 'd/e');
  assert.equal(out, '`![i](../a.png)` ![j](../../a.png)\n');
});

test('links with code in the text, lone backticks and backticks across paragraphs are still rewritten', () => {
  const cases = [
    ['[`b.md`](b.md)\n', '[`b.md`](x/b.md)\n'],
    ['a ` b [a](b.md)\n', 'a ` b [a](x/b.md)\n'],
    ['a `\n\n[a](b.md) `\n', 'a `\n\n[a](x/b.md) `\n'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(updateReferencesInFile(text, '', 'b.md', 'x/b.md').text, expected, text);
  }
});
