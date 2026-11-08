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

/** Fake resolver with the same interface as ImageResolver. */
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
  // Simulate that while the promise resolves, a newer render appeared (stillCurrent -> false)
  const failCount = await resolveAllImages(el, resolver, null, () => false);

  assert.equal(failCount, 0); // not counted as a failure — just ignored
  const img = el.querySelector('img');
  // src must NOT have updated, because the render is already stale
  assert.match(img.getAttribute('src'), /^data:image\/gif/);
});

// Drag-to-resize in Preview (attachResizeHandles in js/image-preview.js) and
// the <img ... width="N"> line it writes. Real pointer events, real layout and
// undo are checked by hand in production (see AGENTS.md).
async function resizeFixture() {
  const { attachResizeHandles } = await import('../js/image-preview.js');
  const text = 'intro\n![a](x.png) and ![b](../Asset/y.png)\nend';
  const dom = new JSDOM('<!doctype html><body><div id="p"></div></body>');
  const el = dom.window.document.getElementById('p');
  el.innerHTML = markdownToCanonicalHtml(text, marked);
  const lines = text.split('\n');
  const edits = [];
  const cm = {
    getLine: (i) => lines[i],
    replaceRange(t, from, to) {
      edits.push({ t, from, to });
      lines[from.line] = lines[from.line].slice(0, from.ch) + t + lines[from.line].slice(to.ch);
    },
  };
  attachResizeHandles(el, cm);
  attachResizeHandles(el, cm);
  const wraps = el.querySelectorAll('.md-img-wrap');
  const wrap = wraps[1];
  const img = wrap.querySelector('img');
  const handle = wrap.querySelector('.md-img-resize-handle');
  const badge = wrap.querySelector('.md-img-size-badge');
  img.getBoundingClientRect = () => ({ width: parseInt(img.style.width, 10) || 200 });
  const captured = [];
  handle.setPointerCapture = (id) => captured.push(id);
  const fire = (type, x) => {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clientX', { value: x });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    handle.dispatchEvent(e);
    return e;
  };
  return { dom, lines, edits, wraps, wrap, img, badge, captured, fire };
}

test('resize (guard): dragging the handle of the second image writes its width into that image only, once', async () => {
  const f = await resizeFixture();
  try {
    assert.equal(f.wraps.length, 2);
    assert.equal(f.img.getAttribute('data-md-line'), '1');
    assert.equal(f.img.getAttribute('data-md-occ'), '1');
    assert.equal(f.img.getAttribute('data-md-src'), '../Asset/y.png');
    assert.equal(f.img.getAttribute('alt'), 'b');

    const down = f.fire('pointerdown', 100);
    assert.equal(down.defaultPrevented, true);
    assert.equal(f.wrap.classList.contains('resizing'), true);
    assert.deepEqual(f.captured, [7]);

    f.fire('pointermove', 150);
    assert.equal(f.img.style.width, '250px');
    assert.equal(f.img.style.height, 'auto');
    assert.equal(f.badge.textContent, '250px');

    f.fire('pointerup', 150);
    assert.equal(f.wrap.classList.contains('resizing'), false);
    assert.deepEqual(f.edits, [{
      t: '![a](x.png) and <img src="../Asset/y.png" alt="b" width="250">',
      from: { line: 1, ch: 0 },
      to: { line: 1, ch: 36 },
    }], 'one edit although attachResizeHandles ran twice');
    assert.equal(f.lines[1], '![a](x.png) and <img src="../Asset/y.png" alt="b" width="250">');

    f.fire('pointermove', 400);
    assert.equal(f.img.style.width, '250px', 'moving after release must not resize');
    assert.equal(f.edits.length, 1);
  } finally {
    f.dom.window.close();
  }
});

test('resize (guard): the width never goes below 20px', async () => {
  const f = await resizeFixture();
  try {
    f.fire('pointerdown', 100);
    f.fire('pointermove', -5000);
    assert.equal(f.img.style.width, '20px');
    assert.equal(f.badge.textContent, '20px');
    f.fire('pointerup', -5000);
    assert.equal(f.lines[1], '![a](x.png) and <img src="../Asset/y.png" alt="b" width="20">');
  } finally {
    f.dom.window.close();
  }
});

test('resize (guard): the <img> line written by resize is read by Preview and move/rename', async () => {
  // Architecture rule 3. Names without & or " on purpose: an & in an <img>
  // src or alt is not decoded (see AGENTS.md).
  const { setImageAttrsInLine, injectCanonicalImageTags } = await import('../js/markdown-tokens.js');
  const { updateReferencesInFile, rewriteOwnRelativeLinks } = await import('../js/reference-rewriter.js');
  const cases = [
    ['../../Asset/1700_my__shot___1_.png', 'Asset/1700_my__shot___1_.png', 'my shot (1).png', '../Asset/1700_my__shot___1_.png'],
    ['../../Asset/ATS_(BOB_Load)_image_0001.jpg', 'Asset/ATS_(BOB_Load)_image_0001.jpg', 'x', '../Asset/ATS_(BOB_Load)_image_0001.jpg'],
    ['../../Asset/a%20b.png', 'Asset/a b.png', 'x', '../Asset/a%20b.png'],
  ];
  for (const [src, path, alt, srcAfterNoteMove] of cases) {
    const tag = (s, w) => '<img src="' + s + '" alt="' + alt + '" width="' + w + '">';
    const md = '![' + alt + '](' + src + ')';
    const resized = setImageAttrsInLine(md, 0, { src, alt, width: 300 });
    assert.equal(resized, tag(src, 300), path);
    const text = 'before\n' + resized + '\nafter\n';

    const canon = injectCanonicalImageTags(text);
    assert.ok(canon.includes('data-md-src="' + src + '"'), 'Preview keeps the src: ' + path);
    assert.ok(canon.includes('width="300"'), 'Preview keeps the width: ' + path);

    const moved = updateReferencesInFile(text, 'A/B', path, 'Asset/moved.png');
    assert.equal(moved.changed, true, 'moving the image updates the tag: ' + path);
    assert.equal(moved.text.split('\n')[1], tag('../../Asset/moved.png', 300));

    assert.equal(rewriteOwnRelativeLinks(text, 'A/B', 'A').split('\n')[1], tag(srcAfterNoteMove, 300));

    assert.equal(setImageAttrsInLine(resized, 0, { src, alt, width: 150 }), tag(src, 150), 'resize again changes only the width');
  }
});
