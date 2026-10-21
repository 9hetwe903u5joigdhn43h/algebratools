/* Eaglercraft Launcher Service Worker
 *
 * Provides offline support:
 *   - Precaches the shell (index.html, manifest, icons, client list)
 *   - Claims all clients immediately so the SW takes control on first load
 *   - Serves the launcher shell NETWORK-FIRST (launcher updates are picked up
 *     on the next load; cache is only used offline)
 *   - Caches client HTML files on demand so installed apps support offline play
 */

// Bump this whenever the launcher shell changes. Bumping purges every old
// launcher cache during activation, so no stale shell can survive.
const CACHE_NAME = "eaglercraft-launcher-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./clients.json",
  "./client-shim.js",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-192.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

// Client HTML files are cached on demand (they are large wasm bundles).
// Do NOT rename this when bumping CACHE_NAME: renaming would force a
// ~75 MB client re-download for nothing. Bump it when a client build itself
// changes, or when the injected shim changes, so browsers pick up the new
// copy instead of serving the cached one.
const CLIENT_CACHE = "eaglercraft-clients-v3";

// Launcher shell URLs (resolved against this SW's scope). Navigations to
// these are served network-first; every other navigation is cache-first.
const SHELL_PATHS = ["./", "./index.html"].map(
  (p) => new URL(p, self.registration.scope).pathname
);

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== CLIENT_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// Client shim injection
//
// The client builds grab the keyboard exclusively (navigator.keyboard.lock)
// and use element fullscreen, which together make system shortcuts and
// window fullscreen unusable. The shim in client-shim.js fixes that. It is
// injected here as the client page is served, so the (75 MB) client files
// themselves stay untouched and every client gets the fix automatically.
// ---------------------------------------------------------------------------
const SHIM_PATH = "./client-shim.js";
let shimPromise = null;

// Wrap the shim source in a script tag so the browser executes it.
function wrapShim(source) {
  if (!source) return "";
  return "<script>\n" + source.replace(/<\/script/gi, "<\\/script") + "\n</script>\n";
}

function getShimHtml() {
  if (!shimPromise) {
    shimPromise = (async () => {
      const url = new URL(SHIM_PATH, self.registration.scope).href;
      // Network first: a service worker's own fetches do not re-enter its
      // fetch handler, so this goes straight to the server and picks up an
      // updated shim. Offline, fall back to the precached copy.
      try {
        const fresh = await fetch(url, { cache: "no-cache" });
        if (fresh.ok) return wrapShim(await fresh.text());
      } catch (err) { /* offline — use the cached copy */ }
      try {
        const cached = await caches.match(url);
        if (cached) return wrapShim(await cached.text());
      } catch (err) { /* no shim available */ }
      return "";
    })();
  }
  return shimPromise;
}

// Insert the shim right after <head> so it runs before the game's scripts.
// Streams the body through, so the 75 MB page is never held in memory.
function injectShim(response, shimHtml) {
  if (!shimHtml) return response;

  // The body was already decoded by the network stack, so the original
  // content-encoding / content-length headers no longer apply.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let head = "";
  let injected = false;

  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }
      head += decoder.decode(chunk, { stream: true });
      const match = /<head\b[^>]*>/i.exec(head);
      if (match) {
        const at = match.index + match[0].length;
        controller.enqueue(encoder.encode(head.slice(0, at) + shimHtml + head.slice(at)));
        head = "";
        injected = true;
      } else if (head.length > 65536) {
        // No <head> found — put the shim at the very top instead.
        controller.enqueue(encoder.encode(shimHtml + head));
        head = "";
        injected = true;
      }
    },
    flush(controller) {
      if (!injected) controller.enqueue(encoder.encode(shimHtml + head));
    }
  }));

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only handle same-origin GETs; let everything else hit the network directly.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations. Never blanket-rewrite URLs.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (SHELL_PATHS.includes(url.pathname)) {
          // Launcher shell: network-first so launcher updates actually reach
          // the browser; fall back to cache when offline. Online responses
          // refresh the cached copy for the next offline session.
          try {
            const fresh = await fetch(request);
            // Clone right away: once the body starts streaming to the page it
            // can no longer be cloned.
            const copy = fresh.ok && fresh.type === "basic" ? fresh.clone() : null;
            if (copy) {
              // Store in the background: waiting for the write would delay the
              // response (client pages are ~75 MB).
              event.waitUntil(
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
              );
            }
            return fresh;
          } catch {
            return cached || caches.match("./index.html");
          }
        }
        // Client pages: cache-first (they are stored on demand the first time
        // they are opened), then network — and the network copy is stored so
        // the next launch works offline. The stored copy already carries the
        // shim, so an offline launch is patched too. Last resort: the cached
        // shell.
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          if (fresh.ok && fresh.type === "basic") {
            const shimHtml = await getShimHtml();
            // One tee only: the cache write and the page both read from it.
            // Cloning twice would leave an unread branch that buffers the
            // whole 75 MB body in memory.
            const injected = injectShim(fresh, shimHtml);
            const forPage = injected.clone();
            event.waitUntil(
              caches.open(CLIENT_CACHE).then((cache) => cache.put(request, injected))
            );
            return forPage;
          }
          return fresh;
        } catch {
          return caches.match("./index.html");
        }
      })()
    );
    return;
  }

  // Shell assets are precached (cache-first); client HTML is cached on demand.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic" && url.pathname.endsWith(".html")) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CLIENT_CACHE).then((cache) => cache.put(request, copy))
          );
        }
        return response;
      });
    })
  );
});
