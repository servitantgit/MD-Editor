import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { markdownToCanonicalHtml } from '../js/markdown-tokens.js';
import { resolveAllImages } from '../js/image-preview.js';

function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="preview"></div></body>`);
  const el = dom.window.document.getElementById('preview');
  el.innerHTML = html;
  return { dom, el };
}

/** Фейковий resolver із тим самим інтерфейсом, що й ImageResolver. */
function fakeResolver(behavior) {
  return {
    async resolve(origSrc, currentFilePath) {
      return behavior(origSrc, currentFilePath);
    },
  };
}

test('resolveAllImages replaces the placeholder src with the resolved data URL on success', async () => {
  const html = markdownToCanonicalHtml('![sensor](../../Asset/pic.jpg)\n', marked);
  const { el } = makeDom(html);

  const resolver = fakeResolver(async (orig) => `data:image/jpeg;base64,REAL_${orig}`);
  const failCount = await resolveAllImages(el, resolver, 'AI corrected/BOBAM/file.md', () => true);

  assert.equal(failCount, 0);
  const img = el.querySelector('img');
  assert.equal(img.getAttribute('src'), 'data:image/jpeg;base64,REAL_../../Asset/pic.jpg');
  assert.equal(el.querySelector('.md-img-wrap').classList.contains('loading'), false);
  assert.equal(el.querySelector('.md-img-wrap').classList.contains('broken'), false);
});

test('resolveAllImages marks the wrap as broken AND shows the real error reason (this used to be silently invisible)', async () => {
  const html = markdownToCanonicalHtml('![missing](../../Asset/gone.jpg)\n', marked);
  const { el } = makeDom(html);

  const resolver = fakeResolver(async () => {
    throw new Error('Not Found (Asset/gone.jpg)');
  });
  const failCount = await resolveAllImages(el, resolver, 'AI corrected/BOBAM/file.md', () => true);

  assert.equal(failCount, 1);
  const wrap = el.querySelector('.md-img-wrap');
  assert.equal(wrap.classList.contains('broken'), true);
  assert.equal(wrap.classList.contains('loading'), false);
  const placeholder = wrap.querySelector('.md-img-placeholder-text');
  assert.match(placeholder.textContent, /Not Found/);
});

test('resolveAllImages handles a mix of successful and failing images independently', async () => {
  const html = markdownToCanonicalHtml('![a](x.jpg)\n\n![b](y.jpg)\n', marked);
  const { el } = makeDom(html);

  const resolver = fakeResolver(async (orig) => {
    if (orig === 'x.jpg') return 'data:image/jpeg;base64,OK';
    throw new Error('boom');
  });
  const failCount = await resolveAllImages(el, resolver, null, () => true);

  assert.equal(failCount, 1);
  const wraps = el.querySelectorAll('.md-img-wrap');
  assert.equal(wraps[0].classList.contains('broken'), false);
  assert.equal(wraps[1].classList.contains('broken'), true);
});

test('resolveAllImages respects stillCurrent() and aborts stale updates (race-condition guard)', async () => {
  const html = markdownToCanonicalHtml('![a](x.jpg)\n', marked);
  const { el } = makeDom(html);

  const resolver = fakeResolver(async () => 'data:image/jpeg;base64,OK');
  // Симулюємо, що поки промис резолвиться, з'явився новіший рендер (stillCurrent -> false)
  const failCount = await resolveAllImages(el, resolver, null, () => false);

  assert.equal(failCount, 0); // не рахуємо як провал — просто проігноровано
  const img = el.querySelector('img');
  // src НЕ мав оновитись, бо рендер вже застарілий
  assert.match(img.getAttribute('src'), /^data:image\/gif/);
});
