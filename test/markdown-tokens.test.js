import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import {
  parseImgTagAttrs,
  injectCanonicalImageTags,
  markdownToCanonicalHtml,
  setImageAttrsInLine,
  TRANSPARENT_PIXEL,
} from '../js/markdown-tokens.js';

test('parseImgTagAttrs extracts src/alt/width from a raw <img> tag', () => {
  const attrs = parseImgTagAttrs('<img src="/a/b.png" alt="hello" width="320">');
  assert.deepEqual(attrs, { src: '/a/b.png', alt: 'hello', width: '320' });
});

test('parseImgTagAttrs tolerates single quotes and missing attributes', () => {
  const attrs = parseImgTagAttrs("<img src='x.jpg'>");
  assert.equal(attrs.src, 'x.jpg');
  assert.equal(attrs.alt, '');
  assert.equal(attrs.width, '');
});

test('injectCanonicalImageTags replaces markdown images with canonical <img> carrying data-md-src', () => {
  const text = '![image](../../Asset/pic.jpg)\n';
  const out = injectCanonicalImageTags(text);
  assert.match(out, /data-md-src="\.\.\/\.\.\/Asset\/pic\.jpg"/);
  assert.match(out, new RegExp(TRANSPARENT_PIXEL.replace(/[+/=]/g, '\\$&')));
  assert.match(out, /data-md-line="0"/);
  assert.match(out, /data-md-occ="0"/);
});

test('injectCanonicalImageTags numbers multiple images on the same line independently', () => {
  const text = '![a](x.jpg) and ![b](y.jpg)\n';
  const out = injectCanonicalImageTags(text);
  assert.match(out, /data-md-occ="0" data-md-src="x\.jpg"/);
  assert.match(out, /data-md-occ="1" data-md-src="y\.jpg"/);
  const occs = [...out.matchAll(/data-md-occ="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(occs, ['0', '1']);
});

test('markdownToCanonicalHtml renders real content via marked and preserves img attributes', () => {
  const sample = [
    '# ATS Housing LOAD/UNLOAD',
    '',
    '**[ENG]** Instrukcja obsługi',
    '',
    '![image](../../Asset/ATS_Housing_LOAD-UNLOAD_image_0001.jpg)',
    '',
  ].join('\n');

  const html = markdownToCanonicalHtml(sample, marked);
  assert.match(html, /<h1>ATS Housing LOAD\/UNLOAD<\/h1>/);
  assert.match(html, /class="md-img-wrap loading"/);
  assert.match(
    html,
    /data-md-src="\.\.\/\.\.\/Asset\/ATS_Housing_LOAD-UNLOAD_image_0001\.jpg"/
  );
  // сама картинка не повинна "загубитись" всередині параграфа
  assert.match(html, /<p>.*<span class="md-img-wrap.*<\/span><\/p>/s);
});

test('markdownToCanonicalHtml throws a clear error when renderer is missing/invalid', () => {
  assert.throws(() => markdownToCanonicalHtml('# x', null), /markdown-рендерер/);
  assert.throws(() => markdownToCanonicalHtml('# x', {}), /markdown-рендерер/);
});

test('setImageAttrsInLine rewrites only the targeted occurrence on the line', () => {
  const line = '![a](x.jpg) ![b](y.jpg)';
  const updated = setImageAttrsInLine(line, 1, { src: 'y.jpg', alt: 'b', width: '400' });
  assert.equal(updated, '![a](x.jpg) <img src="y.jpg" alt="b" width="400">');
});
