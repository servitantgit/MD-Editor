// upload.js
// Image uploads: drag&drop from the OS into the editor window + the toolbar button.
// Inserts a RELATIVE link (the style the repository already uses) to an
// automatically detected shared images folder.

import { dirnameOf, findAssetFolder, relativePathFromTo, encodeLinkPath, guessMime } from './paths.js';
import { compressImage } from './image-compress.js';

/**
 * @param {HTMLElement} dropZoneEl  element on which we listen for OS file drag&drop
 * @param {HTMLElement} overlayEl   visual "drop to add" overlay
 * @param {{
 *   getClient: () => import('./github-client.js').GitHubClient,
 *   getImageResolver: () => import('./image-resolver.js').ImageResolver,
 *   getCurrentPath: () => string|null,
 *   getAllFiles: () => {path:string}[],
 *   insertText: (text: string) => void,
 *   onStatus: (msg: string, isError: boolean) => void,
 *   onUploaded: () => void,
 * }} deps
 *
 * `getClient`/`getImageResolver` are GETTERS on purpose: showApp() runs again
 * when the user switches repository in-app (no reload) and calls this setup
 * afresh. A client captured by value would be the PREVIOUS session's, so the
 * upload would be committed into the repository the user had just left. Read
 * them at use time (see uploadImage) so a late-arriving session is still the
 * one that gets written to.
 *
 * Binding is idempotent per element: these are stable nodes from index.html,
 * so a second showApp() would otherwise stack a second set of listeners and
 * upload the same image twice (a drop, whose FileList is not cleared, hits
 * every listener — the file ended up in BOTH repositories).
 */
export function setupImageDropzone(dropZoneEl, overlayEl, deps) {
  if (dropZoneEl.dataset.imageDropzoneBound) return;
  dropZoneEl.dataset.imageDropzoneBound = '1';
  let dragCounter = 0;

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  dropZoneEl.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    overlayEl.classList.remove('hidden');
  });
  dropZoneEl.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
  });
  dropZoneEl.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) overlayEl.classList.add('hidden');
  });
  dropZoneEl.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    overlayEl.classList.add('hidden');

    if (!deps.getCurrentPath()) {
      deps.onStatus('Open an .md file first', true);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    for (const f of files) await uploadImage(f, deps);
  });
}

export function pickImageFiles(inputEl, deps) {
  // Same element, same reason as setupImageDropzone. Note the guard is also
  // what keeps a toolbar upload to ONE repository: the first `change` handler
  // clears `e.target.value`, so a duplicate listener would read an empty
  // FileList and no-op — leaving whichever listener was registered first (the
  // PREVIOUS session's client) as the only one that wrote anything.
  if (inputEl.dataset.imagePickBound) return;
  inputEl.dataset.imagePickBound = '1';
  inputEl.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) await uploadImage(f, deps);
  });
}

/**
 * Uploads one image and inserts a relative link to it.
 *
 * Reads `getClient()` / `getImageResolver()` at USE time, not from a captured
 * value: the caller (app.js) re-invokes the setup functions on an in-app repo
 * switch, and a client frozen at bind time belongs to the previous session.
 * `getCurrentPath` / `getAllFiles` were always getters and stay that way.
 *
 * @param {File} file
 * @param {object} deps see setupImageDropzone
 */
export async function uploadImage(file, deps) {
  const currentPath = deps.getCurrentPath();
  if (!currentPath) {
    deps.onStatus('Open an .md file first', true);
    return;
  }

  deps.onStatus('Uploading image...', false);
  try {
    // Paste / drop / toolbar all land here: shrink to <=1920px, opaque PNG -> JPEG (original on any problem).
    file = await compressImage(file);
    const b64 = await fileToBase64(file);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folder = findAssetFolder(deps.getAllFiles().map((f) => f.path), currentPath);
    const imgPath = `${folder}/${Date.now()}_${safeName}`;

    await deps.getClient().putFile(imgPath, b64, `Add image ${imgPath}`);

    // Cache the preview straight from the local file — don't wait for another API round-trip
    deps.getImageResolver().cache.set(imgPath, `data:${file.type || guessMime(imgPath)};base64,${b64}`);

    const relLink = encodeLinkPath(relativePathFromTo(dirnameOf(currentPath), imgPath));
    deps.insertText(`![${file.name.replace(/[[\]]/g, '')}](${relLink})`);

    deps.onUploaded();
    deps.onStatus('Image added ✓', false);
  } catch (e) {
    deps.onStatus('Image error: ' + e.message, true);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip the "data:...;base64," prefix
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
