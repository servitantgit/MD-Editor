// markdown-tokens.js
// Розпізнавання зображень/посилань у markdown-тексті та побудова "канонічного" HTML
// для прев'ю. Навмисно без document.createElement — атрибути <img> парсяться регексом,
// щоб цей модуль можна було юніт-тестувати в Node без jsdom.

import { escapeAttr } from './paths.js';

/** Прозорий 1x1 GIF — заглушка, поки реальне джерело зображення ще не підвантажене. */
export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

/** Зображення (markdown ![]() або сирий <img>) чи звичайне markdown-посилання [](). */
export const REF_TOKEN_RE =
  /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|(?<!!)\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*\/?>/g;

/** Лише зображення (markdown ![]() або сирий <img>) — використовується для прев'ю/PDF. */
export const IMG_TOKEN_RE = /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*\/?>/g;

/** Витягує src/alt/width із рядка сирого <img ...> тега без DOM. */
export function parseImgTagAttrs(tagHtml) {
  const get = (name) => {
    const m = tagHtml.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? m[1] ?? m[2] ?? '' : '';
  };
  return { src: get('src'), alt: get('alt'), width: get('width') };
}

/** Класифікує один збіг REF_TOKEN_RE/IMG_TOKEN_RE і повертає {kind, target, extra...}. */
export function classifyRefMatch(full, g1, g2, g3, g4, g5, g6) {
  if (g2 !== undefined) return { kind: 'img-md', target: g2, alt: g1 || '', title: g3 || '' };
  if (g5 !== undefined) return { kind: 'link-md', target: g5, text: g4 || '', title: g6 || '' };
  const attrs = parseImgTagAttrs(full);
  return { kind: 'img-html', target: attrs.src, alt: attrs.alt, width: attrs.width };
}

/** Збирає токен назад у текст із НОВИМ target (той самий вид синтаксису, що й був). */
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
 * Перетворює markdown-текст, вставляючи замість кожного зображення "канонічний"
 * <img data-md-line=".." data-md-occ=".." data-md-src="ОРИГІНАЛЬНИЙ_ШЛЯХ" src="TRANSPARENT_PIXEL">.
 * Реальне джерело резолвиться асинхронно окремим кроком (image-resolver.js) —
 * ця функція абсолютно синхронна й не звертається в мережу.
 * @param {string} text
 * @returns {string} текст, готовий для передачі в marked.parse(...)
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
      `</span>`
    );
  });
}

/**
 * Повний рендер markdown -> HTML для прев'ю/PDF. `renderer` — об'єкт із методом
 * .parse(text, opts) (переданий іззовні, напр. бібліотека marked) — це dependency
 * injection, щоб цей модуль не тягнув конкретну markdown-бібліотеку напряму
 * і легко підмінявся в тестах.
 */
export function markdownToCanonicalHtml(text, renderer) {
  if (!renderer || typeof renderer.parse !== 'function') {
    throw new Error('Не передано markdown-рендерер (очікується об’єкт з методом .parse)');
  }
  const withCanonicalImages = injectCanonicalImageTags(text);
  return renderer.parse(withCanonicalImages, { gfm: true, breaks: false });
}

/** Переписує в РЯДКУ джерела одне зображення за індексом (line+occ) на нову ширину/джерело. */
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
