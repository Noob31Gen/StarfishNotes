# Starfish Notes

This was created as an alternative to Obsidian on web.

- Notes are saved as Markdown.
- App primarily made to sync to github.
- Fully compatible with .canvas and .base files and includes a detailed editor
- Supports links and graph view for links.
- Supports images and attachments with previews and editor for text based file formats.
- Fully client side application with offline app and note caching. Only connects to github to sync.
- Supports local-only mode without github login.
- Includes background and foreground conflict handling for remote updates and idle tab detection.

(I am aware of many of the bugs and am attempting to fix it. This project was created partly with AI assistance (Claude Opus/Gemini.))

Demo: https://notes.noob31.com/

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

Project built using React, Vite and Tailwind CSS.

This project is AGPL-3.0 licensed.

