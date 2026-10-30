# Regression checklist

Manual / CI guards for behaviours that have broken more than once.
Prefer automated coverage in `test/*.test.js` and `e2e_smoke_test.py` when practical.

## Autosave / Commit (hybrid)

- [ ] Typing shows `● Unsaved` and **does not** PUT to GitHub.
- [ ] After ~10s idle the status becomes `○ Local only — Save or Commit to push` and **still no** PUT.
- [ ] **Save** pushes the current file once; status `✓ Saved to GitHub`.
- [ ] Editing several files fills the **Commit** badge; Commit panel lists them; Commit/Push writes them and clears badges.
- [ ] Switching tabs or hiding the browser tab does **not** auto-push (draft stays local).
- [ ] Switching **back** to a dirty tab restores the same text, cursor and undo (no silent refetch).
- [ ] Closing a dirty tab does **not** force a GitHub commit; neighbour tab activates; draft recoverable if needed.
- [ ] Single 409 on Save is retried silently; two 409s show Reload / Overwrite.
- [ ] `beforeunload` never starts a network write (only the browser prompt when dirty).

## Editor / preview

- [ ] Source / Live / Preview layouts: Preview is full width with source hidden; Live is 50/50; Source is editor only.
- [ ] Preview follows the active tab after a switch (no stale document).
- [ ] Inline images: Space/Backspace near an image keep the caret local (no jump to end).
- [ ] Preview shows `![x](pic.png)` inside a fenced code block as code, not as an image.
- [ ] Clicking a checkbox in Preview ticks the matching line, also after a code block that contains a ```` ```js ```` line.
- [ ] Live, minimap closed: the wheel over Source moves Preview, and the wheel over Preview moves Source.
- [ ] Moving the mouse from one pane to the other while scrolling: the panes do not fight; the wheel acts on the pane under the mouse.
- [ ] Near an image the top of Preview shows the same image as the line at the top of Source; Preview glides, no jolts.
- [ ] Live, minimap open: clicking and dragging on the map moves both panes.
- [ ] External images (`https://…`, shields.io) render; GitHub Actions badge paths like `../../actions/workflows/….yml/badge.svg` resolve to `https://github.com/{owner}/{repo}/actions/...`.
- [ ] HTML files: Live/Preview show content in iframe; fullscreen stays in the current layout mode.
- [ ] Open a large HTML file (>1MB srcdoc) in Live layout on first open — must render, no toggle needed.
- [ ] Open any HTML file in Live layout before any other file — must render on first click.
- [ ] Toggle Source → Live → Source → Live rapidly on an HTML file — content must stay visible, no flicker, no blank frame.

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
- [ ] Drag-to-move updates the tree without F5: after PUT+DELETE the file leaves the source folder within ~2s, even while "updating links…" still runs on a large repo (do not wait for every .md GET to finish).
- [ ] Rename from the context menu also refreshes the tree without reload (same onMoved → loadTree rewritePath path).
- [ ] Repo switcher in the header can change owner/repo without a full re-login.
- [ ] Sign-in is GitHub-first; repo picker after OAuth (no mandatory owner/repo before login).
- [ ] No PWA manifest / standalone (OAuth + sessionStorage isolation); responsive CSS remains.
- [ ] Moving a folder created in the editor (it holds an empty `.gitkeep`) works - no "Empty contents" error.
- [ ] Moving or renaming a note does not change links or images inside fenced code blocks.
- [ ] Moving a note leaves `` `[a](b.md)` `` (inline code) unchanged, but still updates ``[`b.md`](b.md)``.

## Search / backlinks / history

- [ ] Search replaces the tree with hits; clear restores the tree.
- [ ] Backlinks panel lists notes that link to the current file.
- [ ] History panel toggles open/closed; does not leave a stuck open state after Escape.
- [ ] Search results start right under the search box (no empty gap above them).
- [ ] A search shows the result count above the hits; "50 of N results" when the list is capped.
- [ ] A `# comment` inside a code block does not become the note title in search results.
- [ ] History: Restore of an empty file version (e.g. `.gitkeep`) loads an empty file - no "Empty blob" error.

## PDF / export

- [ ] PDF export produces non-blank pages; images not split incorrectly across pages when covered by e2e.

## After any change that touches autosave, tabs, or Commit

```bash
npm test
python e2e_smoke_test.py   # python3 on macOS/Linux
```
