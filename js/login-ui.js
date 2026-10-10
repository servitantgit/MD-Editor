// login-ui.js
// Sign-in + repo-selection UI. Owns the OAuth protocol and the two ways a
// repository gets chosen (the post-OAuth picker and the in-app switcher). It
// knows NOTHING about app state (state, client, autosave) — the caller hands it
// the DOM nodes it needs and takes the credentials back through onSignedIn.
//
// Extracted from js/app.js as a pure, behavior-preserving move: every line that
// lived in app.js does exactly the same thing here. The only rewiring is that
// calls that used to reach app.js internals (showApp/loadTree/state/setSaveStatus/
// autosave/demo) now go through the deps object below.

import { GitHubClient } from './github-client.js';
import { parseGitHubOwnerRepo } from './github-repo-url.js';

/**
 * Wires up the sign-in flow: Sign in button, OAuth callback consumption,
 * session restore from sessionStorage, the post-OAuth repository picker, the
 * in-app repository switcher, and the "signed in / need to sign in" status line.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.btnLogin
 * @param {HTMLElement} deps.btnLogout
 * @param {HTMLInputElement} deps.inputOwner
 * @param {HTMLInputElement} deps.inputRepo
 * @param {HTMLElement} deps.loginStatus
 * @param {HTMLElement} deps.loginScreen
 * @param {HTMLElement} deps.loginCta
 * @param {HTMLElement} deps.loginTrust
 * @param {HTMLElement} deps.repoPicker
 * @param {HTMLElement} deps.repoPickerUser
 * @param {HTMLElement} deps.repoList
 * @param {HTMLInputElement} deps.repoSearch
 * @param {HTMLElement} deps.btnOpenRepo
 * @param {HTMLElement} deps.branchLabel
 * @param {HTMLElement} deps.btnSwitchRepo
 * @param {HTMLElement} deps.repoSwitchOverlay
 * @param {HTMLElement} deps.repoSwitchList
 * @param {HTMLInputElement} deps.repoSwitchSearch
 * @param {HTMLElement} deps.btnRepoSwitchClose
 * @param {HTMLInputElement} deps.switchInputOwner
 * @param {HTMLInputElement} deps.switchInputRepo
 * @param {HTMLElement} deps.btnSwitchOpenPath
 * @param {HTMLElement} deps.repoSwitchStatus
 * @param {(owner: string, repo: string, token: string, branch: string) => void} deps.onSignedIn
 *   Called when login completes successfully (fresh OAuth or restored session).
 *   The caller builds the app shell from the credentials.
 * @param {() => void} deps.onSignOut
 *   Called when the user clicks Sign Out.
 * @param {() => void} deps.onSessionRestoreFailed
 *   Called when a saved session could not be restored (resets demo state).
 * @param {() => boolean} deps.isDemoSession
 * @param {() => void} deps.startDemo
 * @param {(msg: string, isError: boolean) => void} deps.setSaveStatus
 * @param {() => boolean} deps.hasUnsavedDraft
 * @param {() => Promise<void>} deps.flushBeforeSwitch
 *
 * @returns {{ bootstrap: () => Promise<boolean>, setStatus: (msg: string, isError: boolean) => void }}
 *   bootstrap() returns true when this module finished the login itself (fresh
 *   OAuth or demo started — the caller must do nothing further and, to preserve
 *   current behavior, must NOT attach the visibilitychange/beforeunload
 *   listeners). Returns false when it fell through (a session was restored, or
 *   the sign-in screen is showing) — the caller attaches the lifecycle
 *   listeners in that case. setStatus() lets the caller write to the sign-in
 *   status line (used by showApp's CDN-failure path and the init() CDN guard).
 */
export function createLoginUI(deps) {
  // Shared across the picker and the switcher: the last list of repos fetched
  // for the current token. Both UIs render from this same array.
  /** @type {Array<{full_name: string, name: string, owner: string, private: boolean, description: string}>} */
  let cachedRepos = [];

  function setStatus(msg, isError) {
    deps.loginStatus.textContent = msg;
    deps.loginStatus.className = 'status ' + (isError ? 'err' : 'ok');
  }

  function readSession() {
    const token = sessionStorage.getItem('gh_token');
    const owner = sessionStorage.getItem('gh_owner');
    const repo = sessionStorage.getItem('gh_repo');
    const branch = sessionStorage.getItem('gh_branch');
    if (!token || !owner || !repo) return null;
    return { token, owner, repo, branch };
  }

  function onLoginClick() {
    // Repo is chosen AFTER OAuth — only send the user to GitHub.
    setStatus('Redirecting to GitHub...', false);
    location.href = '/auth/login';
  }

  /**
   * If we just returned from /auth/callback, the Worker appended the token to the
   * URL fragment (#gh_token=...). A fragment never goes to the server, so this is
   * a safe way to hand the token back to client-side JS. We pick it up,
   * immediately clean the address bar, and complete the same "login" that
   * onLoginClick used to do with a PAT.
   * @returns {Promise<boolean>} true when this callback finished the login itself
   *   (the app has been shown, so the caller must not build it a second time).
   */
  async function consumeOAuthRedirect() {
    const hash = location.hash || '';
    const match = hash.match(/(?:^#|&)gh_token=([^&]+)/);
    if (!match) return false;

    const token = decodeURIComponent(match[1]);
    history.replaceState(null, '', location.pathname + location.search);

    // Optional: pre-filled owner/repo from a previous "manual path" attempt
    const pendingOwner = sessionStorage.getItem('gh_pending_owner');
    const pendingRepo = sessionStorage.getItem('gh_pending_repo');
    sessionStorage.removeItem('gh_pending_owner');
    sessionStorage.removeItem('gh_pending_repo');

    sessionStorage.setItem('gh_token', token);

    if (pendingOwner && pendingRepo) {
      await finishLogin(token, pendingOwner, pendingRepo);
      return true;
    }

    // Default path: pick a repo from the authenticated account.
    await showRepoPicker(token);
    return true;
  }

  function restorePendingLoginFields() {
    const owner = sessionStorage.getItem('gh_pending_owner');
    const repo = sessionStorage.getItem('gh_pending_repo');
    if (owner) deps.inputOwner.value = owner;
    if (repo) deps.inputRepo.value = repo;
  }

  async function showRepoPicker(token) {
    setStatus('Loading your repositories…', false);
    if (deps.loginCta) deps.loginCta.classList.add('hidden');
    if (deps.loginTrust) deps.loginTrust.classList.add('hidden');
    if (deps.repoPicker) deps.repoPicker.classList.remove('hidden');

    const client = new GitHubClient({ token, owner: '', repo: '' });
    try {
      const user = await client.getAuthenticatedUser();
      if (deps.repoPickerUser) {
        deps.repoPickerUser.textContent = 'Signed in as @' + (user.login || 'user')
          + ' — pick a repository to open.';
      }
      const raw = await client.listUserRepos();
      cachedRepos = (raw || []).map((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner && r.owner.login ? r.owner.login : String(r.full_name || '').split('/')[0],
        private: !!r.private,
        description: r.description || '',
        pushed_at: r.pushed_at || '',
      }));
      renderRepoList('');
      setStatus(
        cachedRepos.length
          ? 'Select a repository to continue.'
          : 'No repositories found. Use “Open a repo by path” below, or create one on GitHub.',
        !cachedRepos.length
      );
      if (deps.repoSearch) {
        deps.repoSearch.value = '';
        deps.repoSearch.focus();
      }
    } catch (e) {
      setStatus('Could not list repositories: ' + (e && e.message ? e.message : e), true);
      // Still allow manual owner/repo entry.
      if (deps.repoPicker) deps.repoPicker.classList.remove('hidden');
    }
    setupRepoPickerOnce();
  }

  function renderRepoList(filter) {
    if (!deps.repoList) return;
    const q = String(filter || '').trim().toLowerCase();
    const items = !q
      ? cachedRepos
      : cachedRepos.filter((r) =>
          r.full_name.toLowerCase().includes(q)
          || (r.description && r.description.toLowerCase().includes(q))
        );
    deps.repoList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'repo-list-empty';
      empty.textContent = q ? 'No match for “' + filter + '”.' : 'No repositories to show.';
      deps.repoList.appendChild(empty);
      return;
    }
    for (const r of items.slice(0, 100)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'repo-list-item';
      btn.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'repo-full';
      title.textContent = r.full_name + (r.private ? ' 🔒' : '');
      btn.appendChild(title);
      if (r.description) {
        const meta = document.createElement('span');
        meta.className = 'repo-meta';
        meta.textContent = r.description;
        btn.appendChild(meta);
      }
      btn.addEventListener('click', () => {
        const token = sessionStorage.getItem('gh_token');
        if (!token) {
          setStatus('Session lost — sign in again.', true);
          return;
        }
        finishLogin(token, r.owner, r.name);
      });
      deps.repoList.appendChild(btn);
    }
  }


  function setRepoSwitchStatus(msg, isError) {
    if (!deps.repoSwitchStatus) return;
    deps.repoSwitchStatus.textContent = msg || '';
    deps.repoSwitchStatus.className = 'status' + (isError ? ' err' : msg ? ' ok' : '');
  }

  function closeRepoSwitcher() {
    if (!deps.repoSwitchOverlay) return;
    deps.repoSwitchOverlay.classList.add('hidden');
    deps.repoSwitchOverlay.setAttribute('aria-hidden', 'true');
  }

  function renderSwitchRepoList(filter) {
    if (!deps.repoSwitchList) return;
    const q = String(filter || '').trim().toLowerCase();
    const items = !q
      ? cachedRepos
      : cachedRepos.filter((r) =>
          r.full_name.toLowerCase().includes(q)
          || (r.description && r.description.toLowerCase().includes(q))
        );
    deps.repoSwitchList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'repo-list-empty';
      empty.textContent = q ? 'No match.' : 'No repositories loaded.';
      deps.repoSwitchList.appendChild(empty);
      return;
    }
    const cur = (sessionStorage.getItem('gh_owner') || '') + '/' + (sessionStorage.getItem('gh_repo') || '');
    for (const r of items.slice(0, 100)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'repo-list-item';
      const title = document.createElement('span');
      title.className = 'repo-full';
      title.textContent = r.full_name + (r.private ? ' 🔒' : '')
        + (r.full_name === cur ? ' · current' : '');
      btn.appendChild(title);
      if (r.description) {
        const meta = document.createElement('span');
        meta.className = 'repo-meta';
        meta.textContent = r.description;
        btn.appendChild(meta);
      }
      btn.addEventListener('click', () => {
        void switchRepository(r.owner, r.name);
      });
      deps.repoSwitchList.appendChild(btn);
    }
  }

  async function openRepoSwitcher() {
    if (!deps.repoSwitchOverlay) return;
    const token = sessionStorage.getItem('gh_token');
    if (!token) {
      deps.setSaveStatus('Not signed in', true);
      return;
    }
    deps.repoSwitchOverlay.classList.remove('hidden');
    deps.repoSwitchOverlay.setAttribute('aria-hidden', 'false');
    setRepoSwitchStatus('Loading repositories…', false);
    if (deps.repoSwitchSearch) deps.repoSwitchSearch.value = '';
    try {
      const client = new GitHubClient({ token, owner: '', repo: '' });
      const raw = await client.listUserRepos();
      cachedRepos = (raw || []).map((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner && r.owner.login ? r.owner.login : String(r.full_name || '').split('/')[0],
        private: !!r.private,
        description: r.description || '',
        pushed_at: r.pushed_at || '',
      }));
      renderSwitchRepoList('');
      setRepoSwitchStatus(cachedRepos.length ? '' : 'No repositories found.', !cachedRepos.length);
      if (deps.repoSwitchSearch) deps.repoSwitchSearch.focus();
    } catch (e) {
      setRepoSwitchStatus('Failed to load: ' + (e && e.message ? e.message : e), true);
    }
  }


  async function switchRepository(owner, repo) {
    const token = sessionStorage.getItem('gh_token');
    if (!token) {
      setRepoSwitchStatus('Session expired — sign in again.', true);
      return;
    }
    if (
      owner === sessionStorage.getItem('gh_owner')
      && repo === sessionStorage.getItem('gh_repo')
    ) {
      closeRepoSwitcher();
      return;
    }
    // Best-effort: push local dirty work for the current file before tearing down.
    try {
      if (deps.hasUnsavedDraft()) {
        setRepoSwitchStatus('Saving current file…', false);
        await deps.flushBeforeSwitch();
      }
    } catch (_) { /* continue switch even if save fails */ }

    setRepoSwitchStatus('Opening ' + owner + '/' + repo + '…', false);
    try {
      await finishLogin(token, owner, repo);
      closeRepoSwitcher();
    } catch (e) {
      setRepoSwitchStatus('Could not open: ' + (e && e.message ? e.message : e), true);
    }
  }

  function setupRepoSwitcher() {
    if (!deps.btnSwitchRepo || deps.btnSwitchRepo.dataset.bound) return;
    deps.btnSwitchRepo.dataset.bound = '1';
    deps.btnSwitchRepo.addEventListener('click', () => { void openRepoSwitcher(); });
    if (deps.btnRepoSwitchClose) {
      deps.btnRepoSwitchClose.addEventListener('click', closeRepoSwitcher);
    }
    if (deps.repoSwitchOverlay) {
      deps.repoSwitchOverlay.addEventListener('click', (e) => {
        if (e.target === deps.repoSwitchOverlay) closeRepoSwitcher();
      });
    }
    if (deps.repoSwitchSearch) {
      deps.repoSwitchSearch.addEventListener('input', () => {
        renderSwitchRepoList(deps.repoSwitchSearch.value);
      });
    }
    if (deps.btnSwitchOpenPath) {
      deps.btnSwitchOpenPath.addEventListener('click', () => {
        let owner = (deps.switchInputOwner && deps.switchInputOwner.value || '').trim();
        let repo = (deps.switchInputRepo && deps.switchInputRepo.value || '').trim();
        const parsed = parseGitHubOwnerRepo(owner) || parseGitHubOwnerRepo(repo);
        if (parsed) {
          owner = parsed.owner;
          repo = parsed.repo;
        }
        if (!owner || !repo) {
          setRepoSwitchStatus('Enter owner and repository.', true);
          return;
        }
        void switchRepository(owner, repo);
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && deps.repoSwitchOverlay
          && !deps.repoSwitchOverlay.classList.contains('hidden')) {
        closeRepoSwitcher();
      }
    });
  }

  function setupRepoPickerOnce() {
    if (document.documentElement.dataset.repoPickerBound) return;
    document.documentElement.dataset.repoPickerBound = '1';
    if (deps.repoSearch) {
      deps.repoSearch.addEventListener('input', () => {
        renderRepoList(deps.repoSearch.value);
      });
    }
    if (deps.btnOpenRepo) {
      deps.btnOpenRepo.addEventListener('click', onManualOpenRepo);
    }
  }

  function onManualOpenRepo() {
    let owner = (deps.inputOwner && deps.inputOwner.value || '').trim();
    let repo = (deps.inputRepo && deps.inputRepo.value || '').trim();
    const parsed = parseGitHubOwnerRepo(owner) || parseGitHubOwnerRepo(repo);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
      if (deps.inputOwner) deps.inputOwner.value = owner;
      if (deps.inputRepo) deps.inputRepo.value = repo;
    }
    if (!owner || !repo) {
      setStatus('Enter both owner and repository name.', true);
      return;
    }
    const token = sessionStorage.getItem('gh_token');
    if (!token) {
      // Not signed in yet — stash and start OAuth
      sessionStorage.setItem('gh_pending_owner', owner);
      sessionStorage.setItem('gh_pending_repo', repo);
      setStatus('Redirecting to GitHub...', false);
      location.href = '/auth/login';
      return;
    }
    finishLogin(token, owner, repo);
  }


  async function finishLogin(token, owner, repo) {
    setStatus('Checking access...', false);
    try {
      const client = new GitHubClient({ token, owner, repo });
      const repoInfo = await client.getRepoInfo();
      const branch = repoInfo.default_branch || 'main';

      sessionStorage.setItem('gh_token', token);
      sessionStorage.setItem('gh_owner', owner);
      sessionStorage.setItem('gh_repo', repo);
      sessionStorage.setItem('gh_branch', branch);

      if (deps.branchLabel) deps.branchLabel.textContent = branch;
      deps.onSignedIn(owner, repo, token, branch);
    } catch (e) {
      setStatus('Error: ' + e.message, true);
    }
  }

  /**
   * Runs the sign-in sequence at startup: wires the Sign in / Sign out buttons,
   * consumes an OAuth callback if present, restores a saved session, or leaves
   * the sign-in screen showing. Mirrors the login-related part of the old
   * init() in app.js.
   *
   * @returns {Promise<boolean>} true if a fresh OAuth callback completed or demo
   *   started (caller must do nothing further — and, preserving current
   *   behavior, must NOT attach the lifecycle listeners). false if it fell
   *   through to a restored session or the sign-in screen.
   */
  async function bootstrap() {
    // Wire login controls first. If a later step throws, the user must still be
    // able to sign in again.
    if (deps.btnLogin) deps.btnLogin.onclick = onLoginClick;
    if (deps.btnLogout) {
      deps.btnLogout.onclick = () => {
        // Defence in depth: logout reloads the page, which tears down every timer
        // anyway, but an autosave aimed at the old token should not outlive it.
        deps.onSignOut();
      };
    }
    setupRepoSwitcher();

    // NOTE (known quirk, preserved verbatim): when this returns true the caller
    // must NOT attach the visibilitychange/beforeunload listeners. In the old
    // app.js, the fresh-OAuth and demo paths early-returned from init(), so those
    // listeners were never attached in those cases — only on the session-restore
    // and sign-in-screen paths below. The app is shown in all paths, so the
    // listeners arguably *should* attach uniformly; that looks like a latent bug,
    // but extraction is behavior-preserving. Investigate separately.
    try {
      if (await consumeOAuthRedirect()) return true;
    } catch (e) {
      console.error('OAuth callback failed', e);
      setStatus('Login failed: ' + (e && e.message ? e.message : e), true);
    }

    if (deps.isDemoSession()) {
      deps.startDemo();
      return true;
    }
    const saved = readSession();
    if (saved) {
      try {
        deps.onSignedIn(saved.owner, saved.repo, saved.token, saved.branch);
      } catch (e) {
        console.error('Session restore failed', e);
        sessionStorage.removeItem('gh_token');
        try { sessionStorage.removeItem('gh_demo'); } catch (_) {}
        deps.onSessionRestoreFailed();
        sessionStorage.removeItem('gh_owner');
        sessionStorage.removeItem('gh_repo');
        setStatus('Could not restore session: ' + (e && e.message ? e.message : e) + '. Sign in again.', true);
        restorePendingLoginFields();
      }
    } else {
      const tokenOnly = sessionStorage.getItem('gh_token');
      if (tokenOnly) {
        // OAuth done, repo not chosen yet (reload mid-picker)
        void showRepoPicker(tokenOnly);
      } else {
        restorePendingLoginFields();
      }
    }
    setupRepoPickerOnce();
    setupRepoSwitcher();
    return false;
  }

  return { bootstrap, setStatus };
}
