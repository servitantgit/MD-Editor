// folder-upload.js
// Folder uploads via drag&drop from the OS file system (webkitGetAsEntry).
// Everything dropped lands in the folder under the cursor in ONE commit
// (GitHubClient.commitFiles), or nothing is written. Rules: AGENTS.md.

const SKIP_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

/**
 * @param {HTMLElement} dropZoneEl
 * @param {HTMLElement} overlayEl
 * @param {{
 *   getClient: () => import('./github-client.js').GitHubClient,
 *   getBranch: () => string,
 *   getSessionGeneration?: () => number,
 *   onStatus: (msg: string, isError: boolean) => void,
 *   onUploaded: () => void,
 * }} deps
 *
 * Getters, and an idempotent binding: showApp() re-runs on an in-app repo
 * switch, and a second set of listeners on this stable node would upload
 * the dropped folder twice.
 */
export function setupFolderDropzone(dropZoneEl, overlayEl, deps) {
  if (dropZoneEl.dataset.folderDropzoneBound) return;
  dropZoneEl.dataset.folderDropzoneBound = '1';
  let dragCounter = 0;
  let busy = false;

  // Only OS drags carry Files. Internal tree drags carry string payloads only
  // and are left entirely to the tree: no preventDefault, no overlay.
  const isExternal = (e) => !!(e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes('Files'));

  const hideOverlay = () => {
    dragCounter = 0;
    overlayEl.classList.add('hidden');
    dropZoneEl.classList.remove('drop-target');
  };

  dropZoneEl.addEventListener('dragenter', (e) => {
    if (!isExternal(e)) return;
    e.preventDefault();
    dragCounter++;
    overlayEl.classList.remove('hidden');
    dropZoneEl.classList.add('drop-target');
  });

  dropZoneEl.addEventListener('dragover', (e) => {
    if (!isExternal(e)) return;
    e.preventDefault();
    dropZoneEl.classList.add('drop-target');
  });

  dropZoneEl.addEventListener('dragleave', (e) => {
    if (!isExternal(e)) return;
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) hideOverlay();
  });

  dropZoneEl.addEventListener('drop', (e) => {
    if (!isExternal(e)) return;
    e.preventDefault();
    hideOverlay();
    if (busy) {
      deps.onStatus('Upload in progress, wait for it to finish', true);
      return;
    }
    // Read everything synchronously: the entries and the drop target are gone
    // after the first await, and the commit goes to the session dropped into.
    const entries = [];
    for (const item of Array.from(e.dataTransfer.items || [])) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (!entries.length) return;
    const target = dropTargetFolder(e.target, dropZoneEl);
    const client = deps.getClient();
    const branch = deps.getBranch();
    const generation = deps.getSessionGeneration ? deps.getSessionGeneration() : null;
    const current = () => deps.getClient() === client
      && (!deps.getSessionGeneration || deps.getSessionGeneration() === generation);
    busy = true;
    uploadEntries(entries, target, { client, branch, current, deps })
      .finally(() => { busy = false; });
  });
}

/** Folder under the cursor: folder row, file row's folder, active strip, else root. */
function dropTargetFolder(el, zone) {
  if (!el || typeof el.closest !== 'function') return '';
  const inZone = (n) => (n && zone.contains(n) ? n : null);
  const folder = inZone(el.closest('.file-item.folder[data-path]'));
  if (folder) return folder.dataset.path || '';
  const file = inZone(el.closest('[data-path]'));
  if (file) return parentOf(file.dataset.path || '');
  const strip = inZone(el.closest('[data-target-folder]'));
  if (strip) return strip.dataset.targetFolder || '';
  return '';
}

async function uploadEntries(entries, target, { client, branch, current, deps }) {
  const where = target || '/';
  try {
    deps.onStatus('Reading ' + entries.length + ' item(s)...', false);
    const skipped = { n: 0 };
    const found = await collectFiles(entries, '', skipped);
    const skipNote = skipped.n ? ' (skipped ' + skipped.n + ')' : '';
    if (!found.length) {
      deps.onStatus('No files found' + skipNote, true);
      return;
    }
    const items = found.map((f) => ({ path: target ? target + '/' + f.rel : f.rel, file: f.file }));
    const clashes = findDropClashes(items.map((x) => x.path));
    if (clashes.length) {
      deps.onStatus(conflictMessage('clash inside the drop (letter case or file/folder)', clashes), true);
      return;
    }
    deps.onStatus('Checking ' + where + ' for existing files...', false);
    const tree = await client.getTree(branch);
    const existing = findExisting(items.map((x) => x.path), (tree || []).map((t) => t.path));
    if (existing.length) {
      deps.onStatus(conflictMessage('already exist', existing), true);
      return;
    }
    const files = [];
    for (const it of items) {
      let b64;
      try {
        b64 = await fileToBase64(it.file);
      } catch (err) {
        deps.onStatus('Could not read ' + it.path + ': ' + (err && err.message) + '. Nothing was uploaded', true);
        return;
      }
      files.push({ path: it.path, contentB64: b64 });
    }
    deps.onStatus('Uploading ' + files.length + ' file(s) to ' + where + '...', false);
    await client.commitFiles(branch, commitMessage(entries), files);
    if (!current()) return;
    deps.onUploaded();
    deps.onStatus('Uploaded ' + files.length + ' file(s) to ' + where + skipNote, false);
  } catch (err) {
    if (current()) {
      deps.onStatus('Upload failed, nothing was written: ' + ((err && err.message) || String(err)), true);
    }
  }
}

function commitMessage(entries) {
  if (entries.length > 1) return 'Upload ' + entries.length + ' items';
  const e = entries[0];
  return (e.isDirectory ? 'Upload folder ' : 'Upload ') + e.name;
}

function conflictMessage(reason, list) {
  return 'Upload cancelled, nothing was written: ' + list.length + ' path(s) ' + reason + ': '
    + list.slice(0, 3).join(', ') + (list.length > 3 ? ', ...' : '');
}

function isSkippedFile(name) {
  return SKIP_FILES.has(name.toLowerCase()) || name.startsWith('~$');
}

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/** Lower-cased folder paths implied by a list of file paths. */
function ancestorSet(paths) {
  const set = new Set();
  for (const p of paths) {
    const parts = p.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return set;
}

/** Paths inside one drop that collide case-insensitively, or a file named like a folder. */
function findDropClashes(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const k = p.toLowerCase();
    if (seen.has(k)) out.push(p); else seen.add(k);
  }
  const dirs = ancestorSet(paths);
  for (const p of paths) if (dirs.has(p.toLowerCase())) out.push(p);
  return out;
}

/** Case-insensitive: same path, a file over an existing folder, or a folder over an existing file. */
function findExisting(paths, repoPaths) {
  const files = new Set(repoPaths.map((p) => p.toLowerCase()));
  const dirs = ancestorSet(repoPaths);
  const out = [];
  for (const p of paths) {
    const k = p.toLowerCase();
    let hit = files.has(k) || dirs.has(k);
    const parts = k.split('/');
    for (let i = 1; i < parts.length && !hit; i++) hit = files.has(parts.slice(0, i).join('/'));
    if (hit) out.push(p);
  }
  return out;
}

async function collectFiles(entries, prefix, skipped) {
  const files = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory) {
      if (name.toLowerCase() === '.git') { skipped.n++; continue; }
      const children = await readAllDirectoryEntries(entry.createReader());
      files.push(...await collectFiles(children, prefix + name + '/', skipped));
    } else if (entry.isFile) {
      if (isSkippedFile(name)) { skipped.n++; continue; }
      const file = await new Promise((resolve, reject) => { entry.file(resolve, reject); });
      files.push({ rel: prefix + name, file });
    }
  }
  return files;
}

// readEntries returns at most ~100 entries per call: read until an empty batch.
function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readNext = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries);
        } else {
          entries.push(...batch);
          readNext();
        }
      }, reject);
    };
    readNext();
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}