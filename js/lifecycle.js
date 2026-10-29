// lifecycle.js
// Page lifecycle listeners for the editor session, bound ONCE per page on EVERY
// login path (session restore, fresh OAuth, demo, in-app repo switch).
// They used to be attached in init() after the early return for a fresh OAuth
// login, so a tab signed in via GitHub had no "unsaved changes" prompt until it
// was reloaded. The autosave is read through a getter at event time because
// showApp() rebuilds it on every repo switch.

/**
 * @param {{win: Window, doc: Document, getAutosave: () => any}} opts
 * @returns {boolean} true when the listeners were bound now, false if already bound
 */
export function bindLifecycleListeners({ win, doc, getAutosave }) {
  if (!win || !doc || win.__mdLifecycleBound) return false;
  win.__mdLifecycleBound = true;

  // Switching tabs is the natural checkpoint: write a dirty draft immediately
  // instead of waiting out the idle window. beforeunload is NOT the place for
  // that - a fetch started there is cancelled by the browser.
  doc.addEventListener('visibilitychange', () => {
    const autosave = getAutosave();
    if (doc.visibilityState === 'hidden' && autosave) autosave.onVisibilityChange(true);
  });

  // In the hybrid model hasUnsavedDraft() is true for anything not on GitHub,
  // even a draft already in IndexedDB. Prompt anyway: IndexedDB can be cleared,
  // and work inside the 400ms debounce exists only in memory. Do NOT narrow this
  // to DIRTY_LOCAL. Nothing is fetched here - it would not survive the unload.
  win.addEventListener('beforeunload', (e) => {
    const autosave = getAutosave();
    if (!autosave || !autosave.hasUnsavedDraft()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  return true;
}