# CodeMirror 6 experiment (opt-in only)

## Rule

**Classic EasyMDE on the normal site must not change.** CM6 is opened only by an explicit URL.

## How to open

| URL | Result |
|-----|--------|
| `/` or any URL **without** `editor=cm6` | Classic (production) |
| `/?editor=cm6` | Experimental CM6 text editor |
| `/cm6.html` | Redirects to `/?editor=cm6` |

Banner at the top links back to **Classic** (`./`).

There is **no** `localStorage` engine flag — a normal bookmark cannot stick on CM6.

## What works on CM6 (phase 1)

- Open markdown / text files, type, tabs, drafts/autosave wiring via the same handle shape

## What does **not** (yet)

- Live / Preview parity with EasyMDE  
- Minimap, scroll-sync, link-suggest, find UI, image widgets  

Source / Live / Preview buttons still exist; Live/Preview are not ported on CM6.

## Git workflow

```bash
git checkout -b experiment/cm6
# add these files, push branch
git push -u origin experiment/cm6
```

Use a **Cloudflare Pages preview** for that branch, or merge only after Classic smoke-check on `/`.

Do not treat CM6 as default on `main` until Live/Preview parity exists.
