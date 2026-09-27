# AGENTS.md

Коротко: якщо збираєшся щось міняти в деплої, логіні чи тестах цього проєкту —
прочитай це спочатку. Все нижче — реальні граблі, на які вже наступили під час
впровадження GitHub OAuth (вересень 2026), не наступай повторно.

## Як насправді деплоїться цей проєкт

- **Cloudflare Pages з Git-інтеграцією** — автодеплой на push у `main`/`master`.
  Живий домен: `https://md-edit.pages.dev`.
- `wrangler.toml` у корені репозиторію — **залишок від невдалої першої спроби**
  зробити OAuth через окремий Cloudflare Worker (`main = "worker/index.js"` +
  `[assets]`). Git-деплой Pages **не читає** `wrangler.toml` взагалі — будь-який
  `main`-скрипт там просто ніколи не виконується. Якщо колись захочеться
  перейти на `wrangler pages deploy` як CLI-спосіб деплою — тоді `wrangler.toml`
  знову стане релевантним, а поки що вважай його неробочим.
- Серверна логіка (зараз — тільки GitHub OAuth) живе у `/functions` як
  **Cloudflare Pages Functions**: файл `functions/auth/callback.js`
  автоматично стає маршрутом `GET /auth/callback`, `functions/auth/login.js` —
  `GET /auth/login`. Формат хендлера — `export async function onRequestGet({ request, env })`.
  Це **інший API**, ніж у Cloudflare Workers (`export default { fetch(request, env, ctx) }`) —
  не плутай, якщо копіюєш приклади коду з документації Workers.

**Головний висновок, який тут коштував цілої зайвої ітерації:** перш ніж писати
серверний код під конкретний Cloudflare-продукт, перевір, звідки насправді
обслуговується живий домен (дашборд Cloudflare, або просто вигляд URL:
`*.pages.dev` → Pages, `*.workers.dev`/кастомний домен без `.pages.dev` →
Workers). Тут спочатку повністю реалізували Worker (`worker/index.js` +
`wrangler.toml main`), і він просто ніколи не запускався в проді, бо прод
живе на іншому продукті.

## OAuth: як влаштовано і чого там свідомо нема

- Flow: `/auth/login` → редірект на `github.com/login/oauth/authorize` (з
  anti-CSRF `state` у HttpOnly-cookie) → GitHub-логін і 2FA на боці GitHub →
  `/auth/callback` міняє `code` на `access_token` (Client Secret
  використовується тільки тут, на сервері) → токен віддається клієнту через
  `#gh_token=...` у URL fragment — fragment ніколи не йде на сервер/у логи —
  → `js/app.js` (`consumeOAuthRedirect()`) забирає його з `location.hash` і
  кладе в `sessionStorage`, так само, як раніше туди клався вручну вставлений PAT.
- **Немає refresh-token.** GitHub OAuth App має чекбокс "Expire user access
  tokens" — він має лишатись **вимкненим**, інакше токен помирає через ~8г
  без автооновлення (сесія просто обнуляється, юзер тисне "Увійти" ще раз).
  Якщо колись знадобиться довша сесія без повторного логіну — треба додати в
  `functions/auth/callback.js` (і десь ще) обмін `grant_type=refresh_token`,
  зараз цього коду немає.
- Owner/Repository не проходять через сам OAuth round-trip до GitHub (GitHub
  про них узагалі не знає) — вони кладуться в `sessionStorage`
  (`gh_pending_owner`/`gh_pending_repo`) прямо перед редіректом і забираються
  назад після `/auth/callback` у тій самій `consumeOAuthRedirect()`. Якщо
  колись переробляти форму логіну — не забудь, що ця пара ключів має пережити
  повну подорож на github.com і назад (це той самий tab, sessionStorage
  зберігається).
- `readSession()` у `js/app.js` очікує рівно чотири ключі sessionStorage:
  `gh_token`, `gh_owner`, `gh_repo`, `gh_branch`. Це той самий контракт, яким
  користується e2e-тест (див. нижче) — міняєш один, синхронізуй інший.
- Redirect URI/callback у GitHub OAuth App має збігатися символ-у-символ:
  `https://md-edit.pages.dev/auth/callback`. GitHub у новому UI назвав це поле
  "Redirect URI", а не "Authorization callback URL" — та сама штука.

## Змінні оточення — тільки через дашборд Cloudflare Pages, не wrangler

`GITHUB_CLIENT_ID` (Type: **Text**) і `GITHUB_CLIENT_SECRET` (Type: **Secret**)
задаються в Cloudflare dashboard → Workers & Pages → проєкт → Settings →
Environment variables, окремо для Production і Preview. **`wrangler secret
put` тут не працює** — це команда для Workers-проєктів, а не для Pages
Git-деплою. Зміни змінних оточення підхоплюються тільки на **наступному
білді** — після збереження треба ще раз задеплоїти (порожній push або "Retry
deployment" у дашборді), інакше застосунок далі бачитиме старі/відсутні
значення.

## Локальна розробка НЕ бачить /auth/*

`node serve.mjs` — голий статичний файл-сервер, він не виконує нічого з
`/functions`. Кнопка "Увійти через GitHub" на `localhost:8080` зловить 404 або
fallback на `index.html` без стилів (саме так це вперше й виявили — нестильований
екран логіну на `/auth/login`, бо CSS підключений відносним шляхом `./css/app.css`,
який ламається, коли поточний URL не `/`). Щоб реально прогнати OAuth-флоу
локально — піднімай через `npx wrangler pages dev .` (емулює і статику, і Pages
Functions), а не `node serve.mjs`.

## package-lock.json — тиха пастка з npm ci

`npm install` локально може сказати "up to date" і нічого не змінити, а `npm
ci` в GitHub Actions при цьому впаде з `EUSAGE: Missing: ... from lock file`.
Причина, знайдена тут: лок-файл мав неповні "stub"-записи для транзитивних
`"*"`-залежностей (`@types/tern`, `typo-js` — тягнуться через
easymde/codemirror-spell-checker) без `resolved`/`integrity`, і взагалі
бракувало запису `@types/estree`. `npm install --package-lock-only` це не
лагодить, якщо локальний npm-кеш вже "задоволений" старим станом.

**Перед будь-яким push, що чіпає `package.json`, або просто коли є сумнів** —
прожени сам `npm ci` локально, а не покладайся на те, що CI перший це виявить:

```bash
rm -rf node_modules package-lock.json
npm install
rm -rf node_modules
npm ci      # має пройти без EUSAGE
npm test
```

## e2e_smoke_test.py не тестує справжній OAuth

Тест не може пройти через реальний GitHub OAuth — немає живих credentials у
CI, і навіть локально `node serve.mjs` не піднімає `/functions`. Тому тест
одразу кладе фейковий токен/owner/repo напряму в `sessionStorage` (ті самі
чотири ключі з `readSession()`, див. вище) і перезавантажує сторінку — це
імітує стан "вже залогінений", а не сам процес логіну. `/auth/login` і
`/auth/callback` цим тестом не покриті взагалі. Якщо колись знадобиться
реально перевірити сам OAuth round-trip — це вже окремий сценарій з `wrangler
pages dev` і тестовим GitHub OAuth App (або мокнутим `github.com`), такого
тут поки нема.

## Загальне правило перед тим, як вважати задачу завершеною

Тут двічі поспіль ламався CI одразу після мержу (спершу `npm ci`, потім
неактуальний селектор `#input-token` в e2e-тесті), хоча самі зміни виглядали
несуттєвими відносно основної задачі. Перед push:

1. `npm ci && npm test` — з нуля, без залишків старого `node_modules`.
2. Якщо змінювався `index.html` / `js/app.js` / щось у логіні — прогнати
   `e2e_smoke_test.py` локально (`node serve.mjs &` потім
   `python3 e2e_smoke_test.py`), а не тільки покладатись на CI.
3. Якщо змінювалась інфраструктура деплою — спершу перевір, який продукт
   Cloudflare насправді обслуговує живий домен, і тільки потім пиши код під
   нього.
