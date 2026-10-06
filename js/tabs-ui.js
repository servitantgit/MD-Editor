// tabs-ui.js
// Renders the tab strip and reports what the user did with it. It owns no state:
// app.js hands it the full picture on every render() and it rebuilds the strip.
// Nothing here talks to GitHub or the editor.

/**
 * @param {HTMLElement} container  the #tab-bar element
 * @param {{
 *   onActivate: (path: string) => void,
 *   onClose: (path: string) => void,
 * }} handlers
 */
export function createTabBar(container, handlers) {
  const doc = container.ownerDocument;

  function pathOf(el) {
    const tab = el && el.closest ? el.closest('.tab') : null;
    return tab && container.contains(tab) ? tab.dataset.path : null;
  }

  function onClick(e) {
    if (e.target.closest && e.target.closest('.tab-close')) {
      const path = pathOf(e.target);
      if (path) handlers.onClose(path);
      return;
    }
    const path = pathOf(e.target);
    if (path) handlers.onActivate(path);
  }

  // Middle-click closes, as in every browser. mousedown is cancelled first, or
  // some platforms start auto-scroll instead.
  function onMouseDown(e) {
    if (e.button === 1 && pathOf(e.target)) e.preventDefault();
  }
  function onAuxClick(e) {
    if (e.button !== 1) return;
    const path = pathOf(e.target);
    if (path) {
      e.preventDefault();
      handlers.onClose(path);
    }
  }

  function onKeyDown(e) {
    const tabs = Array.from(container.querySelectorAll('.tab'));
    const idx = tabs.indexOf(e.target.closest && e.target.closest('.tab'));
    if (idx === -1) return;
    let target = null;
    if (e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') target = tabs[0];
    else if (e.key === 'End') target = tabs[tabs.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') target = tabs[idx];
    if (!target) return;
    e.preventDefault();
    handlers.onActivate(target.dataset.path);
    target.focus();
  }

  container.addEventListener('click', onClick);
  container.addEventListener('mousedown', onMouseDown);
  container.addEventListener('auxclick', onAuxClick);
  container.addEventListener('keydown', onKeyDown);

  /**
   * @param {{
   *   paths: string[],
   *   active: string|null,
   *   labels: Map<string, string>,
   *   dirty?: Set<string>,
   * }} view
   */
  function render(view) {
    const { paths, active, labels, dirty = new Set() } = view;

    // Rebuilding the strip would otherwise drop keyboard focus mid-navigation.
    const focused = pathOf(doc.activeElement);

    container.textContent = '';
    container.classList.toggle('hidden', paths.length === 0);

    for (const path of paths) {
      const label = labels.get(path) || path;
      const isActive = path === active;

      const tab = doc.createElement('div');
      tab.className = 'tab' + (isActive ? ' active' : '') + (dirty.has(path) ? ' dirty' : '');
      tab.dataset.path = path;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('title', path);
      // Roving tabindex: one stop in the strip, arrows move inside it.
      tab.tabIndex = isActive || (!active && path === paths[0]) ? 0 : -1;

      const name = doc.createElement('span');
      name.className = 'tab-label';
      name.textContent = label;

      const dot = doc.createElement('span');
      dot.className = 'tab-dirty';
      dot.textContent = '●';
      dot.setAttribute('aria-label', 'unsaved changes');
      dot.setAttribute('title', 'Not saved to GitHub yet');

      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.textContent = '×';
      close.tabIndex = -1;
      close.setAttribute('aria-label', `Close ${label}`);
      close.setAttribute('title', 'Close tab');

      tab.append(name, dot, close);
      container.appendChild(tab);

      if (focused === path) tab.focus();
      if (isActive && typeof tab.scrollIntoView === 'function') {
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  function destroy() {
    container.removeEventListener('click', onClick);
    container.removeEventListener('mousedown', onMouseDown);
    container.removeEventListener('auxclick', onAuxClick);
    container.removeEventListener('keydown', onKeyDown);
    container.textContent = '';
  }

  return { render, destroy };
}
