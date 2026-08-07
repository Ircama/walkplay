# WalkPlay PEQ (Parametric Equalizer) — offline Vite build

This repository is a self-contained, offline copy of the [WalkPlay PEQ web app](https://peq.szwalkplay.com/) (`https://peq.szwalkplay.com/`) wrapped in a **Vite** project so it can be run locally in VS Code and deployed to **GitHub Pages**.

The app lets you control a WalkPlay audio device (parametric equalizer, DAC filters, firmware upgrade, etc.) directly in the browser. **A real WalkPlay device connected over USB / WebHID is required to use most functions** — plus a WalkPlay account (the app talks to the official `www.szwalkplay.com/api` backend for login / presets).

## Stack

- [Vite](https://vitejs.dev/) (project scaffold and build)
- The application itself is the **prebuilt production bundle** extracted from `peq.szwalkplay.com` (single 2 MB bundle, CSS, images and icons are vendored under `public/`).

## Getting started

```bash
npm install        # install the Vite toolchain
npm run dev        # start the dev server
```

Then open **http://localhost:5173/walkplay/** (the base path mirrors the production URL `https://ircama.github.io/walkplay/`).

## Build

```bash
npm run build      # outputs a static site in dist/
npm run preview    # serve the production build locally
```

The `dist/` folder is a fully static site that can be hosted anywhere.

## Deploy to GitHub Pages

Pushing to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which runs `npm ci && npm run build` and publishes `dist/` via GitHub Pages (`https://ircama.github.io/walkplay/`).

To enable it:

1. Go to **Settings → Pages** of the repository.
2. Under *Build and deployment → Source* select **GitHub Actions**.
3. Push to `main` (or run the workflow manually via *Actions*).

## How the offline copy was made

The production site is a single-page app (Vite build), so a simple "Save As" of `index.html` is **not enough**. The complete set of assets was fetched from `https://peq.szwalkplay.com/`:

| Directory          | Contents                                             |
| ------------------ | ---------------------------------------------------- |
| `public/assets/`   | main bundle `index-BEOfvcHi.js` + CSS + logo images  |
| `public/static/`   | product / filter / icon images                       |
| `public/favicon.ico` | site favicon                                       |

The prebuilt bundle expects to be served from a domain root, but this project is deployed under `/walkplay/`. Three surgical patches were applied to the vendored files so every URL resolves under that base:

1. **Vue Router base** — `createWebHistory()` is called with no argument, so the minified bundle's `normalizeBase` falls back to the `<base href>` tag / `/`. The bundle is patched so the router base is `"/walkplay/"` (in `public/assets/index-BEOfvcHi.js`).
2. **Asset literals** — every quoted `/static/...` and `/assets/...` string is rewritten to `/walkplay/static/...` / `/walkplay/assets/...` (in `public/assets/index-BEOfvcHi.js` and `public/assets/index-DhADvLvz.css`).
3. **`index.html`** references the scripts at the root-absolute paths; Vite applies the `/walkplay/` base at build time.

> If the repository is renamed (or deployed to a custom domain), the base path `/walkplay/` must be updated in **four places**: `vite.config.js`, `public/assets/index-BEOfvcHi.js` (the two patches above) and the generated `dist/404.html` / `index.html`.

`dist/404.html` is an SPA fallback generated from the built `index.html` by the `spa404` plugin in `vite.config.js`, so GitHub Pages serves the app for deep links instead of a 404.

## Remote hidws backend

[`public/hidws.js`](public/hidws.js) adds an optional **Remote** connection mode that talks to a [`hidws`](https://github.com/Ircama/hidws) WebSocket backend instead of (or in addition to) WebHID — the same transport used by kt02h20-control / Audiocular-Aura / fiiocontrol.

A floating **hidws** control panel is added to the page:

- **Mode toggle** — `Local (WebHID)` (the browser's own WebHID, used by the app's "Connect" button) or `Remote (hidws)`.
- In **Remote** mode: backend URL (default `ws://localhost:9001`), **List devices**, a device selector and status.
- **Connect via hidws** — performs the whole remote connection (list → open) and hands the device to the app. When Remote mode is active, `navigator.hid` is proxied so the app's own "Connect" flow also routes through the hidws backend; `requestDevice()`, `getDevices()`, `open()`, `sendReport()`, `sendFeatureReport()` and `inputreport` events are all forwarded over the WebSocket.

The connection mode and backend URL persist in `localStorage` (`walkplay_conn_mode`, `walkplay_remote_url`).

## Notes

- **No WalkPlay backend**: the original app talks to `www.szwalkplay.com/api` endpoints (login, presets, etc.). Those calls go to the official backend; if unreachable they will fail gracefully. Local-device (WebHID / hidws) features do not depend on them.
- **WebHID**: a WebHID-capable browser (Chrome / Edge / Opera) and a connected WalkPlay device are required for local device control.
- **hidws**: run the `hidws` daemon on a machine that has the device plugged in, then connect from the app via `ws://host:9001` (or `wss://`). Because GitHub Pages is HTTPS, a plain `ws://` LAN backend is blocked by the browser as mixed content — use `ws://localhost:9001` (backend on this PC) or expose hidws over `wss://`, or open the app from `http://localhost` instead.

## License

The original WalkPlay web application and its assets are © their respective owners. This repository only vendors them for offline testing / study purposes; do not redistribute commercially.
