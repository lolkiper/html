# YouTube Zaliver — Ultra Edition

An ultra-premium desktop application UI for the YouTube Zaliver upload automation
suite. Built with React, TypeScript, Tailwind CSS, Framer Motion and Electron.

## Design language

- Deep black background with soft dark-purple gradients and glassmorphism panels.
- Rounded 18–24px corners, soft shadows and premium spacing throughout.
- Two accent themes that smoothly cross-fade in ~450ms whenever the upload mode
  is switched:
  - **Single Upload** → Neon Purple `#8B5CF6`
  - **Multi Upload (up to 10 videos)** → Neon Green `#00FF88`
- Every accent-driven surface (sidebar highlights, active tabs, borders, glows,
  hover states, progress/chart colors) animates in lockstep with the toggle.

## Pages

- **Dashboard** — Live stat cards (Videos, Accounts, Channels, Successful /
  Failed Uploads, Uploading) plus a terminal-style upload console with
  `Slot 1…Slot 10` tabs, color-coded log levels, and Pause / Clear Logs /
  Auto Scroll controls.
- **AutoLogin** — Dolphin Anty automation settings (token, local/cloud API
  URLs, 2FA site, delay between accounts, skip-already-successful) plus an
  `accounts.txt` editor and large glowing Start/Stop actions.
- **Accounts** — Sortable browser-profile table with status badges and
  add/delete actions.
- **Titles** — Line-numbered title editor with Import TXT, Shuffle and Clear.
- **Statistics** — Channel analytics table with a circular success-rate gauge.
- **Settings** — General preferences, automation defaults and an accent-theme
  preview.

## Getting started

```bash
npm install

# Web-only preview (browser)
npm run dev

# Full desktop app (Electron + Vite dev server)
npm run electron:dev

# Production build (static site)
npm run build

# Production desktop installer (electron-builder)
npm run electron:build
```

## Project structure

```
src/
  assets/          Static assets (app logo)
  components/
    layout/        Sidebar, TopBar, TitleBar, AppShell
    ui/            Reusable glass UI primitives (buttons, cards, badges, ...)
  context/         ThemeContext (accent animation) & FarmContext (mock upload engine)
  data/            Mock data used to drive the demo UI
  pages/           One file per sidebar destination
electron/
  main.cjs         Frameless BrowserWindow + IPC window controls
  preload.cjs      Context-isolated bridge exposed as `window.zaliver`
```

The upload engine in `FarmContext` is a self-contained simulation so the UI is
fully interactive out of the box; wire it up to the real Dolphin/YouTube
automation backend by replacing the `tick()` logic with IPC calls into your
existing automation scripts.
