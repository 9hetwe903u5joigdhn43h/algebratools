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
// changes, so the old build is dropped and the new one is fetched once.
const CLIENT_CACHE = "eaglercraft-clients-v4";

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
let shimSource = null;

// Wrap the shim source in a script tag so the browser executes it.
function wrapShim(source) {
  if (!source) return "";
  return "<script>\n" + source.replace(/<\/script/gi, "<\\/script") + "\n</script>\n";
}

// Network first, so an updated shim is picked up without re-downloading the
// clients; the precached copy is the offline fallback. A service worker's own
// fetches do not re-enter its fetch handler, so this hits the server directly.
function getShimHtml() {
  if (!shimPromise) {
    shimPromise = (async () => {
      const url = new URL(SHIM_PATH, self.registration.scope).href;
      try {
        const fresh = await fetch(url, { cache: "no-cache" });
        if (fresh.ok) {
          shimSource = await fresh.text();
          return;
        }
      } catch (err) { /* offline — use the precached copy */ }
      try {
        const cached = await caches.match(url);
        if (cached) shimSource = await cached.text();
      } catch (err) { /* no shim available */ }
    })();
  }
  return shimPromise.then(() => wrapShim(shimSource || ""));
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
        // they are opened), then network. The cached copy is the pristine
        // build; the shim is injected on the way out every time, so a cached
        // client can never bypass it and a new shim is picked up without
        // re-downloading 75 MB. Last resort: the cached shell.
        const shimPromise = getShimHtml();
        if (cached) return injectShim(cached, await shimPromise);
        try {
          // Start the download and the shim fetch together.
          const download = fetch(request);
          const shimHtml = await shimPromise;
          const fresh = await download;
          if (fresh.ok && fresh.type === "basic") {
            // Clone right away: once the body starts streaming to the page it
            // can no longer be cloned.
            const copy = fresh.clone();
            event.waitUntil(
              caches.open(CLIENT_CACHE).then((cache) => cache.put(request, copy))
            );
            return injectShim(fresh, shimHtml);
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
