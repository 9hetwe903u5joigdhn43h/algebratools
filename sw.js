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
// ~75 MB client re-download for nothing.
const CLIENT_CACHE = "eaglercraft-clients-v2";

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
        // the next launch works offline. Last resort: the cached shell.
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          const copy = fresh.ok && fresh.type === "basic" ? fresh.clone() : null;
          if (copy) {
            event.waitUntil(
              caches.open(CLIENT_CACHE).then((cache) => cache.put(request, copy))
            );
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
