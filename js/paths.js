// paths.js
// Чисті функції для роботи зі шляхами репозиторію. Жодних звернень до DOM чи мережі —
// це навмисно, щоб усе тут можна було перевірити юніт-тестами без браузера.

export const IMAGE_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Тека файлу за його шляхом у репо ("a/b/c.md" -> "a/b"; "c.md" -> ""). */
export function dirnameOf(path) {
  if (!path || !path.includes('/')) return '';
  return path.slice(0, path.lastIndexOf('/'));
}

/** Ім'я файлу без теки ("a/b/c.md" -> "c.md"). */
export function basenameOf(path) {
  return path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
}

/** Розширення файлу в нижньому регістрі, без крапки ("c.MD" -> "md"). */
export function extOf(path) {
  const b = basenameOf(path);
  return b.includes('.') ? b.slice(b.lastIndexOf('.') + 1).toLowerCase() : '';
}

export function isImagePath(path) {
  return Object.prototype.hasOwnProperty.call(IMAGE_EXT, extOf(path));
}

export function guessMime(path) {
  return IMAGE_EXT[extOf(path)] || 'application/octet-stream';
}

/**
 * Розв'язує відносний шлях (./x.png, ../a/b.png) відносно теки baseDir і повертає
 * абсолютний (від кореня репозиторію) шлях без провідного "/".
 */
export function resolveRelativePath(baseDir, relPath) {
  const stack = baseDir ? baseDir.split('/') : [];
  relPath.split('/').forEach((part) => {
    if (part === '' || part === '.') return;
    if (part === '..') stack.pop();
    else stack.push(part);
  });
  return stack.join('/');
}

/** Обчислює відносний шлях від теки fromDir до файлу toPath (у стилі "../../x/y.png"). */
export function relativePathFromTo(fromDir, toPath) {
  const fromParts = fromDir ? fromDir.split('/') : [];
  const toParts = toPath.split('/');
  const toFile = toParts.pop();
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const relParts = [];
  for (let k = 0; k < ups; k++) relParts.push('..');
  relParts.push(...downs, toFile);
  return relParts.join('/');
}

export function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Знаходить теку для нових зображень:
 * 1) найближча (до currentFilePath) тека з "асетною" назвою (Asset/Assets/Images/...);
 * 2) інакше — тека з найбільшою кількістю вже наявних зображень;
 * 3) інакше — фолбек "<тека файлу>/assets".
 * @param {string[]} allPaths  усі шляхи файлів репозиторію
 * @param {string} currentFilePath  шлях файлу, який зараз редагується
 */
export function findAssetFolder(allPaths, currentFilePath) {
  const nameRe = /^(assets?|images?|img|attachments?|files|resources?)$/i;
  const dirSet = new Set();
  allPaths.forEach((p) => {
    let d = dirnameOf(p);
    while (true) {
      dirSet.add(d);
      if (!d) break;
      d = dirnameOf(d);
    }
  });

  const namedCandidates = Array.from(dirSet).filter((d) => d && nameRe.test(basenameOf(d)));
  if (namedCandidates.length) {
    const curChain = dirnameOf(currentFilePath).split('/').filter(Boolean);
    namedCandidates.sort((a, b) => {
      const da = dirnameOf(a).split('/').filter(Boolean);
      const db = dirnameOf(b).split('/').filter(Boolean);
      return commonPrefixLen(curChain, db) - commonPrefixLen(curChain, da);
    });
    return namedCandidates[0];
  }

  const counts = {};
  allPaths.forEach((p) => {
    if (isImagePath(p)) {
      const d = dirnameOf(p);
      counts[d] = (counts[d] || 0) + 1;
    }
  });
  let best = null;
  let bestCount = 0;
  Object.keys(counts).forEach((d) => {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  });
  if (best !== null && bestCount > 0) return best;

  const own = dirnameOf(currentFilePath);
  return own ? `${own}/assets` : 'assets';
}

/**
 * Кодує шлях для GitHub Contents API ПОСЕГМЕНТНО.
 * encodeURIComponent(повного шляху) перетворив би "/" на "%2F", а частина
 * маршрутизації на боці GitHub це не завжди розкодовує — тому запити для файлів
 * у вкладених теках (особливо з пробілами й юнікодом у назвах) просто провалювались би.
 */
export function encodePathForApi(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Кодує шлях для встановлення у markdown-посилання (пробіли, дужки тощо — щоб не ламати синтаксис). */
export function encodeLinkPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function decodeUriSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

export function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** true для зовнішніх схем (http:, onenote:, mailto: ...), якорів (#...) та data: URI. */
export function isExternalOrAnchor(target) {
  return !target || target.startsWith('#') || target.startsWith('data:') || /^[a-z][a-z0-9+.-]*:/i.test(target);
}
