# algebratools

A small launcher page that lists the web apps in `clients/` and runs them as
an installed PWA.

## Run locally

PWA install needs HTTP, not `file://` — browsers block service workers,
`fetch()` and the manifest on `file://` pages.

```
./serve.sh        # or: ./serve.sh 8080 for a different port
```

Then open `http://localhost:8000` in Chrome.

Deployed hosting must be HTTPS for Chrome to offer install on a real URL.

## How it works

- `index.html` — the launcher UI: the folder tree, the client list, the
  details modal, the downloads panel, PWA install handling.
- `clients/` — the client builds, in folders. `clients/index.json` is the
  generated catalog the launcher reads.
- `sw.js` — service worker: precaches the launcher shell, serves the
  catalog, injects the shim into the clients it serves, and keeps the
  offline copies the user asked for.
- `client-shim.js` — injected into every app page as it is served.
- `manifest.json`, `icons/` — PWA manifest and icons.

### The client catalog

Clients live in `clients/`, grouped in folders:

```
clients/
  index.json              <- generated, do not edit by hand
  eagler/
    _group.json           <- optional: label, icon, order
    26.2-dev-0.6.html     <- the build
    26.2-dev-0.6.json     <- optional: name, version, description, author, icon
```

Folders can be nested as deep as you like — the sidebar tree follows the
folder structure, and the client list groups by the next folder down.

`_group.json` sets the name and icon of a folder:

```json
{ "label": "Eaglercraft", "icon": "icons/icon-192.png", "order": 1 }
```

The sidecar next to a build sets what the card shows:

```json
{
  "name": "Eaglercraft 26.2 Dev 0.6",
  "version": "26.2 Dev 0.6",
  "description": "Minecraft 26.2 in the browser",
  "author": "o_xer"
}
```

Anything left out is filled in from the file name, so a build without a
sidecar still shows up — it just gets a generic name.

### The default client

```
./build-index.py --default recomended/26.2-dev-0.6   # set it
./build-index.py --default none                       # clear it
```

That writes `clients/_default.json` and the id goes into the catalog as
`defaultClient`. It opens selected when the launcher loads.

The launcher also remembers a default per browser (`localStorage`), and that
one wins over the catalog's — so a client you pick with **Set default** in
the details modal stays your default. The catalog default is what a fresh
browser gets.

### Adding a client

```
./add-client.py Eagler-26.2-Dev-0.6.html \
    --group eagler \
    --name "Eaglercraft 26.2 Dev 0.6" \
    --version "26.2 Dev 0.6" \
    --description "Minecraft 26.2 in the browser" \
    --author "o_xer"
```

That copies the build into `clients/<group>/`, writes the sidecar and
rebuilds the catalog. The client is in the launcher straight away — **no
cache bump needed**, the service worker refreshes the catalog in the
background and the launcher picks it up on the next visit (or within a
minute if it is already open).

Options: `--slug` for the file name, `--icon` for the card icon, `--move`
to move the build instead of copying it, `--force` to overwrite an existing
entry, `--default` to make it the default client.

### The catalog scripts

| Script | What it does |
|---|---|
| `./build-index.py` | Injects the shim into every build and writes `clients/index.json` |
| `./build-index.py --check` | Reports whether the catalog is out of date |
| `./build-index.py --no-inject` | Writes the catalog without touching the builds |
| `./build-index.py --default <id>` | Sets the client that opens selected |
| `./inject-shim.py` | Injects the shim into every build under `clients/` |
| `./inject-shim.py --check` | Reports which builds are out of date |
| `./add-client.py` | Adds a build to the catalog in one step |

The shim injection is idempotent: the block is marked with
`<!--launcher-shim-->` and replaced, not appended, every time. A build
without a `<head>` tag is skipped and reported — it never stops the other
builds from being updated.

### The GitHub workflow

`.github/workflows/rebuild-catalog.yml` runs `./build-index.py` on every
push to `main` and commits the result, so nobody has to remember to run it
by hand. Push a build with its sidecar and the catalog catches up.

- The commit it makes carries `[skip ci]`, so it does not start the
  workflow all over again.
- The `generated` timestamp in the catalog only moves when the content
  really changes, so a push that touches nothing in `clients/` leaves the
  file alone and the workflow has nothing to commit.
- On a pull request the workflow does not commit — it fails when the
  catalog is out of date, so the reviewer knows it has to be regenerated.

The workflow pushes to the branch it was triggered on, so `main` has to
allow pushes from GitHub Actions (Settings → Actions → General → Workflow
permissions, and the branch protection rules if you have any).

### The shim

`client-shim.js` is injected by the service worker while it serves an app
page, so the app files themselves stay untouched and every entry gets the fix
automatically. It is also written into the builds by `inject-shim.py`, so it
is in place even when there is no controlling worker (a stale worker, an
offline copy, or a file opened directly). It runs before the app's own
scripts and does three things:

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

The launcher shell is precached, so it opens without a network. The client
catalog is refreshed in the background whenever it is fetched, so a newly
added client shows up without bumping a cache name.

The client builds are **not** cached automatically any more — they are ~75 MB
each, and caching every client you ever open fills the disk. Use the
download button on a client card to keep a copy, and the **Downloads** button
next to the settings gear to see what is on disk and remove it. The oldest
copy is dropped automatically when the offline budget (`OFFLINE_BUDGET` in
`sw.js`, 2 GB) is exceeded.

## How many clients fit?

GitHub Pages limits a published site to **1 GB**, and a build is ~75 MB, so
about **13 clients** fit on Pages. The catalog and the UI have no such
limit — they scale to hundreds of entries — but the builds themselves do.

When you outgrow that, the builds have to move off Pages. Keep them on the
same origin as the launcher: the service worker only injects the shim into
same-origin pages (`sw.js` ignores everything else), and only same-origin
builds can be kept for offline play. A reverse proxy in front of both is the
simplest way to do that.

credits to o_xer
