# AGENT.md — правила роботи агента с проектом MD-Editor

Цей файл — «шпаргалка» для AI-ассистента (або новаго разработчика) у наступних
сессиях. Тут зiбрано: технології, нюанси архітектуры, що уже робить, що планується,
а головне — реалні «гро́бли» з минулого досвіду, чтобы не наступати на них знову.

---

## 1. Коротке о проекті

Лёгкий **редактор `.md`-файлов для GitHub-репозитория**, що працюе прямо в браузері.
Клиент GitHub REST API через **Personal Access Token** (PAT), який зберігається
**тільки** в `sessionStorage`. Без бекенда, без збірки, без Electron — відкривається
статично (GitHub Pages / чисто `node serve.mjs`).

Гарантия «без збірки» — **фундаментальне правило**. Не вводити TypeScript,
бандлеры, препроцессори чи бекенд без явного згодзи с користувачем.

## 2. Технологіи / стек

| Що | Де (як підключено) |
|---|---|
| Чистий JS (ES-модули, `type="module"`) | Свой код в `js/*.js` — без збірки, браузер разбирає как є |
| **EasyMDE** (на базі CodeMirror 5) | CDN (`easymde.min.js/css`) |
| **marked** (markdown -> HTML) | CDN (глобально `window.marked`) |
| **html2pdf.js** v0.14.0 (html2canvas + jsPDF) | CDN — для PDF-експорту |
| **Font Awesome** | CDN — іконки тулбару |

GitHub REST API: `https://api.github.com${path}` с заголовками
`Authorization: Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`.

## 3. Запуск и тестирование

```bash
node serve.mjs            # локальный сервер -> http://localhost:8080 (порт: process.env.PORT)
npm install               # поставить dev-залежності для тестів (jsdom, marked, ...)
npm test                  # node --test test/*.test.js - 34 юніт-тести
```
- Браузер не дає `<script type="module">` з `file://` — обов'язково по http(s).
- E2E: `pip install playwright && playwright install chromium`, далі
  `node serve.mjs &`, `python3 e2e_smoke_test.py` (мок GitHub API, реальний Chromium).

Тести, що потребує підключені бібліотеки (`image-preview`, `markdown-tokens`),
вимагають `npm install` сперва (вимагають `jsdom`, `marked`). Якщо нема
`node_modules` — вони падають как «module not found», это норма окружения, а не ваш код.

## 4. Структура проекта

```
index.html               HTML-каркас; підключає CDN і js/app.js
css/app.css               всі стилі
AGENT.md                  цей файл
doc/future.md             ідеи/планы на майбутні
serve.mjs                 мінімальний локальний сервер (Node, вбудований http)
js/
  paths.js                чисті функції шляхів/кодування (без DOM/сети)
  markdown-tokens.js      розбір зображень/посилань, «канонічний» HTML (без DOM/сети)
  reference-rewriter.js   перерахунок відносних посилань при переміщенні (без сети)
  github-client.js        тонкий клієнт GitHub REST API
  image-resolver.js       шлях у markdown -> data: URL через API, з кешем
  file-mover.js           оркестрація переміщення файлу + авто-оновление посилань
  image-preview.js        DOM: превью зображень, ручка resize
  editor.js               обгортка EasyMDE (previewRender, refresh, inline-картинки)
  file-tree.js            дерево файлів + drag&drop
  upload.js               завантаження зображень (drag&drop ОС + буфер + кнопка)
  pdf-export.js           експорт активної сторінки в PDF
  app.js                  точка збирання, стан, обробники DOM
test/*.test.js            34 юніт-тести (node:test)
e2e_smoke_test.py         наскрізний тест (Playwright)
```

`.kilo/` — службове робоче дерево/обслуговіщі dump, **не чіпати и не комитить**.

## 5. Архитектурні принципи

1. **Чистий шар від UI.** `paths.js`, `markdown-tokens.js`, `reference-rewriter.js`
   не мають **ЖОДНОЇ** залежності від DOM/`document` та мережі (`fetch`). Всю
   «небезпечну» логіку (парсинг, перерахунок шляхів) тримаем ізоловано, щоб можна
   було юніт-тестувати в Node без браузера. Дотримуйся — не тягай `document`/`fetch` в ці модулі.
2. Модулі спілкується через «dependency injection» (deps-объекти, рендерер передається
   ззовні) — так чисту логіку легко підмінити моком в тестах.
3. Всі коментарии и сообщения — **украинская** (стандарт репозиторію).
4. Ніяких глобальных змін стану без необхідної причини.

## 6. Ключеві нюансы (гро́бли из опыта — ВАЖНО)

### 6.1 Порядок CSS-каскада
`css/app.css` підключать **ПІСЛЯ** `easymde.min.css` і fontawesome.
Якщо `app.css` завантажать раніше — `easymde.min.css` перебʼе наш `display:flex`
на `.EasyMDEContainer`, и CodeMirror перестає обмежуваться по висоті
(«не скролится, показує весь текст одним блоком»). Закоментовано и в `index.html`.

### 6.2 EasyMDE `previewRender` — чисто синхронний
У `editor.js` превью-рендер мусить **нічого не присво́юва** в `previewEl` самостно.
EasyMDE САМ виконує `previewEl.innerHTML = ...` після виклику. Всю постобробку
(ручки resize + резолв картинок) плануємо на наступний тік `setTimeout(0)`, і
защищаєм от гонк через лічилник `previewRenderToken` (якщо прийшов новіший
рендер — старий пром-результат отмається).

### 6.3 CodeMirror.refresh() після показа / ресайзу
CodeMirror може замірити висоту контейнера ДО того, як отримав реальні розміри
(flex-layout, скрытые батьківськи елементи) и «застряти». Тому при відкрітті файлу
і зміні розміру викликаемо `refresh()` — и одразу, и ще раз на наступному кадрі
(`requestAnimationFrame`). Також `ResizeObserver` на `.editor-area`.

### 6.4 Live inline preview зображень в CodeMirror
В `editor.js` зображення markdown (`![alt](path)`) візуально заміняється реальною
картинкою прямо в коді через `cm.markText(..., { replacedWith })`. Оригинальный
`.md` текст не міняється — GitHub зберігає оригінальне. Оброблено и как вставка
из буфера (paste image). Тільки для markdown-посилань на зображення.

### 6.5 Экспорт PDF (ПОСТІЙННАЯ пастка — ЗАПАМЯТУЙ!)
HTML2PDF.js (html2canvas) **клонирует** элемент в свой контейнер и малює його.
- **НЕ задавай контейнеру, що йде в `.from()`, стили `position: fixed`,
  негативный `z-index`, `opacity`, `transform`, `left: -99999px`** — інак canvas
  рендерится порожнім, и в PDF попадає **порожня сторінка**.
- Правильный патерн (вже реализован в `pdf-export.js`): нейтральный контейнер
  (в css без позиціонування) + **прозорий holder** (`position:fixed;left:0;top:0;
  opacity:0;pointer-events:none;z-index:-9999;`), в який вкладаємо контейнер.
  В `.from(container)` передаємо тільки нейтральный контейнер, holder html2canvas не бачить.
- Версия плагина: `html2pdf.js@0.14.0`, должна совпадать с `package.json`.

### 6.6 Base64 и кирилица/эмодзи
`btoa`/`atob` не робат с UTF-8 (кирилица, эмодзи). Завжди использовать
`utf8ToB64`/`b64ToUtf8` (на базі `encodeURIComponent`/`decodeURIComponent`).

### 6.7 GitHub Contents API лимит ~1MB
`getFileB64` спочатку пробує Contents API; при невдачі падає на Git Blobs API
(покрывает большие файлы). Не спускати на лимит без fallback.

### 6.8 Безопаснiсть токена
Токен тільки в **`sessionStorage`** (не `localStorage`), очистка при «Вийти».

## 7. Що вже реализовано (v2.0.0)
- Авторизація через PAT + перевірка репозиторію (getRepoInfo).
- Дерево файлів + drag&drop файлів между папками с авто-перерахунком власных и
  чужих посилань (відносні, кореневі `/шлях`, `<img>`, `[текст](шлях)`).
- Редагування markdown через EasyMDE; створення нових `.md`.
- Зображення: показ у превью и **live картинки прямо в CodeMirror**, масштабування
  ручкою (ширина пише в `<img width>`), вставка из буфера (скріншот) и drag&drop ОС,
  авто-оновление у репозиторій + відносні поселенки.
- Кеш зображень (`ImageResolver`).
- Експорт активної сторінки в PDF (html2pdf.js, зі вставленными картинками).

## 8. Плани (див. `doc/future.md`)
**OAuth-вхід через GitHub** без ручного PAT («увійти через аккаунт», 2FA на телефон).
&#9888; GitHub OAuth не поддерживает PKCE и вимагає `client_secret` для обміну коду
на токен ⇒ потрібен **міні-бекенд/прокси** (Node или serverless). Детальні варіанти
(міні-Node, serverless-функції, Device Flow, гібрид с PAT) чистя в `doc/future.md` —
там же список правок в `app.js`/`index.html`/`github-client.js`/`serve.mjs`.

## 9. Правила перед/після правок
1. **Перед зміною** прочитай відповідний модуль и `AGENT.md` (особенно роздiл 6).
2. Перевірь, що не порушив «чистий шар» (нема `document`/`fetch` в paths/markdown-tokens/reference-rewriter).
3. Після правок `css/` — перевірь каскад (роздiл 6.1) и при PDF-правках — роздiл 6.5.
4. Запусти `npm test` (34 тести). Якщо падають `image-preview`/`markdown-tokens`
   без `node_modules` — це окружение, не твой код.
5. Після правок редактора/превью — запусти `e2e_smoke_test.py`.
6. Не редактируй/не комити файли в `.kilo/`.
7. Коментарий в коді пиш у росчій на украинском.