# eaglercraft-26.2
minecraft 26.2 in the browser
credits to o_xer

## Run locally (PWA install needs HTTP, not file://)

Double-clicking `index.html` will not work for the PWA — browsers block
service workers, `fetch()`, and the manifest on `file://` pages.

```
./serve.sh        # or: ./serve.sh 8080 for a different port
```

Then open http://localhost:8000 in Chrome — the install icon (⊕) appears in
the address bar, and the custom "Install PWA" button works.

Deployed hosting must be HTTPS (GitHub Pages qualifies) for Chrome to offer
install on a real URL.

## Live site

<https://9hetwe903u5joigdhn43h.github.io/algebratools/>

Served by GitHub Pages from the `main` branch (legacy build, site root).
Everything is referenced with relative paths, so the app also works from a
project subpath.

Notes:
- The service worker precaches the launcher shell, so the launcher opens
  offline. Client pages are cached the first time you open one (~75 MB each),
  so a client you have played once also launches offline.
- Each client load is a large download, so Pages bandwidth adds up — the
  browser caches the file after the first fetch.

## Keyboard shortcuts while a client is running

The client builds swallow key events, so `client-hotkeys.js` is injected into
each `Eagler-*.html` (see `inject-hotkeys.py`) to give the browser-level keys
back:

| Key | Action |
|---|---|
| `F11` | toggle fullscreen |
| `F5` / `Ctrl+R` | reload the client |
| `Alt+←` | back to the launcher |
| `F7` / `F6` (or the volume keys) | volume up / down |
| `F8` (or the mute key) | mute toggle |

A short hint appears in the corner for the first few seconds after a client
starts, and the volume level is shown whenever it changes.

To change the shortcuts, edit `client-hotkeys.js` and re-run:

```
./inject-hotkeys.py
```

Bump `CLIENT_CACHE` in `sw.js` when you do, so browsers pick up the new build
instead of serving the cached copy.

