# WalkPlay PEQ (Parametric Equalizer) — offline, for hidws integration.

This repository is a self-contained, offline copy of the [WalkPlay PEQ web app](https://peq.szwalkplay.com/) (`https://peq.szwalkplay.com/`) wrapped in a [Vite](https://vitejs.dev/) project so it can be run locally and deployed to **GitHub Pages**. It optionally allows [`hidws`](https://github.com/Ircama/hidws) WebSocket backend integration, so that the DAC device can be physically connected to a Linux system other than locally. (Through the *hidws* Linux HID/WebSocket gateway, the Linux system communicates with the browser via WebSocket.)

The app lets you control a WalkPlay audio device (parametric equalizer, DAC filters, firmware version, etc.) directly in the browser. The portal itself no longer requires a WalkPlay account. Logging in to https://peq.szwalkplay.com/ is optional, to populate the configuration of the "EQ Effect" parameters with online data (DEF, CUSTOM, ONLINE, SHARE).

Tested device: TTGK Technology Hi-MAX Audio dongle featuring a CB1200AU DAC (including a +/-10dB 8-band equalizer).

## Getting started

```bash
npm install        # install the Vite toolchain
npm run dev        # start the dev server
```

Then open **http://localhost:5173/walkplay/**.

## Build

```bash
npm run build      # outputs a static site in dist/
npm run preview    # serve the production build locally
```

The `dist/` folder is a fully static site that can be hosted anywhere.

## Remote hidws backend + HID log

[`public/hidws.js`](public/hidws.js) adds an optional **Remote** connection mode that talks to a [`hidws`](https://github.com/Ircama/hidws) WebSocket backend instead of (or in addition to) WebHID.

A **"hidws"** button and a **"Log"** button are present into the dashboard top bar, between the app's **Connect** button and the round user avatar:

- **hidws** — toggles the remote-connection panel:
  - **Mode toggle** — `Local (WebHID)` (the browser's own WebHID, used by the app's "Connect" button) or `Remote (hidws)`.
  - The app's **Connect** button reflects the active mode (`Connect local` / `Connect remote`).
  - In **Remote** mode: backend URL (default `ws://localhost:9001`), **List devices**, a device selector and status.
  - **Connect via hidws** — performs the whole remote connection (list → open) and hands the device to the app. When Remote mode is active, communication is forwarded over the WebSocket.
- **Log** — opens a modal with the **HID interaction log**: timestamped TX/RX reports captured from **both** local (WebHID) and remote (hidws) sessions, with Clear / Copy / Close actions.

The connection mode and backend URL persist in `localStorage` (`walkplay_conn_mode`, `walkplay_remote_url`).

## Notes

- **No login / no portal account**: the dashboard opens without login. The user (avatar) button allows optional login. The selected language is saved locally.
- **WebHID**: a WebHID-capable browser (Chrome / Edge / Opera) and a connected WalkPlay device are required for local device control.
- **hidws**: run the `hidws` daemon on a machine that has the device plugged in, then connect from the app via `ws://host:9001` (or `wss://`). Because GitHub Pages is HTTPS, a plain `ws://` LAN backend might be blocked by the browser as mixed content — use `ws://localhost:9001` (backend on this PC) or expose hidws over `wss://`, or open the app from `http://localhost` instead.

## License

The original WalkPlay web application and its assets are © their respective owners. This repository only vendors them for offline testing / study purposes; do not redistribute commercially.
