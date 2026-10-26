import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, chooseOutput, renameForType, detectAlpha, compressImage, MAX_SIDE } from '../js/image-compress.js';

const fakeFile = (type, name, size) => ({ type, name, size });

function fakeRaster({ sourceWidth = 3840, sourceHeight = 2160, hasAlpha = false, outSize = 100, fail = false } = {}) {
  const calls = { decoded: 0, maxSide: null, toBlob: [] };
  const rasterize = async (file, maxSide) => {
    calls.decoded++;
    calls.maxSide = maxSide;
    if (fail) throw new Error('decode failed');
    const { width, height } = fitWithin(sourceWidth, sourceHeight, maxSide);
    return {
      sourceWidth, sourceHeight, width, height, hasAlpha,
      toBlob: async (mime, quality) => {
        calls.toBlob.push([mime, quality]);
        return new Blob(['x'.repeat(outSize)], { type: mime });
      },
    };
  };
  return { rasterize, calls };
}

test('image compress: fitWithin scales the longest side down to 1920', () => {
  assert.equal(MAX_SIDE, 1920);
  assert.deepEqual(fitWithin(3840, 2160, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(fitWithin(1000, 4000, 1920), { width: 480, height: 1920 });
});

test('image compress: fitWithin keeps small images and never returns 0', () => {
  assert.deepEqual(fitWithin(800, 600, 1920), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 1, 1920), { width: 1920, height: 1 });
});

test('image compress: opaque PNG / BMP become JPEG even without scaling', () => {
  assert.deepEqual(chooseOutput({ type: 'image/png', hasAlpha: false, scaled: false }), { mime: 'image/jpeg', quality: 0.85 });
  assert.deepEqual(chooseOutput({ type: 'image/bmp', hasAlpha: false, scaled: true }), { mime: 'image/jpeg', quality: 0.85 });
});

test('image compress: PNG with transparency stays PNG, only when it must shrink', () => {
  assert.deepEqual(chooseOutput({ type: 'image/png', hasAlpha: true, scaled: true }), { mime: 'image/png' });
  assert.equal(chooseOutput({ type: 'image/png', hasAlpha: true, scaled: false }), null);
});

test('image compress: JPEG is re-encoded only when it must shrink', () => {
  assert.equal(chooseOutput({ type: 'image/jpeg', hasAlpha: false, scaled: false }), null);
  assert.deepEqual(chooseOutput({ type: 'image/jpeg', hasAlpha: false, scaled: true }), { mime: 'image/jpeg', quality: 0.85 });
});

test('image compress: GIF, SVG and WebP are never touched', () => {
  for (const type of ['image/gif', 'image/svg+xml', 'image/webp']) {
    assert.equal(chooseOutput({ type, hasAlpha: false, scaled: true }), null, type);
  }
});

test('image compress: renameForType swaps or adds the extension', () => {
  assert.equal(renameForType('image.png', 'image/jpeg'), 'image.jpg');
  assert.equal(renameForType('a.b.PNG', 'image/jpeg'), 'a.b.jpg');
  assert.equal(renameForType('shot', 'image/jpeg'), 'shot.jpg');
  assert.equal(renameForType('', 'image/png'), 'image.png');
});

test('image compress: detectAlpha finds any non-opaque pixel', () => {
  assert.equal(detectAlpha(new Uint8ClampedArray([0, 0, 0, 255, 9, 9, 9, 255])), false);
  assert.equal(detectAlpha(new Uint8ClampedArray([0, 0, 0, 255, 9, 9, 9, 254])), true);
});

test('image compress: opaque PNG screenshot becomes a smaller, renamed JPEG', async () => {
  const { rasterize, calls } = fakeRaster({ outSize: 100 });
  const file = fakeFile('image/png', 'image.png', 2000000);
  const out = await compressImage(file, { rasterize });
  assert.notEqual(out, file);
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.name, 'image.jpg');
  assert.equal(out.size, 100);
  assert.equal(calls.maxSide, 1920);
  assert.deepEqual(calls.toBlob, [['image/jpeg', 0.85]]);
});

test('image compress: a result that is not smaller keeps the original', async () => {
  const { rasterize } = fakeRaster({ outSize: 500 });
  const file = fakeFile('image/png', 'tiny.png', 500);
  assert.equal(await compressImage(file, { rasterize }), file);
});

test('image compress: a decode error keeps the original', async () => {
  const { rasterize } = fakeRaster({ fail: true });
  const file = fakeFile('image/png', 'broken.png', 2000000);
  assert.equal(await compressImage(file, { rasterize }), file);
});

test('image compress: no rasterizer available keeps the original', async () => {
  const file = fakeFile('image/png', 'a.png', 2000000);
  assert.equal(await compressImage(file, { rasterize: async () => null }), file);
});

test('image compress: GIF is not even decoded', async () => {
  const { rasterize, calls } = fakeRaster();
  const file = fakeFile('image/gif', 'anim.gif', 2000000);
  assert.equal(await compressImage(file, { rasterize }), file);
  assert.equal(calls.decoded, 0);
});

test('image compress: small transparent PNG is kept without re-encoding', async () => {
  const { rasterize, calls } = fakeRaster({ sourceWidth: 800, sourceHeight: 600, hasAlpha: true });
  const file = fakeFile('image/png', 'logo.png', 2000000);
  assert.equal(await compressImage(file, { rasterize }), file);
  assert.equal(calls.toBlob.length, 0);
});