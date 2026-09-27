// github-repo-url.js
// Pure helper for the login form: people often paste the whole
// "https://github.com/owner/repo" link (from the address bar) into the Owner or
// Repository field instead of just the name. That produces a broken API URL like
// /repos/owner/https://github.com/... — GitHub answers with a non-200 status and
// the browser reports it as a CORS error. This helper detects such a paste and
// splits it back into {owner, repo}.
// No DOM or network access — deliberately so, so it can be covered by unit tests.

/**
 * True if the text looks like a GitHub repository URL / clone string
 * (contains "github.com/" or the ssh form "github.com:").
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeGitHubUrl(text) {
  if (typeof text !== 'string') return false;
  return /github\.com[/:]/i.test(text);
}

/**
 * Extract {owner, repo} from a pasted GitHub link. Handles:
 * - https://github.com/owner/repo(.git)  (+ any extra path, query or #fragment)
 * - http://..., www.github.com/..., git@github.com:owner/repo.git
 * - a bare "github.com/owner/repo" without protocol
 * Returns null when the text isn't a GitHub link or has no repo part.
 * @param {string} text
 * @returns {{owner: string, repo: string} | null}
 */
export function parseGitHubOwnerRepo(text) {
  if (!looksLikeGitHubUrl(text)) return null;

  const s = text.trim();
  // Find "github.com/" or "github.com:" that isn't part of another word
  // (e.g. "notgithub.com" won't match), and take everything after the separator.
  const m = s.match(/(?<![a-z0-9-])github\.com([/:])/i);
  if (!m) return null;

  const afterHost = s.slice(m.index + m[0].length);

  // Cut off #fragment and ?query, then take the first two path segments
  const path = afterHost.split(/[?#]/)[0];
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;

  return { owner, repo };
}
