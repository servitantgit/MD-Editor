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
import { REF_TOKEN_RE, classifyRefMatch } from '../js/markdown-tokens.js';
import { findMarkdownImages } from '../js/markdown-tokens.js';

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
    '**[ENG]** Operating instructions',
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
  // the image itself must not get "lost" inside a paragraph
  assert.match(html, /<p>.*<span class="md-img-wrap.*<\/span><\/p>/s);
});

test('markdownToCanonicalHtml throws a clear error when renderer is missing/invalid', () => {
  assert.throws(() => markdownToCanonicalHtml('# x', null), /markdown renderer/);
  assert.throws(() => markdownToCanonicalHtml('# x', {}), /markdown renderer/);
});

test('setImageAttrsInLine rewrites only the targeted occurrence on the line', () => {
  const line = '![a](x.jpg) ![b](y.jpg)';
  const updated = setImageAttrsInLine(line, 1, { src: 'y.jpg', alt: 'b', width: '400' });
  assert.equal(updated, '![a](x.jpg) <img src="y.jpg" alt="b" width="400">');
});

test('injectCanonicalImageTags leaves images inside fenced code blocks as plain text', () => {
  const text = 'Example:\n```\n![a](x.jpg)\n```\n~~~\n<img src="y.png">\n~~~\n';
  assert.equal(injectCanonicalImageTags(text), text);
});

test('injectCanonicalImageTags keeps whole-text line numbers for images after a code block', () => {
  const text = '![a](x.jpg)\n```\n![b](y.jpg)\n```\n![c](z.jpg)\n';
  const out = injectCanonicalImageTags(text);
  assert.ok(out.includes('```\n![b](y.jpg)\n```\n'), 'image inside the fence must stay literal');
  assert.ok(!out.includes('data-md-src="y.jpg"'), 'image inside the fence must not become a canonical tag');
  assert.match(out, /data-md-line="0" data-md-occ="0" data-md-src="x\.jpg"/);
  assert.match(out, /data-md-line="4" data-md-occ="0" data-md-src="z\.jpg"/);
});

test('markdownToCanonicalHtml renders an image inside a fenced block as code, not as a preview image', () => {
  const html = markdownToCanonicalHtml('```\n![a](x.jpg)\n```\n', marked);
  assert.match(html, /<pre><code>!\[a\]\(x\.jpg\)/);
  assert.doesNotMatch(html, /md-img-wrap/);
});

// Imported inside each test: until findMarkdownImages exists every test fails
// on its own (TypeError) instead of the whole file failing to load.
const loadTokens = () => import('../js/markdown-tokens.js');
const imageSrcs = async (text) => (await loadTokens()).findMarkdownImages(text).map((m) => m.src);

test('findMarkdownImages: finds an image outside code with exact positions', async () => {
  const { findMarkdownImages } = await loadTokens();
  assert.deepEqual(findMarkdownImages('a ![x](p.png) b'), [
    { fromIndex: 2, toIndex: 13, alt: 'x', src: 'p.png', raw: '![x](p.png)' },
  ]);
});

test('findMarkdownImages: skips an image inside a fenced code block', async () => {
  assert.deepEqual(await imageSrcs('```\n![a](a.png)\n```\n![b](b.png)'), ['b.png']);
});

test('findMarkdownImages: skips an image inside a fence inside a blockquote', async () => {
  assert.deepEqual(await imageSrcs('> ```\n> ![a](a.png)\n> ```\n\n![b](b.png)'), ['b.png']);
});

test('findMarkdownImages: skips an image inside inline code', async () => {
  assert.deepEqual(await imageSrcs('see `![a](a.png)` and ![b](b.png)'), ['b.png']);
});

test('injectCanonicalImageTags: an image inside inline code stays text', async () => {
  const { injectCanonicalImageTags } = await loadTokens();
  const src = 'see `![a](a.png)` here';
  assert.equal(injectCanonicalImageTags(src), src);
});

test('injectCanonicalImageTags: a raw <img> inside inline code stays text', async () => {
  const { injectCanonicalImageTags } = await loadTokens();
  const src = 'tag `<img src="x.png">` here';
  assert.equal(injectCanonicalImageTags(src), src);
});

test('injectCanonicalImageTags: an image after a code example on the same line keeps its occurrence index', async () => {
  // setImageAttrsInLine counts every image on the line, code examples included.
  const { injectCanonicalImageTags } = await loadTokens();
  const out = injectCanonicalImageTags('see `![a](a.png)` then ![b](b.png)');
  assert.ok(out.includes('`![a](a.png)`'), 'the code example must stay text: ' + out);
  assert.ok(out.includes('data-md-occ="1" data-md-src="b.png"'), 'b.png must be occurrence 1: ' + out);
});

test('injectCanonicalImageTags: a known image is written resolved, without the loading placeholder', async () => {
  const { injectCanonicalImageTags } = await loadTokens();
  const out = injectCanonicalImageTags('![a](a.png)\n\n![b](b.png)', {
    knownSrc: (src) => (src === 'a.png' ? 'data:image/png;base64,QUJD' : null),
  });
  const [a, b] = out.split('\n\n');
  assert.ok(a.includes('src="data:image/png;base64,QUJD"'), a);
  assert.ok(!a.includes('md-img-wrap loading'), 'a known image must not collapse to a placeholder: ' + a);
  assert.ok(b.includes('md-img-wrap loading') && b.includes('data:image/gif;base64,'), 'an unknown image still loads: ' + b);
});

test('renderMarkdownSafe passes knownSrc down to the canonical image tags', async () => {
  const { renderMarkdownSafe } = await import('../js/sanitize-html.js');
  const html = renderMarkdownSafe('![a](a.png)', { parse: (t) => t }, { sanitize: (h) => h }, {
    knownSrc: () => 'data:image/png;base64,QUJD',
  });
  assert.ok(html.includes('src="data:image/png;base64,QUJD"'), html);
  assert.ok(!html.includes('md-img-wrap loading'), html);
});

// Link forms (Architecture rule 3): buildFileLink writes [x](</A/a b.md>) for a
// path with a space or parenthesis; every reader parses it through REF_TOKEN_RE.
function lfTokens(text) {
  const re = new RegExp(REF_TOKEN_RE.source, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(classifyRefMatch(m[0], m[1], m[2], m[3], m[4], m[5], m[6]));
  return out;
}

test('link forms: REF_TOKEN_RE reads a link target in <...> with spaces', () => {
  const t = lfTokens('[x](</A/a b.md>)');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'link-md');
  assert.equal(t[0].target, '/A/a b.md');
  assert.equal(t[0].angle, true);
});

test('link forms: REF_TOKEN_RE reads an image target in <...> with spaces', () => {
  const t = lfTokens('![p](</A/a b.png>)');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'img-md');
  assert.equal(t[0].target, '/A/a b.png');
  assert.equal(t[0].angle, true);
});

test('link forms: <...> without a space also loses its brackets', () => {
  const t = lfTokens('[x](</A/a.md>)');
  assert.equal(t.length, 1);
  assert.equal(t[0].target, '/A/a.md');
  assert.equal(t[0].angle, true);
});

test('link forms: a plain link with a title is unchanged (guard)', () => {
  const t = lfTokens('[x](B.md "t")');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'link-md');
  assert.equal(t[0].target, 'B.md');
  assert.equal(t[0].title, 't');
  assert.notEqual(t[0].angle, true);
});

// Parentheses in a target: one level of balanced (...) is part of the path
// (Asset/ATS_(BOB_Load)_image_0001.jpg). Every reader shares one target rule;
// before, the target was cut at the first ")" (5f57fdf deleted 32 such images).
test('parens: REF_TOKEN_RE keeps parentheses in an image target', () => {
  const t = lfTokens('![x](../A/a_(b)_1.jpg)');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'img-md');
  assert.equal(t[0].target, '../A/a_(b)_1.jpg');
});

test('parens: REF_TOKEN_RE keeps parentheses in a link target', () => {
  const t = lfTokens('[x](A/n_(1).md)');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'link-md');
  assert.equal(t[0].target, 'A/n_(1).md');
});

test('parens: Preview gets the whole image path', () => {
  const html = injectCanonicalImageTags('![x](../A/a_(b)_1.jpg)');
  assert.ok(html.includes('data-md-src="../A/a_(b)_1.jpg"'), html);
  assert.ok(!html.includes('_1.jpg)'), html);
});

test('parens: Source image widgets get the whole image path', () => {
  const found = findMarkdownImages('see ![x](../A/a_(b)_1.jpg) end');
  assert.equal(found.length, 1);
  assert.equal(found[0].src, '../A/a_(b)_1.jpg');
  assert.equal(found[0].raw, '![x](../A/a_(b)_1.jpg)');
});

test('parens: a plain image path in Preview is unchanged (guard)', () => {
  const html = injectCanonicalImageTags('![x](../A/b.png)');
  assert.ok(html.includes('data-md-src="../A/b.png"'), html);
});
