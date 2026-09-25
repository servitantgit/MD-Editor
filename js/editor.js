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
  const resizeObserver = new ResizeObserver(() => refreshLayout());
  resizeObserver.observe(textareaEl.closest('.editor-area') || document.body);

  return { easyMDE, refreshLayout };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
