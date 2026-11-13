// editor-engine.js
// Which editor implementation is active: Classic (EasyMDE) or experimental CM6.
// Default is always Classic. CM6 is opt-in via localStorage or ?editor=cm6.

export const ENGINE_CLASSIC = 'easymde';
export const ENGINE_CM6 = 'cm6';

const STORAGE_KEY = 'md_editor_engine';

/** @returns {'easymde'|'cm6'} */
export function getEditorEngine() {
  try {
    const q = new URLSearchParams(location.search).get('editor');
    if (q === ENGINE_CM6 || q === 'codemirror6') return ENGINE_CM6;
    if (q === ENGINE_CLASSIC || q === 'classic') return ENGINE_CLASSIC;
  } catch (_) { /* ignore */ }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === ENGINE_CM6) return ENGINE_CM6;
  } catch (_) { /* ignore */ }
  return ENGINE_CLASSIC;
}

/** @param {'easymde'|'cm6'} engine */
export function setEditorEngine(engine) {
  const next = engine === ENGINE_CM6 ? ENGINE_CM6 : ENGINE_CLASSIC;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch (_) { /* ignore */ }
  return next;
}

export function isCm6Engine() {
  return getEditorEngine() === ENGINE_CM6;
}
