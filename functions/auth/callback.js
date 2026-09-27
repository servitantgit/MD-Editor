// functions/auth/callback.js
//
// Cloudflare Pages Function for GET /auth/callback. This is the step that is
// unsafe to do in browser JS: exchanging the one-time `code` for an
// `access_token` with the help of the Client Secret. The GitHub API for this is called
// from here (from the Pages Function side), not from client code.
//
// The token is returned to the client via a URL fragment (#gh_token=...) — a fragment
// never reaches any server/log, just like the
// Personal Access Token previously lived only in sessionStorage.

const STATE_COOKIE = 'oauth_state';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return textResponse(`GitHub returned an error: ${oauthError}`, 400);
  }
  if (!code || !returnedState) {
    return textResponse('Missing code/state in the GitHub response.', 400);
  }

  const expectedState = readCookie(request, STATE_COOKIE);
  if (!expectedState || expectedState !== returnedState) {
    return textResponse(
      'Could not verify state (CSRF protection). Please try signing in again from scratch.',
      400
    );
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return textResponse(
      'Server is not configured: the Pages project is missing GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET.',
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
    return textResponse(`GitHub token endpoint returned HTTP ${tokenRes.status}.`, 502);
  }

  const tokenData = await tokenRes.json();
  if (tokenData.error || !tokenData.access_token) {
    return textResponse(
      `Code-for-token exchange failed: ${tokenData.error_description || tokenData.error || 'unknown error'}`,
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
