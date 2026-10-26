// image-compress.js
// Shrink images before they are committed: longest side <= 1920px, opaque PNG/BMP
// become JPEG (quality 0.85). Transparent PNG stays PNG; GIF/SVG/WebP are untouched.
// Any problem (no canvas, decode error, result not smaller) returns the ORIGINAL file,
// so an upload never fails because of compression.
// Decisions are pure functions (unit-tested); the canvas work is injectable.

export const MAX_SIDE = 1920;
export const JPEG_QUALITY = 0.85;
const RECODE_TYPES = new Set(['image/png', 'image/bmp', 'image/jpeg', 'image/jpg']);

/** Scale (width, height) so the longest side is at most maxSide. Never returns 0. */
export function fitWithin(width, height, maxSide = MAX_SIDE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: w, height: h };
  const k = maxSide / longest;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Decide the output format, or null to keep the original file.
 * @param {{type: string, hasAlpha: boolean, scaled: boolean}} info
 * @returns {{mime: string, quality?: number}|null}
 */
export function chooseOutput({ type, hasAlpha, scaled }) {
  const t = String(type || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') {
    return scaled ? { mime: 'image/jpeg', quality: JPEG_QUALITY } : null;
  }
  if (t === 'image/png' || t === 'image/bmp') {
    if (!hasAlpha) return { mime: 'image/jpeg', quality: JPEG_QUALITY };
    return scaled ? { mime: 'image/png' } : null;
  }
  return null;
}

/** Replace (or add) the file extension to match the output type. */
export function renameForType(name, mime) {
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  const base = String(name || '').replace(/\.[^./\\]*$/, '') || 'image';
  return base + ext;
}

/** True if any pixel of RGBA data is not fully opaque. */
export function detectAlpha(data) {
  if (!data) return false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function makeFile(blob, name, type) {
  if (typeof File === 'function') return new File([blob], name, { type });
  const b = new Blob([blob], { type });
  Object.defineProperty(b, 'name', { value: name });
  return b;
}

/** Browser rasterizer: decode, draw scaled onto a canvas, report transparency. */
async function browserRasterize(file, maxSide) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const bmp = await createImageBitmap(file);
  try {
    const sourceWidth = bmp.width;
    const sourceHeight = bmp.height;
    const { width, height } = fitWithin(sourceWidth, sourceHeight, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    const hasAlpha = detectAlpha(ctx.getImageData(0, 0, width, height).data);
    return {
      sourceWidth, sourceHeight, width, height, hasAlpha,
      toBlob: (mime, quality) => new Promise((resolve) => canvas.toBlob(resolve, mime, quality)),
    };
  } finally {
    if (typeof bmp.close === 'function') bmp.close();
  }
}

/**
 * Compress an image file for upload. Always resolves; returns the original on any problem.
 * @param {File} file
 * @param {{rasterize?: Function, maxSide?: number}} [opts] rasterize is injectable for tests
 * @returns {Promise<File>}
 */
export async function compressImage(file, { rasterize = browserRasterize, maxSide = MAX_SIDE } = {}) {
  try {
    if (!file || !RECODE_TYPES.has(String(file.type || '').toLowerCase())) return file;
    const r = await rasterize(file, maxSide);
    if (!r) return file;
    const scaled = r.width !== r.sourceWidth || r.height !== r.sourceHeight;
    const out = chooseOutput({ type: file.type, hasAlpha: r.hasAlpha, scaled });
    if (!out) return file;
    const blob = await r.toBlob(out.mime, out.quality);
    if (!blob || blob.size >= file.size) return file;
    return makeFile(blob, renameForType(file.name, out.mime), out.mime);
  } catch (_) {
    return file;
  }
}