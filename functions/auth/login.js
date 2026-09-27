// functions/auth/login.js
//
// Cloudflare Pages Function (not a Worker!). A file at /functions/auth/login.js
// automatically becomes the GET /auth/login route — Pages picks it up
// on every Git deploy, with no wrangler.toml or deploy-process changes.
//
// Role of this route: start GitHub OAuth — generate an anti-CSRF `state`,
// store it in an HttpOnly cookie, and send the user to GitHub.

const OAUTH_SCOPE = 'repo';
const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_MAX_AGE = 600; // 10 min for the whole GitHub login

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID) {
    return new Response(
      'Server is not configured: the Pages project is missing the GITHUB_CLIENT_ID environment variable.',
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
