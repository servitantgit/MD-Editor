# Regression checklist

Short manual pass after UI/editor changes. Automated coverage: `npm test` + `python e2e_smoke_test.py`.

## Auth & shell
- [ ] Start screen shows project info + GitHub repo link
- [ ] Sign in (Cloudflare OAuth) or local session works
- [ ] Header: repo label, branch pill, Source / Live / Preview, History, Commit, Sign out

## Files sidebar
- [ ] Tree loads; expand/collapse folders
- [ ] Active folder path shown under **Files**; **+ Add** → New file / New folder in that folder
- [ ] Drop strip targets **active folder** (not only root)
- [ ] Search finds notes; clear restores tree
- [ ] Context menus: file (new here / rename / delete), folder (new file/folder / rename / delete)

## Editor layouts
- [ ] **Source** — single editor pane
- [ ] **Live** — source + preview side by side, preview has content
- [ ] **Preview** — preview full width (source hidden), not empty
- [ ] Switching layouts does not lose text or caret
- [ ] Flip **Live ↔ Preview several times quickly**: preview stays filled every time (no alternating empty pane) and the `.html` iframe does NOT flash/reload 2-3× (content unchanged → zero reloads)

## File types
- [ ] Open `.md` — markdown toolbar, Live/Preview render headings/lists
- [ ] Open `.html` — Live shows iframe; relative images/CSS resolve when possible
- [ ] `.html` in **Preview** layout: iframe content present (CodeMirror hidden there — the old jump/render paths silently targeted it)
- [ ] Click relative `<a href="other.md">` inside **HTML** Live preview opens that file
- [ ] Click relative link in **markdown** preview opens that file
- [ ] Open `.js` / `.css` — source mode + code preview; md-only toolbar actions disabled

## Tabs & drafts
- [ ] Open two files → two tabs; switch restores text / scroll
- [ ] Dirty dot on unsaved tab; Save / idle clears it
- [ ] Reload with local draft → banner Keep / Discard
- [ ] 409 once → silent retry; twice → Reload / Overwrite banner

## Save vs Commit
- [ ] **Save** — single-file push; removes that path from Commit badge
- [ ] **Commit** drawer — lists local changes; toggle closes; History mutually exclusive
- [ ] Pre-commit diff + History restore still work

## Find / Map / Outline
- [ ] Find / Replace (Ctrl+F / Ctrl+H)
- [ ] Wrap, Fold headings
- [ ] Outline: click jumps in **Source AND Live AND Preview** — in Preview the preview pane itself must scroll (CodeMirror is hidden there)
- [ ] Outline: jump to a heading inside a folded section unfolds it first
- [ ] Outline refreshes while typing; active heading (above the cursor) highlighted; `#` lines inside ``` fences are NOT listed, `C#` keeps its `#`
- [ ] **Map** minimap: full document scale, click/drag scrolls, persists preference

## Images & PDF
- [ ] Inline images in Source; Space/Backspace near image does not jump to EOF
- [ ] Preview images load (data URLs)
- [ ] PDF export for `.md` and `.html` produces non-empty file

## Automated
```bash
npm test
# with serve.mjs on :8080:
python e2e_smoke_test.py
```
