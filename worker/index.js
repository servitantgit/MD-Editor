// worker/index.js
//
// Мінімальний OAuth-шар для заміни ручного вставляння Personal Access Token.
// Ідея: цей Worker НІКОЛИ не проксує звичайні виклики GitHub API (це й далі
// робить js/github-client.js напряму з браузера) — він лише виконує один-єдиний
// крок, який неможливо зробити безпечно в клієнтському JS: обмін одноразового
// `code` на `access_token` за допомогою Client Secret.
//
// Маршрути:
//   GET /auth/login     — редірект на GitHub authorize (з anti-CSRF `state`)
//   GET /auth/callback  — обмінює `code` на токен, повертає токен клієнту
//                         через URL fragment (#gh_token=...), який ніколи
//                         не потрапляє на жоден сервер.
// Усе інше — статичні файли редактора (env.ASSETS).
//
// Обов'язкові налаштування перед деплоєм (див. README-CLOUDFLARE.md):
//   - env.GITHUB_CLIENT_ID     — публічний Client ID OAuth App (можна в wrangler.toml [vars])
//   - env.GITHUB_CLIENT_SECRET — секрет: `wrangler secret put GITHUB_CLIENT_SECRET`
//   - Authorization callback URL у самому GitHub OAuth App має ЗБІГАТИСЯ
//     байт-у-байт з `${origin}/auth/callback` нижче.

const OAUTH_SCOPE = 'repo';
const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_MAX_AGE = 600; // 10 хв на весь вхід через GitHub

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/login') {
      return handleLogin(url, env);
    }
    if (url.pathname === '/auth/callback') {
      return handleCallback(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

function handleLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID) {
    return textResponse('Сервер не налаштований: відсутній GITHUB_CLIENT_ID.', 500);
  }

  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/auth/callback`;

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPE);
  authorizeUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      'Set-Cookie': buildCookie(STATE_COOKIE, state, STATE_COOKIE_MAX_AGE),
    },
  });
}

async function handleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return textResponse(`GitHub повернув помилку: ${oauthError}`, 400);
  }
  if (!code || !returnedState) {
    return textResponse('Відсутні code/state у відповіді GitHub.', 400);
  }

  const expectedState = readCookie(request, STATE_COOKIE);
  if (!expectedState || expectedState !== returnedState) {
    return textResponse(
      'Не вдалося перевірити state (CSRF-захист). Спробуйте увійти ще раз з нуля.',
      400
    );
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return textResponse('Сервер не налаштований: відсутній CLIENT_ID/CLIENT_SECRET.', 500);
  }

  const redirectUri = `${url.origin}/auth/callback`;

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return textResponse(`GitHub token endpoint повернув HTTP ${tokenRes.status}.`, 502);
  }

  const tokenData = await tokenRes.json();
  if (tokenData.error || !tokenData.access_token) {
    return textResponse(
      `Обмін коду на токен не вдався: ${tokenData.error_description || tokenData.error || 'невідома помилка'}`,
      400
    );
  }

  // Токен їде клієнту через fragment (#...), а не query/шлях — fragment
  // не потрапляє в жоден HTTP-запит і не логується сервером/проксі.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/#gh_token=${encodeURIComponent(tokenData.access_token)}`,
      'Set-Cookie': buildCookie(STATE_COOKIE, '', 0), // прибираємо cookie, вона своє відпрацювала
    },
  });
}

function buildCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
