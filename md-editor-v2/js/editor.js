// editor.js
// Обгортка над EasyMDE. Найважливіше тут — правильна робота з CodeMirror:
// * .refresh() після того, як контейнер стає видимим і отримує реальні розміри
//   (класична причина, чому редактор "не скролиться"/показує 1 рядок — CodeMirror
//   зміряв висоту контейнера ДО того, як той відобразився/отримав фінальний layout);
// * previewRender підключений через async-патерн, задокументований самим EasyMDE.

import { markdownToCanonicalHtml } from './markdown-tokens.js';
import { attachResizeHandles, resolveAllImages } from './image-preview.js';

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{marked: any, imageResolver: import('./image-resolver.js').ImageResolver, getCurrentPath: () => string|null, onImageUploadRequest: () => void}} deps
 */
export function createEditor(textareaEl, deps) {
  let previewRenderToken = 0;
  let inlineImageGeneration = 0;
  let inlineImageMarks = [];
  let inlineImageTimer = null;

  const easyMDE = new EasyMDE({
    element: textareaEl,
    spellChecker: false,
    autosave: { enabled: false },
    placeholder: 'Почніть писати markdown...',
    toolbar: [
      'bold', 'italic', 'heading', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'link',
      {
        name: 'image',
        action: () => deps.onImageUploadRequest(),
        className: 'fa fa-image',
        title: 'Додати зображення у репозиторій',
      }, '|',
      'preview', 'side-by-side', 'fullscreen', '|',
      'guide',
    ],
    status: ['lines', 'words', 'cursor'],
    renderingConfig: { singleLineBreaks: false, codeSyntaxHighlighting: true },
    previewRender(plainText, previewEl) {
      // ВАЖЛИВО: EasyMDE САМ виконує `previewEl.innerHTML = <те, що ми тут повернемо>`
      // одразу після виклику цієї функції — і при перемиканні Preview/Side-by-side,
      // і при easyMDE.value(...). Якщо ми ТУТ синхронно присвоїмо previewEl.innerHTML
      // самі, а потім (після мережевого резолву картинок) асинхронно захочемо
      // оновити ці елементи — буде вже пізно: EasyMDE щойно перезапише весь
      // innerHTML ще раз (тим самим рядком), і наші <img> опиняться у вузлах, які
      // більше не приєднані до сторінки, — картинка "вантажиться" вічно і невидимо
      // для користувача, хоча мережевий запит насправді вже давно відпрацював.
      // Тому previewRender лишається ЧИСТО синхронним і нічого сам не присвоює —
      // постобробку (ручки масштабування + резолв зображень) плануємо на наступний
      // тік через setTimeout(0), коли EasyMDE вже точно встановив фінальний DOM.
      const myToken = ++previewRenderToken;
      let html;
      try {
        html = markdownToCanonicalHtml(plainText, deps.marked);
      } catch (e) {
        console.error('Помилка рендерингу прев’ю:', e);
        return `<div class="render-error"><strong>⚠ Помилка рендерингу прев’ю</strong><br>${escapeHtml(e.message)}</div>`;
      }
      setTimeout(() => finishPreviewRender(previewEl, myToken), 0);
      return html;
    },
  });

  async function finishPreviewRender(previewEl, myToken) {
    if (myToken !== previewRenderToken) return; // тим часом прийшов новіший рендер
    attachResizeHandles(previewEl, easyMDE.codemirror);

    const failCount = await resolveAllImages(previewEl, deps.imageResolver, deps.getCurrentPath(), () => myToken === previewRenderToken);
    if (myToken === previewRenderToken && failCount > 0 && deps.onImageResolveFailures) {
      deps.onImageResolveFailures(failCount);
    }
  }

  /**
   * CodeMirror інколи міряє висоту контейнера ще до того, як той отримав фінальний
   * розмір (flex-layout, приховані батьківські елементи тощо), і "застрягає" з
   * неправильною внутрішньою геометрією — звідси враження, що редактор не скролиться
   * або показує тільки частину тексту. .refresh() примусово перераховує все.
   * Викликаємо і одразу, і ще раз на наступному кадрі (для абсолютної надійності).
   */
  function refreshLayout() {
    easyMDE.codemirror.refresh();
    requestAnimationFrame(() => easyMDE.codemirror.refresh());
  }

  // Вставка зображень із буфера: браузер передає скріншоти/скопійовані картинки
  // як ClipboardItem/Files. Текстову вставку не перехоплюємо.
  easyMDE.codemirror.getInputField().addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;

    event.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) deps.onImagePaste(file);
    }
  });

  // Реагуємо на зміну розміру вікна/контейнера — той самий клас проблем.
  // Live Preview прямо в текстовому полі: Markdown-посилання на зображення
  // залишається в документі, але в CodeMirror візуально замінюється реальною
  // картинкою. Це не змінює текст, який буде збережено в GitHub.
  easyMDE.codemirror.on('change', () => scheduleInlineImages());

  const resizeObserver = new ResizeObserver(() => refreshLayout());
  resizeObserver.observe(textareaEl.closest('.editor-area') || document.body);

  function refreshInlineImages() {
    clearTimeout(inlineImageTimer);
    inlineImageTimer = null;
    renderInlineImages();
  }

  refreshInlineImages();

  return { easyMDE, refreshLayout, refreshInlineImages };
}

function scheduleInlineImages() {
  clearTimeout(inlineImageTimer);
  inlineImageTimer = setTimeout(() => renderInlineImages(), 120);
}

async function renderInlineImages() {
  const cm = easyMDE.codemirror;
  const currentPath = deps.getCurrentPath();
  const generation = ++inlineImageGeneration;

  for (const mark of inlineImageMarks) mark.clear();
  inlineImageMarks = [];

  if (!currentPath) return;

  const text = cm.getValue();
  const re = /!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)/g;
  const matches = [];
  let match;
  while ((match = re.exec(text))) {
    matches.push({
      fromIndex: match.index,
      toIndex: match.index + match[0].length,
      alt: match[1] || '',
      src: match[2],
    });
  }

  for (const item of matches) {
    if (generation !== inlineImageGeneration) return;

    const from = cm.posFromIndex(item.fromIndex);
    const to = cm.posFromIndex(item.toIndex);
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-inline-image';
    wrapper.title = item.src;

    const img = document.createElement('img');
    img.alt = item.alt;
    img.className = 'cm-inline-image-img';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '420px';
    img.style.height = 'auto';
    img.style.display = 'block';

    const loading = document.createElement('span');
    loading.className = 'cm-inline-image-loading';
    loading.textContent = '⏳';
    wrapper.append(img, loading);

    const mark = cm.markText(from, to, { replacedWith: wrapper, clearOnEnter: false });
    inlineImageMarks.push(mark);

    try {
      const url = await deps.imageResolver.resolve(item.src, currentPath);
      if (generation !== inlineImageGeneration || mark.find() == null) return;
      img.src = url;
      img.onload = () => loading.remove();
      img.onerror = () => {
        if (mark.find() != null) mark.clear();
      };
      loading.remove();
    } catch (err) {
      if (generation !== inlineImageGeneration || mark.find() == null) return;
      // Якщо GitHub не віддав файл, не ховаємо Markdown від користувача.
      mark.clear();
      console.warn('Не вдалося показати inline-зображення:', item.src, err);
    }
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
