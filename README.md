# algebratools

A small launcher page that lists the web apps in `clients.json` and runs them
as an installed PWA.

## Run locally

PWA install needs HTTP, not `file://` — browsers block service workers,
`fetch()` and the manifest on `file://` pages.

```
./serve.sh        # or: ./serve.sh 8080 for a different port
```

Then open `http://localhost:8000` in Chrome.

Deployed hosting must be HTTPS for Chrome to offer install on a real URL.

## How it works

- `index.html` — the launcher UI, PWA install handling.
- `clients.json` — the list of apps it can launch.
- `sw.js` — service worker: precaches the launcher shell, caches app pages on
  demand so they launch offline, and injects the shim below.
- `client-shim.js` — injected into every app page as it is served.
- `manifest.json`, `icons/` — PWA manifest and icons.

### The shim

`client-shim.js` is injected by the service worker while it serves an app
page, so the app files themselves stay untouched and every entry gets the fix
automatically. It runs before the app's own scripts and does three things:

1. **Blocks the keyboard lock.** Some builds call `navigator.keyboard.lock()`
   to grab the keyboard exclusively. While that lock is held the browser stops
   handling system shortcuts for the page — Ctrl+Shift+Q, Ctrl+W, Ctrl+Tab,
   and on ChromeOS even brightness, volume and power — which makes the
   machine feel frozen. The shim lets the call succeed but never actually
   locks, so app keys keep working and the system stays responsive.
   `navigator.keyboard.getLayoutMap()` is left alone, so non-QWERTY layouts
   still map key positions correctly.

   The one exception is a scoped Escape lock (`navigator.keyboard.lock(
   ['Escape'])`), which the shim lets through. While fullscreen that lock
   means the page sees Escape: a single tap opens the in-game pause menu
   without leaving fullscreen, and holding Escape for about 0.6 s leaves
   fullscreen for good. A tap does nothing else, so an accidental Esc no
   longer fights the browser.

2. **Turns element fullscreen into window fullscreen.** A build that puts its
   own wrapper div into element fullscreen does not resize the layout
   viewport: the canvas keeps its old pixel size and renders stretched, and
   the window's own fullscreen (F11, the keyboard's fullscreen key) stops
   working. The shim redirects the request to the document element, so the
   viewport really resizes, the app re-lays out, and F11 / Escape toggle
   fullscreen cleanly.

   The client also enters fullscreen on its own on the first click or key
   press, without a keybind.

3. **Maps the hardware Back key to the launcher** and makes F5 reload the app.

### Keybinds

The client has keybinds for the panel actions. They are stored in
`localStorage` under `eaglercraft.launcher.keybinds`, which the launcher and
the client share, and the launcher's settings panel (gear button) has a field
for each one:

| Action | Default |
|---|---|
| Fullscreen on | `Alt+]` |
| Fullscreen off | `Alt+[` |
| Back to the launcher | `Alt+\` |
| Toggle the debug readout | `Alt+`` |

Combinations are normalised, so `ctrl+shift+l` is stored as `Ctrl+Shift+L`.

The service worker injects the shim into the client page as it is served, so
a change to `client-shim.js` reaches the clients without re-downloading them.
Bump `CACHE_NAME` in `sw.js` when `client-shim.js` changes, so the new shim
replaces the precached copy (and the worker picks it up straight away).

## Offline

The launcher shell is precached, so it opens without a network. App pages are
cached the first time you open one, so anything you have already run also
launches offline.

credits to o_xer
