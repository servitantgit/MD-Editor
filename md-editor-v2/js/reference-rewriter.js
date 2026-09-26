// reference-rewriter.js
// Чиста логіка перерахунку посилань при переміщенні файлів. Жодних fetch() —
// приймає текст файлу, повертає новий текст. Мережеву частину (кому саме читати/писати)
// робить file-mover.js, який використовує ці функції.

import {
  dirnameOf,
  resolveRelativePath,
  relativePathFromTo,
  encodeLinkPath,
  decodeUriSafe,
  isExternalOrAnchor,
} from './paths.js';
import { REF_TOKEN_RE, classifyRefMatch, rebuildRefToken } from './markdown-tokens.js';

/**
 * Файл САМ переміщується з oldDir у newDir: перераховує його ВЛАСНІ відносні
 * посилання так, щоб вони й далі вказували на ті самі цілі (стиль лишається
 * відносним — так, як уже написані інші нотатки в репозиторії).
 * Кореневі ("/...") і зовнішні посилання не чіпає.
 */
export function rewriteOwnRelativeLinks(text, oldDir, newDir) {
  if (oldDir === newDir) return text;
  return text.replace(REF_TOKEN_RE, (full, g1, g2, g3, g4, g5, g6) => {
    const parsed = classifyRefMatch(full, g1, g2, g3, g4, g5, g6);
    const target = parsed.target;
    if (isExternalOrAnchor(target) || target.startsWith('/')) return full;

    const decoded = decodeUriSafe(target);
    const resolvedAbs = resolveRelativePath(oldDir, decoded);
    const newRel = encodeLinkPath(relativePathFromTo(newDir, resolvedAbs));
    return rebuildRefToken(parsed, newRel, full);
  });
}

/**
 * Перевіряє/переписує в тексті ІНШОГО файлу (що лежить у fileDir) усі посилання,
 * які фактично вказують на oldPath — і відносні, і кореневі — на newPath.
 * Повертає {changed, text}.
 */
export function updateReferencesInFile(text, fileDir, oldPath, newPath) {
  let changed = false;
  const newText = text.replace(REF_TOKEN_RE, (full, g1, g2, g3, g4, g5, g6) => {
    const parsed = classifyRefMatch(full, g1, g2, g3, g4, g5, g6);
    const target = parsed.target;
    if (isExternalOrAnchor(target)) return full;

    const decoded = decodeUriSafe(target);
    const isAbsoluteStyle = decoded.startsWith('/');
    const resolved = isAbsoluteStyle ? decoded.slice(1) : resolveRelativePath(fileDir, decoded);
    if (resolved !== oldPath) return full;

    changed = true;
    const newTarget = isAbsoluteStyle
      ? '/' + encodeLinkPath(newPath)
      : encodeLinkPath(relativePathFromTo(fileDir, newPath));
    return rebuildRefToken(parsed, newTarget, full);
  });
  return { changed, text: newText };
}

/** Зручний хелпер: dirname нового шляху при перейменуванні/переміщенні файлу. */
export function dirOf(path) {
  return dirnameOf(path);
}
