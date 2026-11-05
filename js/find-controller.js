// find-controller.js
// Display-only marks and explicit navigation. Callers own debounce,
// document lifecycle and recalculation of Search source ranges.

function phraseRanges(text, query) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^\u0024{}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'giu');
  return Array.from(text.matchAll(re), (match) => ({
    from: match.index, to: match.index + match[0].length
  }));
}

export function createFindController(cm, opts = {}) {
  let entries = [];
  let active = null;
  let activeMark = null;
  let pendingInitial = null;
  let mode = 'find';
  let query = '';
  let destroyed = false;

  function rangeOf(entry) {
    const range = entry.mark.find();
    return range && range.from && range.to ? range : null;
  }

  function liveEntries() {
    return entries.filter((entry) => rangeOf(entry));
  }

  function removeActiveMark() {
    if (activeMark) activeMark.clear();
    activeMark = null;
  }

  function clearMarks() {
    cm.operation(() => {
      removeActiveMark();
      for (const entry of entries) entry.mark.clear();
    });
    entries = [];
    active = null;
    pendingInitial = null;
  }

  function install(ranges) {
    clearMarks();
    cm.operation(() => {
      entries = ranges.map((range) => ({
        mark: cm.markText(cm.posFromIndex(range.from), cm.posFromIndex(range.to), {
          className: 'md-find-match',
          atomic: false,
          addToHistory: false
        })
      }));
    });
  }

  function getState() {
    const live = liveEntries();
    const index = active ? live.indexOf(active) : -1;
    return { mode, query, total: live.length, current: index < 0 ? 0 : index + 1 };
  }

  function setQuery(value) {
    if (destroyed) return getState();
    query = String(value ?? '');
    mode = 'find';
    install(phraseRanges(cm.getValue(), query));
    return getState();
  }

  function setRanges(ranges, { initial = 0 } = {}) {
    if (destroyed) return getState();
    const source = cm.getValue();
    for (const range of ranges) {
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to) ||
          range.from < 0 || range.to <= range.from || range.to > source.length) {
        throw new Error('find controller: invalid source range');
      }
    }
    mode = 'search';
    query = '';
    install(ranges);
    pendingInitial = Number.isInteger(initial) && initial >= 0 && initial < entries.length
      ? entries[initial] : null;
    return getState();
  }

  function next({ backwards = false } = {}) {
    if (destroyed) return getState();
    const live = liveEntries();
    if (!live.length) {
      cm.operation(removeActiveMark);
      active = null;
      return getState();
    }

    let target;
    if (!active) {
      target = pendingInitial && live.includes(pendingInitial)
        ? pendingInitial : live[backwards ? live.length - 1 : 0];
    } else {
      // Original mark order preserves the neighbor of a deleted current match.
      const index = entries.indexOf(active);
      const direction = backwards ? -1 : 1;
      for (let step = 1; step <= entries.length; step++) {
        const candidate = entries[
          (index + direction * step + entries.length) % entries.length
        ];
        if (rangeOf(candidate)) {
          target = candidate;
          break;
        }
      }
    }
    pendingInitial = null;
    if (!target) return getState();

    let range = rangeOf(target);
    if (typeof opts.unfoldAtLine === 'function') opts.unfoldAtLine(range.from.line);
    range = rangeOf(target);
    if (!range) return getState();
    cm.operation(() => {
      removeActiveMark();
      activeMark = cm.markText(range.from, range.to, {
        className: 'md-find-current',
        atomic: false,
        addToHistory: false
      });
      active = target;
      cm.setSelection(range.from, range.to);
      cm.scrollIntoView(range, 80);
    });
    return getState();
  }

  function refresh() {
    if (destroyed) return getState();
    if (mode === 'find') install(phraseRanges(cm.getValue(), query));
    else if (active && !rangeOf(active)) {
      cm.operation(removeActiveMark);
      active = null;
    }
    return getState();
  }

  function clear() {
    clearMarks();
    query = '';
    mode = 'find';
    return getState();
  }

  function destroy() {
    if (destroyed) return;
    clear();
    destroyed = true;
  }

  return { setQuery, setRanges, next, refresh, getState, clear, destroy };
}
