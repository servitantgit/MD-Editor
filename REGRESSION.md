# Regression checklist

Manual / CI guards for behaviours that have broken more than once.
Prefer automated coverage in `test/*.test.js` and `e2e_smoke_test.py` when practical.

## Autosave / Commit (hybrid)

- [ ] Typing shows `● Unsaved` and **does not** PUT to GitHub.
- [ ] After ~10s idle the status becomes `○ Local only — Save or Commit to push` and **still no** PUT.
- [ ] **Save** pushes the current file once; status `✓ Saved to GitHub`.
- [ ] Editing several files fills the **Commit** badge; Commit panel lists them; Commit/Push writes them and clears badges.
- [ ] Commit two edited notes: one GitHub commit contains both exact texts; dots and badge clear. After more than 10s idle and reload, no phantom draft banner appears.
- [ ] Type more while Commit is pending: GitHub gets the sent snapshot; newer text keeps its dot, badge and recovery draft. The next Commit saves those remaining changes.
- [ ] Commit a background/closed note with newer local text: its recovery draft keeps that text on the newly committed blob SHA; a closed tab is not recreated.
- [ ] A failed Commit keeps local edits, drafts and the message. A lost response may still mean GitHub updated: check History before retrying.
- [ ] Switching tabs or hiding the browser tab does **not** auto-push (draft stays local).
- [ ] Switching **back** to a dirty tab restores the same text, cursor and undo (no silent refetch).
- [ ] Closing a dirty tab does **not** force a GitHub commit; neighbour tab activates; draft recoverable if needed.
- [ ] Single 409 on Save is retried silently; two 409s show Reload / Overwrite.
- [ ] `beforeunload` never starts a network write (only the browser prompt when dirty).

## Editor / preview

- [ ] Wrap toggles visual long-line wrapping without adding line breaks to the file or changing text undo history.
- [ ] Fold collapses heading sections; the next click expands them. Text and text undo history remain unchanged.
- [ ] Find selects the exact match inside a folded section and unfolds the section hiding it, without editing text.

- [ ] Source / Live / Preview layouts: Preview is full width with source hidden; Live is 50/50; Source is editor only.
- [ ] Preview follows the active tab after a switch (no stale document).
- [ ] Inline images: Space/Backspace near an image keep the caret local (no jump to end).
- [ ] Preview shows `![x](pic.png)` inside a fenced code block as code, not as an image.
- [ ] Clicking a checkbox in Preview ticks the matching line, also after a code block that contains a ```` ```js ```` line.
- [ ] A checkbox below a code block inside a quote (`> ~~~`) ticks its own line, not a line inside the code.
- [ ] Outline does not list a `# comment` from a code block.
- [ ] Source: `![x](pic.png)` inside a code block or inline code stays plain editable text, no link widget.
- [ ] Preview shows `` `![x](pic.png)` `` in inline code as code, not as raw HTML.
- [ ] Live, minimap closed: the wheel over Source moves Preview, and the wheel over Preview moves Source.
- [ ] Moving the mouse from one pane to the other while scrolling: the panes do not fight; the wheel acts on the pane under the mouse.
- [ ] Near an image the top of Preview shows the same image as the line at the top of Source; Preview glides, no jolts.
- [ ] Live, minimap open: clicking and dragging on the map moves both panes.
- [ ] Live, many images above the caret: typing does not make Preview flicker and does not move Source.
- [ ] Typing `[[` and a few letters lists notes; Up/Down, Enter or Tab inserts `[name](/path)`, Esc closes; Enter outside the list still continues `- ` lists.
- [ ] Selecting a word and pasting a URL makes `[word](url)`; Ctrl+Z gives back the word in one step; without a selection or inside code it is a normal paste; pasting a screenshot still uploads it.
- [ ] Ctrl+V of a screenshot into a note commits one image into the Asset folder and inserts `![name](relative link)` at the cursor; the picture shows in Preview at once.
- [ ] Dragging an image file from the desktop onto the editor text (CodeMirror itself, not only the empty area) uploads it; a non-image file in the same drop is skipped.
- [ ] Copying cells from Excel or a sentence from Word and pasting into a note inserts text, not an image.
- [ ] Preview: dragging the resize handle of an image changes only that image; on release the Source line becomes `<img src="..." alt="..." width="N">`; Ctrl+Z undoes it in one step.
- [ ] Source image menu: Move up/down move the whole line (disabled on the first/last line); Cut, Copy and Delete from text act on the image only; Escape or a click outside closes it.
- [ ] Open image from the menu on a picture pasted a moment ago opens it in a new tab.
- [ ] Discard is enabled only with unsaved changes; it asks first, restores the GitHub version and clears the dot and the Commit badge; Cancel changes nothing.
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
- [ ] Renaming, moving (drag) or deleting a folder makes exactly ONE commit in the GitHub history (`Rename folder X to Y` / `Delete folder X`); links into the folder are updated in that same commit.
- [ ] A folder dragged from the desktop onto a folder row lands inside that folder in ONE commit (`Upload folder X`); onto the root strip it lands in the root. Empty files are uploaded; `.git`, `Thumbs.db` and `desktop.ini` are skipped.
- [ ] Dropping a folder whose paths already exist (any letter case) writes nothing and names the conflict; dragging folders inside the tree still moves them.
- [ ] Renaming a note updates `[[Old name]]` (only if no other note has that name) and `[[Folder/Old name|alias]]` in other notes; moving it updates `[[Folder/Name]]` and leaves `[[Name]]` as it is.

## Search / backlinks / history

- [ ] Search replaces the tree with hits; clear restores the tree.
- [ ] The clear (x) button inside Search appears for any non-empty value and hides when empty; click, Enter on the button, or Escape in the field clears the field and results, restores the tree and keeps focus in Search.
- [ ] Clearing Search keeps Find, document and minimap highlights and local edits. On a phone the button stays inside the field; Escape there also closes the files drawer (existing behaviour).
- [ ] Search result: all located tokens are highlighted; longest original token is selected first; next/previous and current/total work.
- [ ] Prefix/fuzzy results highlight actual matched tokens. Search-mode Replace/All are disabled; editing Find enables literal replacement.
- [ ] Search from Preview switches to saved Source. Reopening an edited result preserves local text and undo history.
- [ ] Editing/Undo refreshes matches without navigation; closing Find or switching documents clears owned highlights and map ticks.
- [ ] Map opened after Search shows ticks; the current tick remains visible on dense rows. Tick painting does not scroll panes.
- [ ] Live sync works both ways with Find active and Map open, and after closing Find/Map. Typing with images does not restore placeholders or collapse Preview.
- [ ] Backlinks panel lists notes that link to the current file.
- [ ] Backlinks also lists notes in OTHER folders that use `[[Folder/Note]]` or `[[Note]]`.
- [ ] History panel toggles open/closed; does not leave a stuck open state after Escape.
- [ ] History: selected commit shows the correct filename and added/removed lines.
- [ ] Restore: Cancel leaves the open text and local changes untouched.
- [ ] Restore B while A is open: B gets the selected historical version as local changes; A remains unchanged and nothing is pushed.
- [ ] Switch B/A/B after Restore, then reload: the recovery banner and Keep local preserve the restored text. Wait for file opening to complete before checking text.
- [ ] Search results start right under the search box (no empty gap above them).
- [ ] A search shows the result count above the hits; "50 of N results" when the list is capped.
- [ ] A `# comment` inside a code block does not become the note title in search results.
- [ ] After the index rebuild, words that appear only inside code blocks (also inside quotes) are not found by search.
- [ ] History: Restore of an empty file version (e.g. `.gitkeep`) loads an empty file - no "Empty blob" error.

## PDF / export

- [ ] PDF export produces non-blank pages; images not split incorrectly across pages when covered by e2e.

## After any change that touches autosave, tabs, or Commit

```bash
npm test
python e2e_smoke_test.py   # python3 on macOS/Linux
```
