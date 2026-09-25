import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dirnameOf,
  basenameOf,
  extOf,
  isImagePath,
  resolveRelativePath,
  relativePathFromTo,
  findAssetFolder,
  encodePathForApi,
  isExternalOrAnchor,
} from '../js/paths.js';

test('dirnameOf / basenameOf / extOf', () => {
  assert.equal(dirnameOf('AI corrected/BOBAM/file.md'), 'AI corrected/BOBAM');
  assert.equal(dirnameOf('file.md'), '');
  assert.equal(basenameOf('AI corrected/BOBAM/file.md'), 'file.md');
  assert.equal(extOf('image.JPG'), 'jpg');
  assert.equal(extOf('noext'), '');
});

test('isImagePath recognizes common image extensions only', () => {
  assert.equal(isImagePath('a/b/photo.jpg'), true);
  assert.equal(isImagePath('a/b/photo.png'), true);
  assert.equal(isImagePath('a/b/notes.md'), false);
});

test('resolveRelativePath resolves ../ correctly for real repo depths', () => {
  // Файл на 3 рівнях вкладеності, посилання йде на 3 рівні вгору до Asset/
  const dir = dirnameOf('AI corrected/MICAM/Kalibracja systemu wizyjnego/Kalibracja Geometry.md');
  assert.equal(dir, 'AI corrected/MICAM/Kalibracja systemu wizyjnego');
  const resolved = resolveRelativePath(dir, '../../../Asset/Kalibracja_Geometry_image_0001.jpg');
  assert.equal(resolved, 'Asset/Kalibracja_Geometry_image_0001.jpg');
});

test('resolveRelativePath handles the depth-2 case (most files in this vault)', () => {
  const dir = dirnameOf('AI corrected/BOBAM/ATS Housing LOAD-UNLOAD.md');
  assert.equal(dir, 'AI corrected/BOBAM');
  const resolved = resolveRelativePath(dir, '../../Asset/ATS_Housing_LOAD-UNLOAD_image_0001.jpg');
  assert.equal(resolved, 'Asset/ATS_Housing_LOAD-UNLOAD_image_0001.jpg');
});

test('relativePathFromTo is the exact inverse of resolveRelativePath', () => {
  const fromDir = 'AI corrected/BOBAM/sub';
  const absTarget = 'Asset/Laser_sensor_image_0001.jpg';
  const rel = relativePathFromTo(fromDir, absTarget);
  assert.equal(rel, '../../../Asset/Laser_sensor_image_0001.jpg');
  // round-trip
  assert.equal(resolveRelativePath(fromDir, rel), absTarget);
});

test('relativePathFromTo same-directory case has no leading ../', () => {
  const rel = relativePathFromTo('AI corrected/BOBAM', 'AI corrected/BOBAM/img.jpg');
  assert.equal(rel, 'img.jpg');
});

test('findAssetFolder prefers a folder literally named Asset over per-file assets', () => {
  const allPaths = [
    'Asset/x.jpg',
    'Asset/y.jpg',
    'AI corrected/BOBAM/file.md',
    'AI corrected/BOBAM/file2.md',
  ];
  assert.equal(findAssetFolder(allPaths, 'AI corrected/BOBAM/file.md'), 'Asset');
});

test('findAssetFolder falls back to the folder with the most images when no named folder exists', () => {
  const allPaths = [
    'docs/a/pic1.jpg',
    'docs/a/pic2.jpg',
    'docs/b/pic1.jpg',
    'docs/a/note.md',
  ];
  assert.equal(findAssetFolder(allPaths, 'docs/a/note.md'), 'docs/a');
});

test('findAssetFolder falls back to "<dir>/assets" when nothing else matches', () => {
  const allPaths = ['docs/note.md'];
  assert.equal(findAssetFolder(allPaths, 'docs/note.md'), 'docs/assets');
});

test('encodePathForApi encodes each segment but keeps "/" as separator', () => {
  const encoded = encodePathForApi('AI corrected/BOBAM/ATS Housing LOAD-UNLOAD.md');
  assert.equal(encoded, 'AI%20corrected/BOBAM/ATS%20Housing%20LOAD-UNLOAD.md');
  assert.ok(!encoded.includes('%2F'), 'slashes must stay literal, not become %2F');
});

test('isExternalOrAnchor recognizes external schemes, anchors and data URIs', () => {
  assert.equal(isExternalOrAnchor('https://example.com/x.png'), true);
  assert.equal(isExternalOrAnchor('onenote:SomePage'), true);
  assert.equal(isExternalOrAnchor('#section'), true);
  assert.equal(isExternalOrAnchor('data:image/png;base64,AAA'), true);
  assert.equal(isExternalOrAnchor('../Asset/x.jpg'), false);
  assert.equal(isExternalOrAnchor('/Asset/x.jpg'), false);
});
