// reference-rewriter.js
// Pure link-recalculation logic for file moves. No fetch() —
// takes file text, returns new text. The network part (who to read/write)
// is done by file-mover.js, which uses these functions.

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
 * The file ITSELF moves from oldDir to newDir: recalculates its OWN relative
 * links so they still point at the same targets (style stays
 * relative — the way other notes in the repo are already written).
 * Root ("/...") and external links are left untouched.
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
 * Checks/rewrites in the text of ANOTHER file (located in fileDir) all links
 * that actually point at oldPath — both relative and root-relative — to newPath.
 * Returns {changed, text}.
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

/** Convenience helper: dirname of the new path when renaming/moving a file. */
export function dirOf(path) {
  return dirnameOf(path);
}
