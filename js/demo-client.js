// demo-client.js
// In-memory GitHubClient stand-in for "Try demo" on the landing page.
// No network. Git-only features (real History from GitHub, OAuth, private repos)
// are unavailable — the UI shows a demo banner and disabled controls.

import { utf8ToB64, b64ToUtf8 } from './github-client.js';

function shaOf(text) {
  // Stable-enough pseudo-sha for demo (not cryptographic).
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'demo' + (h >>> 0).toString(16).padStart(8, '0');
}

const SEED = {
  'Welcome.md': `# Welcome to MD Editor

MD Editor is a browser workspace for Markdown, HTML and code stored in any GitHub repository — no clone, no build step. This demo is a local sandbox with the same editor, preview, tabs and search you get with a real repo.

## What to try

- Layouts: read [[/Getting-started/01-layouts]] in **Source**, then switch to **Live** and **Preview** in the header.
- Shortcuts: [[/Getting-started/02-keyboard-shortcuts]] lists every shortcut — try \`Ctrl+K\`, \`Ctrl+F\`, \`Ctrl+H\`.
- Tabs and drafts: [[/Getting-started/03-tabs-and-autosave]] explains multi-tab editing and crash recovery.
- Markdown: [[/Showcase/typography]], [[/Showcase/code-blocks]], [[/Showcase/tables-and-lists]] and [[/Showcase/images-and-media]].
- Knowledge base: start at [[/Knowledge-base/index]] — wikilinks, backlinks and the Outline panel.
- Real docs: [[/Technical-docs/api-reference]] and [[/Technical-docs/architecture]].
- Code and HTML preview: [[/Code-examples/snippets.js]] and [[/Code-examples/landing-page.html]].
- Edge cases: [[/Stress-tests/unicode-everything]] and [[/Stress-tests/deep-nesting]].

## Demo limits

**Commit** and **History** are disabled in demo mode — **Sign in** with GitHub to use them with your own repo. Nothing here leaves your browser: saving writes into an in-memory store, drafts stay in this tab.

> Click any file in the sidebar to explore. Start with [[/Getting-started/01-layouts]].
`,
  'Getting-started/01-layouts.md': `# Layouts: Source, Live, Preview

MD Editor has three layouts, switched with the buttons in the header. Your choice is remembered in this browser. Read this file, then toggle modes while reading it — the text stays, only the presentation changes.

| Mode | Layout | Best for |
|------|--------|----------|
| **Source** | Editor only | Writing, markdown syntax, code files |
| **Live** | Editor + preview side by side | Checking formatting as you type |
| **Preview** | Preview full width | Reading, following [[/wikilinks\|wikilinks]], reviewing images |

Try it now:

1. Stay in **Source** and edit this line.
2. Switch to **Live** — the preview follows your cursor.
3. Switch to **Preview** and click a wikilink such as [[/Welcome]] to navigate.

Notes:

- Preview renders Markdown with tables, task lists, code highlighting and images.
- HTML files (see [[/Code-examples/landing-page.html]]) render in a sandboxed iframe instead.
- Code files show a language badge and highlighted preview.

Next: [[/Getting-started/02-keyboard-shortcuts]] and [[/Getting-started/03-tabs-and-autosave]].
`,
  'Getting-started/02-keyboard-shortcuts.md': `# Keyboard shortcuts

These work in the editor on desktop. \`Ctrl\` means \`Cmd\` on macOS.

| Shortcut | Action |
|----------|--------|
| \`Ctrl+K\` | Focus the sidebar search (full-text over all files) |
| \`Ctrl+F\` | Open Find, focus the find box (\`Enter\` = next match) |
| \`Ctrl+H\` | Open Find, focus the Replace box |
| \`F11\` | Toggle fullscreen editor |
| \`Escape\` | Close context menu, panel or dialog |
| \`Enter\` (in Find) | Jump to the next match |

The Find bar also has **Replace** (current match) and **Replace all** buttons, plus previous/next arrows.

Related: [[/Getting-started/01-layouts]] for layout modes, [[/Getting-started/03-tabs-and-autosave]] for how drafts survive anything — including closing the tab.
`,
  'Getting-started/03-tabs-and-autosave.md': `# Tabs and autosave

Open several files — each gets a tab with its own undo history, cursor and scroll position. Switching tabs never loses your place.

## How saving works

1. Type anywhere. Within 400 ms your text is drafted locally (IndexedDB) — the status reads **Local only**.
2. Stay idle 10 seconds and the draft is checkpointed again. Idle never pushes to GitHub.
3. Press **Save** (or **Commit** for several files) to write to the repository.

## Try it

1. Type a line here, then open [[/Showcase/typography]].
2. Come back — your line, cursor and undo history are intact.
3. Reload the browser tab: the draft banner offers your unsaved text back.

## Conflicts

If a file changed remotely, the first save retries silently with the fresh version. Only a second conflict in a row asks you to **Reload from GitHub** or **Overwrite**.

In this demo, Save writes into the in-memory sandbox instead of GitHub. **Commit** and **History** need a real sign-in.
`,
  'Showcase/typography.md': `# Typography showcase

A markdown cheat sheet with real prose. Toggle **Live** to see each element render.

# Heading 1 — the document title
## Heading 2 — sections
### Heading 3 — subsections
#### Heading 4 — details
##### Heading 5 — fine print
###### Heading 6 — the smallest

**Bold** and *italic* and ***both***, plus ~~strikethrough~~ and \`inline code\`.

> A wise editor shows its work.
>
> > Nested quotes still render — useful for replies and citations.

Links: [MD Editor repo](https://github.com/servitantgit/MD-Editor), [Welcome](../Welcome.md), and wikilinks like [[/Knowledge-base/index]].

---

A horizontal rule sits above. Below: a real paragraph with an em dash — and "curly quotes" the way published text looks.

- Back to [[/Welcome]] when you are done skimming.
`,
  'Showcase/code-blocks.md': `# Code blocks in many languages

Each fence names its language so highlight.js can colour it. All samples are real, runnable snippets.

\`\`\`js
// Debounce: run fn only after calls stop for ms
export function debounce(fn, ms = 200) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
\`\`\`

\`\`\`python
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

print(list(fibonacci(8)))
\`\`\`

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "== $f"
  wc -w "$f"
done
\`\`\`

\`\`\`sql
SELECT author, COUNT(*) AS notes
FROM notes
WHERE archived = 0
GROUP BY author
ORDER BY notes DESC
LIMIT 10;
\`\`\`

\`\`\`yaml
index:
  language: en
  fields: [path, title]
  persist: indexeddb
\`\`\`

\`\`\`json
{ "editor": "md-editor", "autosave": { "debounceMs": 400, "idleMs": 10000 } }
\`\`\`

More highlight demos live in [[/Code-examples/snippets.js]].
`,
  'Showcase/tables-and-lists.md': `# Tables and lists

## Alignment table

| Left | Center | Right |
|:-----|:------:|------:|
| apples | 12 | $3.40 |
| bread | 2 | $5.10 |
| cheese | 1 | $8.99 |

## Task list

- [x] Open the demo
- [x] Switch to Live preview
- [ ] Open [[/Knowledge-base/index]]
- [ ] Export this page to PDF

## Nested bullets

- Fruit
  - Citrus
    - Lemon for [[/Knowledge-base/recipes/pancakes|pancakes]]
    - Orange
  - Berries
    - Blueberry
    - Raspberry
- Baking
  1. Mix dry ingredients
  2. Fold in wet ingredients
     - Do not overmix
     - Rest the batter 5 minutes
  3. Cook and serve

See also [[/Showcase/typography]] for the rest of the syntax.
`,
  'Showcase/images-and-media.md': `# Images and media

Images render inline in **Live** and **Preview**. Hover one in preview to drag-resize it — the width is written back into the markdown.

Small diagram from the asset folder:

![Demo diagram](../assets/demo-note.svg)

A wider illustration used across the docs:

![Architecture overview](../assets/architecture.svg)

Recipe photo (SVG illustration):

![Pancake stack](../assets/pancakes.svg)

Tips:

- Paths are relative to the file: \`../assets/...\` climbs out of \`Showcase/\`.
- Root-absolute paths (\`/assets/...\`) work too.
- Broken paths show a warning card with the reason instead of failing silently.

Related: [[/Knowledge-base/recipes/pancakes]] embeds the same pancake art in a real recipe.
`,
  'Knowledge-base/index.md': `# Knowledge base

A tiny personal wiki inside the demo. Every entry links to the others, so the **Backlinks** panel always has something to show.

## Concepts

- [[/Knowledge-base/concepts/backlinks]] — how reverse links work, with live examples.
- [[/Knowledge-base/concepts/outline-navigation]] — a long essay with 15+ headings for the Outline panel.
- [[/Knowledge-base/concepts/wikilinks]] — every wikilink form, raw and rendered.

## Recipes

- [[/Knowledge-base/recipes/pancakes|Classic pancakes]] — fluffy weekend pancakes.
- [[/Knowledge-base/recipes/pasta-carbonara|Pasta carbonara]] — Rome's three-ingredient classic.
- [[/Knowledge-base/recipes/sourdough-bread|Sourdough bread]] — a slow weekend loaf.

Start with [[/Knowledge-base/concepts/wikilinks]] to learn the syntax, then open [[/Knowledge-base/recipes/pancakes]] and check its Backlinks.
`,
  'Knowledge-base/concepts/backlinks.md': `# Backlinks

A backlink answers "who links here?" Open [[/Knowledge-base/recipes/pancakes]] and look at the Backlinks panel — this file will be listed, because this paragraph mentions [[/Knowledge-base/recipes/pancakes|it]].

More edges for the graph:

- [[/Knowledge-base/concepts/wikilinks]] defines the syntax this page relies on.
- [[/Knowledge-base/concepts/outline-navigation]] is long enough to need the Outline panel.
- [[/Knowledge-base/recipes/pasta-carbonara]] and [[/Knowledge-base/recipes/sourdough-bread]] link back here from their "See also" sections.
- The hub [[/Knowledge-base/index]] links to everything.

Rename or delete a file and the index rebuilds — stale links disappear, live ones stay. That is the whole trick: forward links are parsed from bodies, the panel just inverts them.
`,
  'Knowledge-base/concepts/wikilinks.md': `# Wikilinks

Wikilinks are the fastest way to connect notes. Raw syntax on the left, what it means on the right.

\`\`\`md
[[/Welcome]]
[[/Knowledge-base/index]]
[[/Knowledge-base/recipes/pancakes|Classic pancakes]]
\`\`\`

Rendered:

- [[/Welcome]]
- [[/Knowledge-base/index]]
- [[/Knowledge-base/recipes/pancakes|Classic pancakes]]

Rules:

- With or without \`.md\` — both resolve.
- Basename works when it is unique: [[/Knowledge-base/recipes/pancakes]] finds the recipe.
- After a pipe comes the display text: [[/Knowledge-base/concepts/outline-navigation|the long essay]].

Broken targets are not an error: the link renders, clicking it reports "Link target not found", and the Backlinks panel ignores it. Try the hub [[/Knowledge-base/index]] next.
`,
  'Knowledge-base/concepts/outline-navigation.md': `# Notes that survive: a field guide to personal knowledge management

Open the **Outline** panel (toolbar) — this essay has headings at four levels, so you can jump around it.

## Why write notes at all

Memory is lossy and search is cheap, but neither replaces understanding. A note is a decision about what mattered — one idea, in your own words, with a link to where it came from.

### The three kinds of notes

#### Fleeting notes

Quick captures: a quote, a link, a half-thought. Cheap to write, safe to delete. Most of [[/Knowledge-base/index|the hub]] started this way.

#### Literature notes

Summaries of something you read — this essay's sources, [[/Technical-docs/architecture|an architecture doc]], a recipe you actually cooked like [[/Knowledge-base/recipes/pancakes|pancakes]].

#### Permanent notes

One idea per note, written so a stranger could understand it. These are the only notes worth linking.

### What "permanent" really means

Not long — *self-contained*. If it needs its neighbours to make sense, split it. See [[/Knowledge-base/concepts/wikilinks|wikilink syntax]] for how small notes connect.

## The Zettelkasten method

A slip-box of atomic notes joined by links. No folders required — the structure emerges from [[/Knowledge-base/concepts/backlinks|backlinks]].

### Atomicity

One claim per card. "Sourdough needs time" beats a ten-page bread diary; the diary can link to [[/Knowledge-base/recipes/sourdough-bread|the recipe]] instead.

### Branching, not hierarchy

Hierarchies rot. Links compose: pancakes link to [[/Knowledge-base/recipes/pasta-carbonara|carbonara]] through "weeknight dinners", carbonara links back through "egg technique".

### Folgezettel and modern tools

Numbered branches were the paper era's backlinks. Digital tools invert the index for free — that is what the Backlinks panel does.

## Capturing without friction

### Inbox first, organize later

Every idea lands in one inbox. Weekly, each item is deleted, done, or rewritten as a permanent note.

### Progressive summarization

Read once, bold the essentials, highlight the best, compress into a summary. Four passes, each shorter than the last.

## Retrieval beats storage

### Search is the entry point

Full-text search (\`Ctrl+K\` here) finds words; links find *meaning*. Start at [[/Knowledge-base/index]] and follow backlinks outward.

### Maps of content

Hub notes curate a topic. They rot slower than folders because every entry earns its place with context.

## Maintenance rituals

### Weekly review

1. Empty the inbox.
2. Fix broken links (click every [[/Welcome|hub link]] once a month).
3. Merge duplicates — two notes on pancakes become one.

### Yearly compost

Archive what no longer interests you. Deleting is a feature: a smaller vault is a smarter vault.

## Start small

Create one note today — a recipe, a quote, a bug you fixed. Link it to [[/Knowledge-base/index]] and to one other note. That is the whole method.
`,
  'Knowledge-base/recipes/pancakes.md': `# Classic pancakes

Fluffy weekend pancakes. Makes about 12 — serves 4.

![Pancake stack](../../assets/pancakes.svg)

| Prep | Cook | Servings |
|------|------|----------|
| 10 min | 15 min | 4 |

## Ingredients

- 250 g flour, 2 tbsp sugar, 2 tsp baking powder, 1/2 tsp soda, 1/2 tsp salt
- 2 eggs, 480 ml buttermilk, 60 g melted butter
- Maple syrup and berries to serve

## Steps

1. Whisk dry ingredients in a large bowl.
2. Beat eggs with buttermilk and butter; pour into dry and stir until just combined.
3. Rest 5 minutes; heat a buttered skillet over medium.
4. Ladle batter, flip when bubbles hold, about 2 minutes per side.
5. Serve warm with syrup.

## See also

- [[/Knowledge-base/recipes/pasta-carbonara|Pasta carbonara]] for a savoury follow-up.
- [[/Knowledge-base/recipes/sourdough-bread|Sourdough bread]] for a slower project.
- Back to [[/Knowledge-base/index|the knowledge base]].
`,
  'Knowledge-base/recipes/pasta-carbonara.md': `# Pasta carbonara

Rome's classic: guanciale, pecorino, eggs. No cream — the sauce is an emulsion.

| Prep | Cook | Servings |
|------|------|----------|
| 5 min | 15 min | 2 |

## Ingredients

- 200 g spaghetti, 100 g guanciale in strips
- 2 eggs + 1 yolk, at room temperature
- 50 g Pecorino Romano, grated, plus more to serve
- Black pepper; salt for the pasta water

## Steps

1. Boil pasta in lightly salted water; reserve a cup of pasta water.
2. Crisp the guanciale 6-8 minutes; take off the heat.
3. Whisk eggs, yolk, cheese and pepper into a paste.
4. Toss pasta through the fat, stir in the paste with hot pasta water until glossy.
5. Serve at once with extra cheese.

## See also

- [[/Knowledge-base/recipes/pancakes|Classic pancakes]] for the sweet counterpart.
- [[/Knowledge-base/recipes/sourdough-bread|Sourdough bread]] for dinner.
- How links find this page: [[/Knowledge-base/concepts/backlinks|backlinks explained]].
`,
  'Knowledge-base/recipes/sourdough-bread.md': `# Sourdough bread

A slow weekend loaf. Assumes a ripe starter.

| Prep | Bake | Yield |
|------|------|-------|
| 30 min + overnight | 45 min | 1 loaf |

## Ingredients

- 500 g bread flour, 375 g water, 100 g ripe starter, 10 g salt

## Steps

1. Mix flour and water; rest 1 hour. Add starter and salt.
2. Bulk ferment 4-5 hours with 4 sets of stretch-and-folds.
3. Shape into a boule; refrigerate overnight in a floured basket.
4. Bake covered at 230 C for 20 min, uncovered 20-25 more.
5. Cool 1 hour before slicing.

## See also

- [[/Knowledge-base/recipes/pancakes|Classic pancakes]] for something faster.
- [[/Knowledge-base/concepts/outline-navigation|Slow notes, slow bread]].
`,
  'assets/pancakes.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
  <rect width="320" height="180" rx="12" fill="#1c2128"/>
  <ellipse cx="160" cy="130" rx="110" ry="26" fill="#8a5a2b"/>
  <ellipse cx="160" cy="112" rx="100" ry="24" fill="#c98a4b"/>
  <ellipse cx="160" cy="96" rx="90" ry="22" fill="#e0aa6e"/>
  <rect x="140" y="46" width="40" height="26" rx="4" fill="#f2c14e"/>
  <circle cx="160" cy="42" r="10" fill="#d64545"/>
  <text x="160" y="168" text-anchor="middle" fill="#9aa4b2" font-family="sans-serif" font-size="13">pancakes.svg — weekend stack</text>
</svg>`,
  'assets/architecture.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180">
  <rect width="480" height="180" rx="12" fill="#0d1117"/>
  <g font-family="sans-serif" font-size="13" text-anchor="middle">
    <rect x="16" y="60" width="120" height="60" rx="8" fill="#12233a" stroke="#58a6ff"/>
    <text x="76" y="86" fill="#e6edf3">Browser</text>
    <text x="76" y="104" fill="#9aa4b2">editor + preview</text>
    <rect x="180" y="60" width="120" height="60" rx="8" fill="#1a2b1d" stroke="#3fb950"/>
    <text x="240" y="86" fill="#e6edf3">CDN</text>
    <text x="240" y="104" fill="#9aa4b2">static assets</text>
    <rect x="344" y="60" width="120" height="60" rx="8" fill="#2b1d2a" stroke="#d2a8ff"/>
    <text x="404" y="86" fill="#e6edf3">GitHub API</text>
    <text x="404" y="104" fill="#9aa4b2">contents + git data</text>
    <line x1="136" y1="90" x2="180" y2="90" stroke="#58a6ff" stroke-width="2" marker-end="url(#a)"/>
    <line x1="300" y1="90" x2="344" y2="90" stroke="#3fb950" stroke-width="2"/>
  </g>
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#58a6ff" stroke-width="1.5"/></marker></defs>
</svg>`,
  'Technical-docs/api-reference.md': `# Notes API reference

A realistic REST reference for a hypothetical notes backend. Try **Preview** — tables and JSON fences render cleanly.

Base URL: \`https://api.notes.example/v1\`. Auth: \`Authorization: Bearer <token>\`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/notes\` | List notes (paginated) |
| POST | \`/notes\` | Create a note |
| GET | \`/notes/{id}\` | Fetch one note |
| PATCH | \`/notes/{id}\` | Update title or body |
| DELETE | \`/notes/{id}\` | Archive a note |

## Create a note

\`\`\`bash
curl -X POST https://api.notes.example/v1/notes \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Pancakes","tags":["recipes"]}'
\`\`\`

\`\`\`json
{
  "id": "n_9f2",
  "title": "Pancakes",
  "tags": ["recipes"],
  "updatedAt": "2026-10-10T09:00:00Z"
}
\`\`\`

## Error codes

| Status | Meaning | Retry? |
|--------|---------|--------|
| 400 | Validation failed | No — fix the body |
| 401 | Missing or bad token | No — re-authenticate |
| 404 | Note not found | No |
| 409 | Version conflict | Yes — refetch, then retry |
| 429 | Rate limited | Yes — respect Retry-After |

See [[/Technical-docs/architecture]] for how a client like MD Editor talks to an API like this.
`,
  'Technical-docs/architecture.md': `# Architecture: browser-first editor

MD Editor is static hosting plus API calls — no server of its own. The diagram below doubles as an image demo:

![System diagram](../assets/architecture.svg)

## Request flow (ASCII)

\`\`\`text
+----------------+      +----------------+      +----------------+
|    Browser     |----->|      CDN       |----->|   GitHub API   |
| editor+preview |      | static assets  |      | contents+git   |
+----------------+      +----------------+      +----------------+
        |                                                |
        +---------------- IndexedDB ---------------------+
              drafts, search index, tabs (local only)
\`\`\`

## Why this shape

- **No backend to operate.** Pages serves files; GitHub stores truth.
- **Offline-tolerant drafts.** Keystrokes persist locally in 400 ms; the network is only touched on Save/Commit.
- **Cache-busted reads.** Tree fetches carry a unique query param instead of a custom header (CORS-safe).

Related: [[/Technical-docs/api-reference]] shows the API style this client consumes; [[/Getting-started/03-tabs-and-autosave]] explains the local-first saving.
`,
  'Code-examples/snippets.js': `// Useful JS utilities — open in Source, check the language badge + preview.
'use strict';

/** Run fn only after calls stop for ms. */
export function debounce(fn, ms = 200) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Run fn at most once per ms. */
export function throttle(fn, ms = 200) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

/** Deep clone for JSON-safe values. */
export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Fetch with a timeout (AbortController). */
export async function fetchWithTimeout(url, ms = 8000, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Group array items by key. */
export function groupBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

console.log('snippets loaded:', typeof debounce, typeof fetchWithTimeout);
`,
  'Code-examples/styles.css': `/* Demo stylesheet: variables, grid, flex, responsive. */
:root {
  --bg: #0d1117;
  --fg: #e6edf3;
  --accent: #58a6ff;
  --radius: 12px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--bg);
  color: var(--fg);
}

.hero {
  display: grid;
  gap: 1rem;
  padding: 3rem 1.5rem;
  text-align: center;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1rem 1.5rem;
}

.card {
  flex: 1 1 220px;
  border: 1px solid #30363d;
  border-radius: var(--radius);
  padding: 1rem;
}

.card h3 { margin-top: 0; color: var(--accent); }

@media (max-width: 640px) {
  .hero { padding: 2rem 1rem; }
  .cards { flex-direction: column; }
}
`,
  'Code-examples/config.json': `{
  "name": "demo-site",
  "version": "1.4.0",
  "build": {
    "entry": "src/index.js",
    "outDir": "dist",
    "sourcemaps": true,
    "targets": ["es2020", "chrome90", "firefox88"]
  },
  "preview": {
    "port": 8080,
    "open": true,
    "headers": {
      "X-Frame-Options": "SAMEORIGIN"
    }
  },
  "markdown": {
    "gfm": true,
    "highlight": "highlight.js",
    "anchors": true
  },
  "plugins": [
    { "name": "toc", "options": { "depth": 4 } },
    { "name": "footnotes", "options": {} },
    { "name": "image-resize", "options": { "maxWidth": 1200 } }
  ]
}
`,
  'Code-examples/landing-page.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acme Notes — demo landing</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e6edf3; }
    .hero { padding: 64px 24px; text-align: center; background: #161b22; }
    .hero h1 { margin: 0 0 12px; font-size: 40px; }
    .hero p { color: #9aa4b2; max-width: 560px; margin: 0 auto 24px; }
    .btn { display: inline-block; padding: 12px 28px; border-radius: 8px; background: #238636; color: #fff; text-decoration: none; }
    .cards { display: flex; gap: 16px; padding: 32px 24px; max-width: 900px; margin: 0 auto; flex-wrap: wrap; }
    .card { flex: 1 1 220px; border: 1px solid #30363d; border-radius: 12px; padding: 20px; }
    footer { text-align: center; color: #9aa4b2; padding: 24px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Acme Notes</h1>
    <p>Markdown notes with backlinks, search and preview — rendered live by MD Editor.</p>
    <a class="btn" href="#" onclick="document.getElementById('count').textContent = 'Clicked!'; return false;">Try it</a>
    <p id="count">Not clicked yet.</p>
  </div>
  <div class="cards">
    <div class="card"><h3>Wikilinks</h3><p>Connect notes with double brackets.</p></div>
    <div class="card"><h3>Backlinks</h3><p>See who links here, instantly.</p></div>
    <div class="card"><h3>Preview</h3><p>Source, Live and full Preview.</p></div>
  </div>
  <footer>Demo page — open in Live or Preview mode.</footer>
</body>
</html>
`,
  'Stress-tests/unicode-everything.md': `# Unicode stress test

If every line below renders and saves byte-identical, UTF-8 works end to end.

Emoji: the party popper, rocket, check mark, warning sign and coffee cup should all render as color glyphs.

Cyrillic: Привіт, світе! Як справи? Що нового?

Chinese: 你好世界！这是一个演示。谢谢你的访问。

Arabic: مرحبا بالعالم! كيف حاлк؟ شكرا لك.

Math: ∑ ∫ √ π ≠ ≤ ≥ ± × ∞ ∴ ∵ — plus a != b and x <= pi in plain text.

Quotes and dashes: "double", ‘single’, «guillemets», em dash — and en dash –.

Accents: café naïve résumé Zürich São Paulo Łódź Kraków Reykjavík Malmö Ångström.

Back to [[/Welcome]].
`,
  'Stress-tests/deep-nesting.md': `# Deep nesting stress test

All six heading levels in sequence, then lists nested ten deep.

# H1 — top
## H2 — section
### H3 — subsection
#### H4 — detail
##### H5 — fine print
###### H6 — smallest

## Ten levels of bullets

- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5
          - Level 6
            - Level 7
              - Level 8
                - Level 9
                  - Level 10 — if the Outline and preview survive this, they survive anything

## Mixed lists

1. First
   - bullet under numbered
   - another bullet
2. Second
   1. numbered under numbered
   2. still going

## Quote with a table inside

> | A | B |
> |---|---|
> | 1 | 2 |

Back to [[/Welcome]].
`,
  'Notes/Sample note.md': `# Sample note (legacy demo file)

This file is kept so old demo links do not break. The good stuff moved:

- Start at [[/Welcome]]
- Browse [[/Knowledge-base/index]]
- Try [[/Showcase/images-and-media]] (the diagram now lives there too)

![Demo diagram](../assets/demo-note.svg)
`,
  'assets/demo-note.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80">
  <rect width="320" height="80" rx="8" fill="#21262d"/>
  <text x="160" y="48" text-anchor="middle" fill="#58a6ff" font-family="sans-serif" font-size="18">Demo image</text>
</svg>`,
  'examples/hello.js': `// Demo JavaScript file — try Source mode + language badge
export function greet(name = 'world') {
  return \`Hello, \${name}\`;
}

console.log(greet('MD Editor'));
`,
  'examples/page.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Demo page</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6edf3; padding: 2rem; }
    h1 { color: #58a6ff; }
  </style>
</head>
<body>
  <h1>Demo HTML</h1>
  <p>Open this file and switch to <strong>Live</strong> or <strong>Preview</strong>.</p>
</body>
</html>
`,
};

export class DemoClient {
  constructor() {
    this.owner = 'demo';
    this.repo = 'sandbox';
    this.token = 'demo';
    /** @type {Map<string, { text: string, sha: string }>} */
    this._files = new Map();
    for (const [path, text] of Object.entries(SEED)) {
      this._files.set(path, { text, sha: shaOf(text) });
    }
    this._commits = [];
  }

  async getRepoInfo() {
    return {
      name: this.repo,
      full_name: `${this.owner}/${this.repo}`,
      default_branch: 'main',
      private: false,
      description: 'Local demo sandbox (not a real GitHub repository)',
    };
  }

  async getTree(_branch) {
    return [...this._files.keys()]
      .sort()
      .map((path) => ({
        path,
        type: 'blob',
        sha: this._files.get(path).sha,
        mode: '100644',
      }));
  }

  async getFileB64(path) {
    const f = this._files.get(path);
    if (!f) {
      const err = new Error(`Not Found (${path})`);
      err.status = 404;
      throw err;
    }
    return { b64: utf8ToB64(f.text), sha: f.sha };
  }

  async getFileAsDataUrl(path) {
    const { b64 } = await this.getFileB64(path);
    const mime = path.endsWith('.svg')
      ? 'image/svg+xml'
      : path.endsWith('.png')
        ? 'image/png'
        : 'application/octet-stream';
    return `data:${mime};base64,${b64}`;
  }

  async putFile(path, contentB64, message, sha) {
    const existing = this._files.get(path);
    if (sha && existing && existing.sha !== sha) {
      const err = new Error('Conflict (demo sha mismatch)');
      err.status = 409;
      throw err;
    }
    const text = b64ToUtf8(contentB64);
    const newSha = shaOf(text + '|' + Date.now());
    this._files.set(path, { text, sha: newSha });
    this._commits.unshift({
      sha: newSha,
      commit: {
        message: message || `Update ${path}`,
        author: { name: 'Demo', date: new Date().toISOString() },
      },
      path,
    });
    return { content: { sha: newSha, path }, commit: { sha: newSha, message } };
  }

  async deleteFile(path, sha, _message) {
    const existing = this._files.get(path);
    if (!existing) {
      const err = new Error(`Not Found (${path})`);
      err.status = 404;
      throw err;
    }
    if (sha && existing.sha !== sha) {
      const err = new Error('Conflict');
      err.status = 409;
      throw err;
    }
    this._files.delete(path);
    return { commit: { sha: shaOf('del' + path) } };
  }

  async getBlobB64(sha) {
    for (const f of this._files.values()) {
      if (f.sha === sha) return { b64: utf8ToB64(f.text), sha, encoding: 'base64' };
    }
    for (const c of this._commits) {
      if (c.sha === sha && c.path && this._files.has(c.path)) {
        const f = this._files.get(c.path);
        return { b64: utf8ToB64(f.text), sha, encoding: 'base64' };
      }
    }
    const err = new Error(`Blob not found (${sha})`);
    err.status = 404;
    throw err;
  }

  async commitFiles(branch, message, files) {
    for (const f of files) {
      if (f.contentB64 === null) this._files.delete(f.path);
      else await this.putFile(f.path, f.contentB64, message, null);
    }
    const sha = shaOf(message + Date.now());
    this._commits.unshift({
      sha,
      commit: {
        message,
        author: { name: 'Demo', date: new Date().toISOString() },
      },
    });
    return { sha, branch };
  }

  async listCommits({ path, perPage = 30 } = {}) {
    let list = this._commits;
    if (path) list = list.filter((c) => !c.path || c.path === path);
    return list.slice(0, perPage).map((c) => ({
      sha: c.sha,
      commit: c.commit,
      html_url: '#demo',
    }));
  }

  async getCommitDetail(sha) {
    const c = this._commits.find((x) => x.sha === sha);
    if (!c) {
      const err = new Error('Commit not found');
      err.status = 404;
      throw err;
    }
    return {
      sha: c.sha,
      commit: c.commit,
      files: c.path
        ? [{ filename: c.path, status: 'modified', patch: '' }]
        : [],
    };
  }

  async getAuthenticatedUser() {
    return { login: 'demo', name: 'Demo User', avatar_url: '' };
  }

  async listUserRepos() {
    return [{
      full_name: 'demo/sandbox',
      name: 'sandbox',
      owner: { login: 'demo' },
      private: false,
      description: 'Local demo only',
    }];
  }
}

export function isDemoSession() {
  try {
    return sessionStorage.getItem('gh_demo') === '1';
  } catch (_) {
    return false;
  }
}
