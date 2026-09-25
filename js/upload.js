// upload.js
// Завантаження зображень: drag&drop з ОС у вікно редактора + кнопка в тулбарі.
// Вставляє ВІДНОСНЕ посилання (стиль, який уже використовує репозиторій) на
// автоматично визначену спільну теку для зображень.

import { dirnameOf, findAssetFolder, relativePathFromTo, encodeLinkPath, guessMime } from './paths.js';

/**
 * @param {HTMLElement} dropZoneEl  елемент, над яким слухаємо drag&drop файлів з ОС
 * @param {HTMLElement} overlayEl   візуальний оверлей "відпустіть, щоб додати"
 * @param {{
 *   client: import('./github-client.js').GitHubClient,
 *   imageResolver: import('./image-resolver.js').ImageResolver,
 *   getCurrentPath: () => string|null,
 *   getAllFiles: () => {path:string}[],
 *   insertText: (text: string) => void,
 *   onStatus: (msg: string, isError: boolean) => void,
 *   onUploaded: () => void,
 * }} deps
 */
export function setupImageDropzone(dropZoneEl, overlayEl, deps) {
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
      deps.onStatus('Спочатку відкрийте .md файл', true);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    for (const f of files) await uploadImage(f, deps);
  });
}

export function pickImageFiles(inputEl, deps) {
  inputEl.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) await uploadImage(f, deps);
  });
}

async function uploadImage(file, deps) {
  const currentPath = deps.getCurrentPath();
  if (!currentPath) {
    deps.onStatus('Спочатку відкрийте .md файл', true);
    return;
  }

  deps.onStatus('Завантаження картинки...', false);
  try {
    const b64 = await fileToBase64(file);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folder = findAssetFolder(deps.getAllFiles().map((f) => f.path), currentPath);
    const imgPath = `${folder}/${Date.now()}_${safeName}`;

    await deps.client.putFile(imgPath, b64, `Add image ${imgPath}`);

    // Кешуємо прев'ю одразу з локального файлу — не чекаємо повторного запиту до API
    deps.imageResolver.cache.set(imgPath, `data:${file.type || guessMime(imgPath)};base64,${b64}`);

    const relLink = encodeLinkPath(relativePathFromTo(dirnameOf(currentPath), imgPath));
    deps.insertText(`![${file.name.replace(/[[\]]/g, '')}](${relLink})`);

    deps.onUploaded();
    deps.onStatus('Картинку додано ✓', false);
  } catch (e) {
    deps.onStatus('Помилка картинки: ' + e.message, true);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // прибираємо "data:...;base64," префікс
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
    reader.readAsDataURL(file);
  });
}
