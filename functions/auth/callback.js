// functions/auth/callback.js
//
// Cloudflare Pages Function для GET /auth/callback. Це той самий крок, який
// небезпечно робити в браузерному JS: обмін одноразового `code` на
// `access_token` за допомогою Client Secret. GitHub API для цього викликається
// звідси (з боку Pages Function), а не з клієнтського коду.
//
// Токен повертається клієнту через URL fragment (#gh_token=...) — fragment
// ніколи не потрапляє на жоден сервер/у жоден лог, так само як раніше
// Personal Access Token жив лише в sessionStorage.

const STATE_COOKIE = 'oauth_state';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
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
    return textResponse(
      'Сервер не налаштований: у Pages-проєкті відсутня GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET.',
      500
    );
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

  return new Response(null, {
    status: 302,
    headers: {
      Location: `/#gh_token=${encodeURIComponent(tokenData.access_token)}`,
      'Set-Cookie': `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
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
