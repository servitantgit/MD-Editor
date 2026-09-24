# Reprose is a Markdown editor for GitHub

[Demo](https://reprose.pp.ua)

When I need to edit a Markdown document on GitHub, I want to use a beautiful editor that seamlessly handles front-matter fields and supports image uploads. That’s why I started developing my own Markdown editor for GitHub.

The current version of the editor is a functional Proof of Concept (PoC). It can display a list of Markdown files from your GitHub repository, allowing you to edit them through a basic Markdown editor.

Ideally, I want to add image uploads and an editing experience similar to GitBook.

The editor can be deployed on GitHub Pages or Cloudflare Pages. The latter is preferable since the app uses a simple Cloudflare function for GitHub authentication. If you figure out how to host it elsewhere, please let me know by opening an issue.

The original idea for the editor was inspired by the Prose.io editor. I don’t use Prose.io because its image uploader is broken, and its code is based on BackboneJS, which is outdated. I built Reprose with Jekyll and AlpineJS—both are incredibly simple, making it easy for any developer to understand the codebase. 😉

**Screenshot of Finder:**

![Reprose editor page](https://github.com/jmas/reprose/blob/main/.assets/reprose-finder-screenshot.png?raw=true)

**Screenshot of Editor:**

![Reprose editor page](https://github.com/jmas/reprose/blob/main/.assets/reprose-editor-screenshot.png?raw=true)

**Features:**

- [x] Browse markdown files via Finder
- [x] Open markdown files in Editor
- [x] Create a new markdown file
- [x] Preview editing markdown file in split view
- [x] Editor buttons that insert popular markdown markup
- [x] View and edit Front-matter markup
- [x] Add into repository configuration file [`.reprosers.yaml`](https://github.com/jmas/dev-blog/blob/main/.reproserc.yaml) that describe Front-matter fields and values for them
- [x] Setup next types of Front-matter fields: `text`, `multiline`, `select`, `multiselect`, `datetime`
- [x] Delete file from repository

Thanks for using this wonderful editor. :)
