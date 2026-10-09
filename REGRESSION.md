# Regression checklist

Manual / CI guards for behaviours that have broken more than once.
Prefer automated coverage in `test/*.test.js` and `e2e_smoke_test.py` when practical.

## Autosave / Commit (hybrid)

- [ ] Typing shows `● Unsaved` and **does not** PUT to GitHub.
- [ ] After ~10s idle the status becomes `○ Local only — Save or Commit to push` and **still no** PUT.
- [ ] **Save** pushes the current file once; status `✓ Saved to GitHub`.
- [ ] Editing several files fills the **Commit** badge; Commit panel lists them; Commit/Push writes them and clears badges.
- [ ] Switching tabs or hiding the browser tab does **not** auto-push (draft stays local).
- [ ] Closing a dirty tab does **not** force a GitHub commit; neighbour tab activates; draft recoverable if needed.
- [ ] Single 409 on Save is retried silently; two 409s show Reload / Overwrite.
- [ ] `beforeunload` never starts a network write (only the browser prompt when dirty).

## Editor / preview

- [ ] Source / Live / Preview layouts: Preview is full width with source hidden; Live is 50/50; Source is editor only.
- [ ] Preview follows the active tab after a switch (no stale document).
- [ ] Inline images: Space/Backspace near an image keep the caret local (no jump to end).
- [ ] External images (`https://…`, shields.io) render; GitHub Actions badge paths like `../../actions/workflows/….yml/badge.svg` resolve to `https://github.com/{owner}/{repo}/actions/...`.
- [ ] HTML files: Live/Preview show content in iframe; fullscreen stays in the current layout mode.
- [ ] CodeMirror **material-darker** theme; caret remains light (`#e6edf3`).

## Toolbar / chrome

- [ ] Toolbar groups: meta (lang) | Find Wrap Fold | Outline Backlinks Map | **PDF** | Save Delete (separators between groups).
- [ ] Filename is **not** duplicated in the toolbar (tabs own the name).
- [ ] Mobile: formatting toolbar collapsed by default; Save/Delete icon-only where designed.
- [ ] Landscape mobile: editor still scrolls (no chrome eating the whole viewport).

## Files / tree / auth

- [ ] New file allows non-`.md` extensions (html, js, css, …) with sensible defaults.
- [ ] Create file/folder targets the **selected** folder, not a stale click path.
- [ ] Drop-to-move uses the active folder path (including non-root).
- [ ] Repo switcher in the header can change owner/repo without a full re-login.
- [ ] Sign-in is GitHub-first; repo picker after OAuth (no mandatory owner/repo before login).
- [ ] No PWA manifest / standalone (OAuth + sessionStorage isolation); responsive CSS remains.

## Search / backlinks / history

- [ ] Search replaces the tree with hits; clear restores the tree.
- [ ] Backlinks panel lists notes that link to the current file.
- [ ] History panel toggles open/closed; does not leave a stuck open state after Escape.

## PDF / export

- [ ] PDF export produces non-blank pages; images not split incorrectly across pages when covered by e2e.

## After any change that touches autosave, tabs, or Commit

```bash
npm test
python3 e2e_smoke_test.py
```
