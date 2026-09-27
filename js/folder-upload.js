// folder-upload.js
// Завантаження папок через drag&drop з файлової системи ОС.
// Використовує File System Access API (webkitGetAsEntry) для отримання структури папки.

import { guessMime } from './paths.js';

/**
 * @param {HTMLElement} dropZoneEl
 * @param {HTMLElement} overlayEl
 * @param {{
 *   client: import('./github-client.js').GitHubClient,
 *   getAllFiles: () => {path:string}[],
 *   onStatus: (msg: string, isError: boolean) => void,
 *   onUploaded: () => void,
 * }} deps
 */
export function setupFolderDropzone(dropZoneEl, overlayEl, deps) {
  let dragCounter = 0;

  const hasItems = (e) => e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0;

  dropZoneEl.addEventListener('dragenter', (e) => {
    if (!hasItems(e)) return;
    e.preventDefault();
    dragCounter++;
    overlayEl.classList.remove('hidden');
    dropZoneEl.classList.add('drop-target');
  });

  dropZoneEl.addEventListener('dragover', (e) => {
    if (!hasItems(e)) return;
    e.preventDefault();
    dropZoneEl.classList.add('drop-target');
  });

  dropZoneEl.addEventListener('dragleave', (e) => {
    if (!hasItems(e)) return;
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      overlayEl.classList.add('hidden');
      dropZoneEl.classList.remove('drop-target');
    }
  });

  dropZoneEl.addEventListener('drop', async (e) => {
    if (!hasItems(e)) return;
    e.preventDefault();
    dragCounter = 0;
    overlayEl.classList.add('hidden');
    dropZoneEl.classList.remove('drop-target');

    const items = Array.from(e.dataTransfer.items);
    const entries = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    if (!entries.length) return;

    deps.onStatus(`Обробка ${entries.length} елемент(ів)...`, false);

    try {
      const allFiles = await collectFilesFromEntries(entries);
      if (!allFiles.length) {
        deps.onStatus('Файлів у папці не знайдено', true);
        return;
      }

      deps.onStatus(`Завантаження ${allFiles.length} файлів...`, false);
      let uploaded = 0;
      for (const { path, file } of allFiles) {
        try {
          const b64 = await fileToBase64(file);
          await deps.client.putFile(path, b64, `Add ${path}`);
          uploaded++;
          deps.onStatus(`Завантажено ${uploaded}/${allFiles.length}...`, false);
        } catch (err) {
          console.error(`Помилка завантаження ${path}:`, err);
          deps.onStatus(`Помилка ${path}: ${err.message}`, true);
        }
      }

      deps.onUploaded();
      deps.onStatus(`Завантажено ${uploaded} файл(ів) ✓`, false);
    } catch (err) {
      deps.onStatus('Помилка: ' + err.message, true);
    }
  });
}

async function collectFilesFromEntries(entries, prefix = '') {
  const files = [];

  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      files.push({ path: prefix + file.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const dirEntries = await readAllDirectoryEntries(reader);
      const subFiles = await collectFilesFromEntries(dirEntries, prefix + entry.name + '/');
      files.push(...subFiles);
    }
  }

  return files;
}

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
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
    reader.readAsDataURL(file);
  });
}