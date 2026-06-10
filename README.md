# Starfish Notes

This was created as an alternative to Obsidian on web.

- Notes are saved as Markdown with non-invasive Preview.
- Supports LaTeX math rendering and Mermaid.js diagrams.
- App primarily made to sync to github.
- Fully compatible with .canvas and .base files and includes a fully featured editor.
- Supports links and graph view for links.
- Supports images and attachments with previews and editor for text based file formats.
- Fully client side application with offline app and note caching. Only connects to github to sync.
- Supports local-only mode without github login.
- Includes background and foreground conflict handling for remote updates and idle tab detection (5 second for idle active file and 5 minute for idle tabs).
- Supports in-file Content search. (Check sidebar)

(I've squashed many of the bugs and issues this thing had. If you find any more, raise an issue or welcome@noob31.com. This project was created partly with AI assistance (Claude Opus/Gemini.))

Demo: https://notes.noob31.com/

**Critical**: v2.0 update introduces some security and performance improvements. v2.0 is backwards compatible with pre-2.0 vaults but v1.5 will not work with v2.0 vaults. This only applies to data stored in browser and will not affect content stored in github in any way (I mean they're just files anyway).

Note: When initializing an empty repo, this app creates a .vault-compat.json file which is used to verify if the repo is known. Also it creates .gitkeep files when creating new folders to make sure it sticks. Do not delete these files from the repo.

Build and deploy:

Prod:

```
npm i
npm run build
```

Serve from `/dist`.

Dev:

```
npm i
npm run dev
```

Or you can grab a release from [Releases](https://github.com/Noob31Gen/StarfishNotes/releases/latest)

Project built using React, Vite and Tailwind CSS.

This project is AGPL-3.0 licensed.

