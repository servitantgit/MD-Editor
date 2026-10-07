// commit-ui.js
// DOM for Commit panel + History panel. Pure presentation; app.js supplies data & actions.

/**
 * @param {{
 *   panelEl: HTMLElement,
 *   messageEl: HTMLTextAreaElement,
 *   filesEl: HTMLElement,
 *   btnCommit: HTMLElement,
 *   btnCommitPush: HTMLElement,
 *   btnClose: HTMLElement,
 *   onCommit: (message: string, andPush: boolean) => void,
 *   onClose: () => void,
 *   onFileClick: (path: string) => void,
 * }} opts
 */
export function bindCommitPanel(opts) {
  const {
    panelEl, messageEl, filesEl, btnCommit, btnCommitPush, btnClose,
    onCommit, onClose, onFileClick,
  } = opts;

  btnClose.addEventListener('click', () => onClose());
  btnCommit.addEventListener('click', () => {
    const msg = (messageEl.value || '').trim();
    if (!msg) {
      messageEl.focus();
      return;
    }
    onCommit(msg, false);
  });
  btnCommitPush.addEventListener('click', () => {
    const msg = (messageEl.value || '').trim();
    if (!msg) {
      messageEl.focus();
      return;
    }
    onCommit(msg, true);
  });

  return {
    open(changes) {
      panelEl.classList.remove('hidden');
      filesEl.innerHTML = '';
      if (!changes.length) {
        filesEl.innerHTML = '<div class="cp-empty">No changes to commit</div>';
        btnCommit.disabled = true;
        btnCommitPush.disabled = true;
      } else {
        btnCommit.disabled = false;
        btnCommitPush.disabled = false;
        for (const c of changes) {
          const row = document.createElement('div');
          row.className = 'cp-file';
          row.dataset.path = c.path;
          const badge = c.status === 'A' ? 'A' : 'M';
          const badgeCls = c.status === 'A' ? 'badge-a' : 'badge-m';
          const stats = c.stats
            ? `<span class="stats"><span class="s-add">+${c.stats.additions}</span> <span class="s-del">−${c.stats.deletions}</span></span>`
            : '<span class="stats muted">diff</span>';
          row.innerHTML =
            `<span class="${badgeCls}">${badge}</span>` +
            `<span class="path" title="${escapeAttr(c.path)}">${escapeAttr(c.path)}</span>` +
            stats;
          row.addEventListener('click', () => {
            filesEl.querySelectorAll('.cp-file').forEach((el) => el.classList.remove('sel'));
            row.classList.add('sel');
            onFileClick(c.path);
          });
          filesEl.appendChild(row);
        }
      }
      if (!messageEl.value.trim() && changes.length) {
        const first = changes[0].path;
        messageEl.value = changes.length === 1
          ? `Update ${first}`
          : `Update ${changes.length} files`;
      }
      messageEl.focus();
    },
    close() {
      panelEl.classList.add('hidden');
    },
    setBusy(busy) {
      btnCommit.disabled = busy;
      btnCommitPush.disabled = busy;
      messageEl.disabled = busy;
    },
    clearMessage() {
      messageEl.value = '';
    },
  };
}

/**
 * @param {{
 *   panelEl: HTMLElement,
 *   listEl: HTMLElement,
 *   detailEl: HTMLElement,
 *   btnClose: HTMLElement,
 *   onClose: () => void,
 *   onSelect: (sha: string) => void,
 *   onRestore: (file: object, commitSha: string) => void,
 * }} opts
 */
export function bindHistoryPanel(opts) {
  const { panelEl, listEl, detailEl, btnClose, onClose, onSelect, onRestore } = opts;
  btnClose.addEventListener('click', () => onClose());

  return {
    open() {
      panelEl.classList.remove('hidden');
      panelEl.classList.remove('with-detail');
      if (detailEl) {
        detailEl.innerHTML = '<div class="hist-empty">Select a commit</div>';
      }
    },
    close() {
      panelEl.classList.add('hidden');
      panelEl.classList.remove('with-detail');
      if (detailEl) detailEl.innerHTML = '';
    },
    isOpen() {
      return panelEl && !panelEl.classList.contains('hidden');
    },
    renderList(commits) {
      listEl.innerHTML = '';
      if (!commits.length) {
        listEl.innerHTML = '<div class="hist-empty">No commits found</div>';
        return;
      }
      for (const c of commits) {
        const item = document.createElement('div');
        item.className = 'hist-item';
        item.dataset.sha = c.sha;
        item.innerHTML =
          `<div class="hist-sha">${escapeAttr(c.sha.slice(0, 7))}</div>` +
          `<div class="hist-msg">${escapeAttr(c.message.split('\n')[0])}</div>` +
          `<div class="hist-meta"><span>${escapeAttr(c.author)}</span><span>${escapeAttr(c.date)}</span></div>` +
          (c.stats ? `<div class="hist-files">${escapeAttr(c.stats)}</div>` : '');
        item.addEventListener('click', () => {
          listEl.querySelectorAll('.hist-item').forEach((el) => el.classList.remove('sel'));
          item.classList.add('sel');
          onSelect(c.sha);
        });
        listEl.appendChild(item);
      }
    },
    renderDetail(detail) {
      panelEl.classList.add('with-detail');
      detailEl.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'hist-detail-h';
      head.innerHTML =
        `<span class="hist-sha">${escapeAttr(detail.sha.slice(0, 7))}</span> ` +
        `<span>${escapeAttr(detail.message.split('\n')[0])}</span>`;
      detailEl.appendChild(head);

      for (const f of detail.files || []) {
        const block = document.createElement('div');
        block.className = 'diff-file';
        const st = (f.status || 'modified')[0].toUpperCase();
        const badgeCls = st === 'A' ? 'badge-a' : st === 'D' ? 'badge-d' : 'badge-m';
        const add = f.additions != null ? `+${f.additions}` : '';
        const del = f.deletions != null ? `−${f.deletions}` : '';
        const canRestore = f.status !== 'removed' && f.status !== 'deleted';

        const header = document.createElement('div');
        header.className = 'diff-file-h';
        header.innerHTML =
          `<span class="${badgeCls}">${escapeAttr(st)}</span> ` +
          `<span class="diff-fname">${escapeAttr(f.filename)}</span>` +
          `<span class="diff-stats">${add} ${del}</span>`;

        if (canRestore && typeof onRestore === 'function') {
          const btn = document.createElement('button');
          btn.className = 'secondary btn-restore';
          btn.textContent = 'Restore';
          btn.title = 'Load this version into the editor (as local changes)';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onRestore(f, detail.sha);
          });
          header.appendChild(btn);
        }
        block.appendChild(header);

        if (f.patch) {
          const pre = document.createElement('pre');
          pre.className = 'diff-patch';
          for (const line of f.patch.split('\n')) {
            const div = document.createElement('div');
            if (line.startsWith('+') && !line.startsWith('+++')) div.className = 'diff-add';
            else if (line.startsWith('-') && !line.startsWith('---')) div.className = 'diff-del';
            else if (line.startsWith('@@')) div.className = 'diff-hunk';
            div.textContent = line;
            pre.appendChild(div);
          }
          block.appendChild(pre);
        }
        detailEl.appendChild(block);
      }

      if (!(detail.files || []).length) {
        const empty = document.createElement('div');
        empty.className = 'hist-empty';
        empty.textContent = 'No file changes in this commit';
        detailEl.appendChild(empty);
      }
    },
    setLoading(msg) {
      const text = msg || 'Loading…';
      if (/loading diff/i.test(text)) panelEl.classList.add('with-detail');
      detailEl.innerHTML = `<div class="hist-empty">${escapeAttr(text)}</div>`;
    },
  };
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
