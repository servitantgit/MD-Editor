// markdown-tokens.js
// Recognizing images/links in markdown text and building the "canonical" HTML
// for the preview. Deliberately without document.createElement — <img> attributes are parsed with regex,
// so this module can be unit-tested in Node without jsdom.

import { escapeAttr } from './paths.js';

/** Transparent 1x1 GIF — placeholder until the real image source is loaded. */
export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

/** Images (markdown ![]() or raw <img>) or plain markdown links [](). */
export const REF_TOKEN_RE =
  /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|(?<!!)\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*\/?>/g;

/** Only images (markdown ![]() or raw <img>) — used for preview/PDF. */
export const IMG_TOKEN_RE = /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*\/?>/g;

/** Extracts src/alt/width from a raw <img ...> tag string without DOM. */
export function parseImgTagAttrs(tagHtml) {
  const get = (name) => {
    const m = tagHtml.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? m[1] ?? m[2] ?? '' : '';
  };
  return { src: get('src'), alt: get('alt'), width: get('width') };
}

/** Classifies a single REF_TOKEN_RE/IMG_TOKEN_RE match and returns {kind, target, extra...}. */
export function classifyRefMatch(full, g1, g2, g3, g4, g5, g6) {
  if (g2 !== undefined) return { kind: 'img-md', target: g2, alt: g1 || '', title: g3 || '' };
  if (g5 !== undefined) return { kind: 'link-md', target: g5, text: g4 || '', title: g6 || '' };
  const attrs = parseImgTagAttrs(full);
  return { kind: 'img-html', target: attrs.src, alt: attrs.alt, width: attrs.width };
}

/** Rebuilds a token back into text with a NEW target (same syntax kind as before). */
export function rebuildRefToken(parsed, newTarget, fullOriginal) {
  switch (parsed.kind) {
    case 'img-md':
      return `![${parsed.alt || ''}](${newTarget}${parsed.title ? ` "${parsed.title}"` : ''})`;
    case 'link-md':
      return `[${parsed.text || ''}](${newTarget}${parsed.title ? ` "${parsed.title}"` : ''})`;
    case 'img-html':
      return fullOriginal.replace(
        /\ssrc\s*=\s*(?:"[^"]*"|'[^']*')/i,
        ` src="${escapeAttr(newTarget)}"`
      );
    default:
      return fullOriginal;
  }
}

/**
 * Transforms markdown text by replacing every image with a "canonical"
 * <img data-md-line=".." data-md-occ=".." data-md-src="ORIGINAL_PATH" src="TRANSPARENT_PIXEL">.
 * The real source is resolved asynchronously in a separate step (image-resolver.js) —
 * this function is fully synchronous and never touches the network.
 * @param {string} text
 * @returns {string} text ready to pass into marked.parse(...)
 */
export function injectCanonicalImageTags(text) {
  const lineOcc = {};
  return text.replace(IMG_TOKEN_RE, (full, altG, srcG, titleG, offset) => {
    const isMdImg = srcG !== undefined;
    const attrs = isMdImg ? { src: srcG, alt: altG || '', width: '' } : parseImgTagAttrs(full);

    const ln = (text.slice(0, offset).match(/\n/g) || []).length;
    const occ = lineOcc[ln] || 0;
    lineOcc[ln] = occ + 1;

    const widthNum = parseInt(attrs.width, 10);
    const widthPart = attrs.width && !Number.isNaN(widthNum)
      ? ` width="${escapeAttr(attrs.width)}" style="width:${widthNum}px;height:auto;"`
      : '';

    return (
      `<span class="md-img-wrap loading">` +
      `<img data-md-line="${ln}" data-md-occ="${occ}" data-md-src="${escapeAttr(attrs.src)}" ` +
      `alt="${escapeAttr(attrs.alt)}"${widthPart} src="${TRANSPARENT_PIXEL}">` +
      `<span class="md-img-resize-handle"></span>` +
      `<span class="md-img-size-badge"></span>` +
      `<span class="md-img-placeholder-text">⏳ ${escapeAttr(attrs.src)}</span>` +
      `<a class="md-image-link" href="${escapeAttr(attrs.src)}" target="_blank" rel="noopener" ` +
      `data-md-src="${escapeAttr(attrs.src)}" ` +
      `data-md-filename="${escapeAttr(attrs.filename || '')}" ` +
      `data-md-filepath="${escapeAttr(attrs.filepath || '')}">` +
      `<span class="md-image-filename">${escapeAttr(attrs.filename || attrs.src)}</span>` +
      `<span class="md-image-path">${escapeAttr(attrs.filepath || attrs.src)}</span>` +
      `</a>` +
      `</span>`
    );
  });
}

/**
 * Full markdown -> HTML render for preview/PDF. `renderer` is an object with a
 * .parse(text, opts) method (passed from outside, e.g. the marked library) — this is dependency
 * injection so this module doesn't pull in a specific markdown library directly
 * and is easy to swap in tests.
 */
export function markdownToCanonicalHtml(text, renderer) {
  if (!renderer || typeof renderer.parse !== 'function') {
    throw new Error('No markdown renderer provided (expected an object with a .parse method)');
  }
  const withCanonicalImages = injectCanonicalImageTags(text);
  return renderer.parse(withCanonicalImages, { gfm: true, breaks: false });
}

/** Rewrites in a LINE a single image by index (line+occ) to a new width/source. */
export function setImageAttrsInLine(line, occIndex, { src, alt, width }) {
  let count = -1;
  const newLine = line.replace(IMG_TOKEN_RE, (full) => {
    count++;
    if (count !== occIndex) return full;
    const widthAttr = width ? ` width="${width}"` : '';
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${widthAttr}>`;
  });
  return newLine;
}
