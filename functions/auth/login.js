// functions/auth/login.js
//
// Cloudflare Pages Function (не Worker!). Файл у /functions/auth/login.js
// автоматично стає маршрутом GET /auth/login — Pages сама підхоплює це
// на кожному Git-деплої, без жодних змін у wrangler.toml чи процесі деплою.
//
// Роль цього маршруту: почати GitHub OAuth — згенерувати anti-CSRF `state`,
// покласти його в HttpOnly-cookie і відправити користувача на GitHub.

const OAUTH_SCOPE = 'repo';
const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_MAX_AGE = 600; // 10 хв на весь вхід через GitHub

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID) {
    return new Response(
      'Сервер не налаштований: у Pages-проєкті відсутня змінна оточення GITHUB_CLIENT_ID.',
      { status: 500 }
    );
  }

  const url = new URL(request.url);
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
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_COOKIE_MAX_AGE}`,
    },
  });
}
