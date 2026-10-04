// search-ui.js
// DOM side of the search feature: the input, the ~150ms debounce, rendering the
// results list, the Ctrl/Cmd+K shortcut, swapping the tree for the results and
// the status line. Plain DOM, same as the rest of the app — no framework.
//
// The tree is never re-rendered when results are cleared: it is only hidden and
// shown again, so the scroll position, the expanded folders and the active file
// are all still exactly as the user left them.

import { buildSnippet } from './search-index.js';

const DEBOUNCE_MS = 150;

/** "12s ago" / "3m ago" / "2h ago" / "5d ago". */
export function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * @param {object} deps
 * @param {HTMLInputElement} deps.inputEl
 * @param {HTMLElement} deps.statusEl
 * @param {HTMLButtonElement} deps.reindexBtn
 * @param {HTMLElement} deps.treeEl       the FileTree container
 * @param {HTMLElement} deps.resultsEl    where results are rendered
 * @param {() => object|null} deps.getSync  the current SearchSync
 * @param {(path: string) => void} deps.onOpenFile
 * @param {() => void} [deps.onReindex]   the "↻" button
 */
export function createSearchUI(deps) {
  const { inputEl, statusEl, reindexBtn, treeEl, resultsEl, getSync, onOpenFile, onReindex } = deps;

  let debounceTimer = null;
  // Bumped on every render: a lazy snippet fetch that finishes after the user
  // has typed something else must not patch a stale row.
  let renderGeneration = 0;
  let destroyed = false;

  function showTree() {
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');
    treeEl.classList.remove('hidden');
  }

  function showResults() {
    treeEl.classList.add('hidden');
    resultsEl.classList.remove('hidden');
  }

  function setStatus(text, degraded = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('degraded', !!degraded);
  }

  function renderResults(text) {
    const query = String(text || '').trim();
    const sync = getSync();

    if (!query) {
      showTree();
      return;
    }
    if (!sync || !sync.index) return;

    const generation = ++renderGeneration;
    const hits = sync.index.query(query);
    showResults();

    resultsEl.innerHTML = '';
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No matches';
      resultsEl.appendChild(empty);
      return;
    }

    hits.forEach((hit) => {
      const row = document.createElement('div');
      row.className = 'search-result';
      row.dataset.path = hit.path;
      row.title = hit.path;

      const pathEl = document.createElement('div');
      pathEl.className = 'search-result-path';
      pathEl.textContent = hit.path;

      const snippetEl = document.createElement('div');
      snippetEl.className = 'search-result-snippet';

      row.appendChild(pathEl);
      row.appendChild(snippetEl);
      resultsEl.appendChild(row);

      const cached = sync.index.bodyCache.get(hit.path);
      if (cached !== undefined) {
        // buildSnippet() escapes everything except its own <mark>, so assigning
        // it to innerHTML is safe even though the body is untrusted.
        snippetEl.innerHTML = buildSnippet(cached, query);
        return;
      }

      // Not in the LRU cache: show the title alone and fetch in the background.
      snippetEl.textContent = hit.title;
      sync.fetchBody(hit.path).then((body) => {
        if (destroyed || generation !== renderGeneration) return;
        snippetEl.innerHTML = body === undefined ? hit.title : buildSnippet(body, query);
      }).catch(() => { /* the title-only row stays */ });
    });
  }

  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(inputEl.value), DEBOUNCE_MS);
  }

  function onGlobalKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      inputEl.focus();
      inputEl.select();
      return;
    }
    // Escape only clears a non-empty search, so it still dismisses the tree
    // context menu exactly as before when the input is empty or unfocused.
    if (e.key === 'Escape' && document.activeElement === inputEl && inputEl.value) {
      inputEl.value = '';
      renderResults('');
    }
  }

  function onResultClick(e) {
    const row = e.target.closest('.search-result');
    if (!row) return;
    onOpenFile(row.dataset.path);
  }

  inputEl.addEventListener('input', onInput);
  document.addEventListener('keydown', onGlobalKeydown);
  resultsEl.addEventListener('click', onResultClick);
  reindexBtn.addEventListener('click', onReindex);

  return {
    destroy() {
      destroyed = true;
      clearTimeout(debounceTimer);
      inputEl.removeEventListener('input', onInput);
      document.removeEventListener('keydown', onGlobalKeydown);
      resultsEl.removeEventListener('click', onResultClick);
      reindexBtn.removeEventListener('click', onReindex);
      resultsEl.innerHTML = '';
      inputEl.value = '';
      renderGeneration++;
    },
    setStatus,
    renderResults,
    isActive: () => inputEl.value.trim() !== '',
  };
}