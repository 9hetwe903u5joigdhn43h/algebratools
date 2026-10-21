/* Eaglercraft Launcher Service Worker
 *
 * Provides offline support:
 *   - Precaches the shell (index.html, manifest, icons, client catalog)
 *   - Claims all clients immediately so the SW takes control on first load
 *   - Serves the launcher shell NETWORK-FIRST (launcher updates are picked up
 *     on the next load; cache is only used offline)
 *   - Serves the client catalog STALE-WHILE-REVALIDATE, so adding a client
 *     shows up without bumping a cache name
 *   - Caches client HTML files only when the user asks for it (opt-in
 *     offline downloads), so the cache cannot grow without bound
 */

// Bump this whenever the launcher shell changes. Bumping purges every old
// launcher cache during activation, so no stale shell can survive.
const CACHE_NAME = "eaglercraft-launcher-v8";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./client-shim.js",
  "./clients/index.json",
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

// Client HTML files are cached on demand, and only when the user asks for
// it (the "Download for offline" button). Do NOT rename this when bumping
// CACHE_NAME: renaming would force a re-download for nothing. Bump it when
// a client build itself changes, so the old build is dropped and the new one
// is fetched once.
const CLIENT_CACHE = "eaglercraft-clients-v5";

// How much disk the offline client copies may use. The least recently
// downloaded client is dropped when the budget is exceeded.
const OFFLINE_BUDGET = 2 * 1024 * 1024 * 1024; // 2 GB

// The catalog and the legacy client list are served stale-while-revalidate:
// the cached copy goes out immediately and a fresh one is fetched in the
// background, so a newly added client shows up on the next visit without
// anyone having to bump a cache name.
const CATALOG_ASSETS = ["./clients/index.json", "./clients.json"];

// A key inside the client cache that holds the list of offline copies, in
// download order (oldest first), with their sizes.
const OFFLINE_INDEX = new URL("./__offline-index__", self.registration.scope).href;

// Launcher shell URLs (resolved against this SW's scope). Navigations to
// these are served network-first; every other navigation is a client page.
const SHELL_PATHS = ["./", "./index.html"].map(
  (p) => new URL(p, self.registration.scope).pathname
);

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // One missing asset must never take the whole worker down with it:
      // cache.addAll() rejects as a whole, which would leave the launcher
      // without a controller — no shim, no offline, nothing.
      const results = await Promise.allSettled(ASSETS.map(async (asset) => {
        const url = new URL(asset, self.registration.scope).href;
        const res = await fetch(url, { cache: "reload" });
        if (!res.ok) throw new Error(asset + " -> HTTP " + res.status);
        await cache.put(url, res);
      }));
      const failed = results
        .map((r, i) => (r.status === "rejected" ? ASSETS[i] + ": " + r.reason : null))
        .filter(Boolean);
      if (failed.length) console.warn("[sw] could not precache:", failed);
    })()
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
// The injection works for any path, so clients can live in folders.
// ---------------------------------------------------------------------------
const SHIM_PATH = "./client-shim.js";
let shimPromise = null;
let shimSource = null;

// Wrap the shim source in a script tag so the browser executes it. The
// charset declaration goes first: the client builds declare theirs megabytes
// into the document, far outside the window the browser sniffs.
function wrapShim(source) {
  if (!source) return "";
  return "<meta charset=\"utf-8\" />\n<script>\n" +
    source.replace(/<\/script/gi, "<\\/script") +
    "\n</script>\n";
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
  // The body was already decoded by the network stack, so the original
  // content-encoding / content-length headers no longer apply. They have to
  // go even when there is no shim to inject, or the browser would try to
  // decode the body a second time.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");

  // The client builds put their <meta charset> far outside the 1024 byte
  // window the browser sniffs, so the encoding has to come from the header —
  // otherwise anything non-ASCII (the panel glyph, for one) is decoded as
  // windows-1252 and comes out as mojibake.
  const type = headers.get("content-type") || "";
  if (/^text\/html/i.test(type) && !/charset=/i.test(type)) {
    headers.set("content-type", type + "; charset=utf-8");
  }

  if (!shimHtml) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }

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

// Count the bytes of a client download and tell the launcher about it, so it
// can show a progress bar while the client is fetched.
function withProgress(response) {
  let total = 0;
  try {
    const len = response.headers.get("content-length");
    if (len) total = Number(len) || 0;
  } catch (err) { /* ignore */ }

  let loaded = 0;
  let lastPost = 0;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      loaded += chunk.byteLength || 0;
      const now = Date.now();
      if (now - lastPost > 150) {
        lastPost = now;
        broadcast({ type: "client-progress", loaded: loaded, total: total });
      }
    },
    flush(controller) {
      broadcast({ type: "client-progress", loaded: loaded, total: total });
    }
  }));

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// ---------------------------------------------------------------------------
// Offline client copies (opt-in)
// ---------------------------------------------------------------------------

function broadcast(message) {
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => client.postMessage(message));
  }).catch(() => {});
}

// The path of a URL inside the worker's scope, so the launcher can match it
// against the catalog without worrying about the origin.
function scopeRelative(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  const path = new URL(url, self.registration.scope).pathname;
  if (scopePath && path.startsWith(scopePath)) return path.slice(scopePath.length);
  return path.replace(/^\/+/, "");
}

async function readOfflineIndex(cache) {
  try {
    const res = await cache.match(OFFLINE_INDEX);
    if (res) {
      const data = await res.json();
      if (data && Array.isArray(data.entries)) {
        data.entries = data.entries.filter((e) => e && typeof e.url === "string");
        return data;
      }
    }
  } catch (err) { /* no index yet */ }
  return { entries: [], bytes: 0 };
}

async function writeOfflineIndex(cache, index) {
  index.bytes = index.entries.reduce((sum, e) => sum + (e.size || 0), 0);
  await cache.put(OFFLINE_INDEX, new Response(JSON.stringify(index), {
    headers: { "content-type": "application/json" }
  }));
}

// Drop the oldest copies until the budget is met. The copy the user just
// asked for is always kept, even when it is bigger than the whole budget.
async function enforceBudget(cache, index) {
  while (index.bytes > OFFLINE_BUDGET && index.entries.length > 1) {
    const oldest = index.entries.shift();
    try { await cache.delete(oldest.url); } catch (err) { /* ignore */ }
    index.bytes -= oldest.size || 0;
    broadcast({ type: "offline-removed", url: oldest.url, reason: "budget" });
  }
}

async function rememberOffline(cache, url, size) {
  const index = await readOfflineIndex(cache);
  index.entries = index.entries.filter((e) => e.url !== url);
  index.entries.push({ url: url, size: size });
  await enforceBudget(cache, index);
  await writeOfflineIndex(cache, index);
}

async function offlineStatus() {
  const cache = await caches.open(CLIENT_CACHE);
  const index = await readOfflineIndex(cache);
  broadcast({
    type: "offline-status",
    clients: index.entries.map((e) => ({
      url: e.url,
      path: scopeRelative(e.url),
      size: e.size || 0
    })),
    bytes: index.bytes,
    budget: OFFLINE_BUDGET
  });
}

// Download a client build and keep it for offline play.
async function cacheClient(url) {
  const target = new URL(url, self.registration.scope).href;
  try {
    const res = await fetch(target, { cache: "no-cache" });
    if (!res.ok || res.type !== "basic") throw new Error("HTTP " + res.status);

    const total = Number(res.headers.get("content-length")) || 0;
    const headers = new Headers(res.headers);
    // The body is stored decoded, so the encoding headers would be a lie.
    headers.delete("content-encoding");
    headers.delete("content-length");

    let loaded = 0;
    let lastPost = 0;
    const path = scopeRelative(target);
    const stream = res.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        loaded += chunk.byteLength || 0;
        const now = Date.now();
        if (now - lastPost > 150) {
          lastPost = now;
          broadcast({ type: "client-download-progress", url: target, path: path, loaded: loaded, total: total });
        }
      },
      flush(controller) {
        broadcast({ type: "client-download-progress", url: target, path: path, loaded: loaded, total: total });
      }
    }));

    const cache = await caches.open(CLIENT_CACHE);
    await cache.put(target, new Response(stream, {
      status: res.status,
      statusText: res.statusText,
      headers: headers
    }));
    await rememberOffline(cache, target, loaded);
    broadcast({ type: "client-download-done", url: target, path: path, ok: true, size: loaded });
  } catch (err) {
    broadcast({ type: "client-download-done", url: target, path: scopeRelative(target), ok: false, error: String(err) });
  }
}

async function uncacheClient(url) {
  const target = new URL(url, self.registration.scope).href;
  const cache = await caches.open(CLIENT_CACHE);
  try { await cache.delete(target); } catch (err) { /* ignore */ }
  const index = await readOfflineIndex(cache);
  index.entries = index.entries.filter((e) => e.url !== target);
  await writeOfflineIndex(cache, index);
  broadcast({ type: "offline-removed", url: target, reason: "user" });
  await offlineStatus();
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "cache-client") {
    event.waitUntil(cacheClient(msg.url));
  } else if (msg.type === "uncache-client") {
    event.waitUntil(uncacheClient(msg.url));
  } else if (msg.type === "offline-status") {
    event.waitUntil(offlineStatus());
  }
});

// ---------------------------------------------------------------------------
// Fetch handling
// ---------------------------------------------------------------------------

function isCatalog(url) {
  return CATALOG_ASSETS.some((p) =>
    url.pathname === new URL(p, self.registration.scope).pathname);
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
        if (SHELL_PATHS.includes(url.pathname)) {
          // Launcher shell: network-first so launcher updates actually reach
          // the browser; fall back to cache when offline. Online responses
          // refresh the cached copy for the next offline session.
          const cached = await caches.match(request, { ignoreSearch: true });
          try {
            const fresh = await fetch(request);
            // Clone right away: once the body starts streaming to the page it
            // can no longer be cloned.
            const copy = fresh.ok && fresh.type === "basic" ? fresh.clone() : null;
            if (copy) {
              // Store in the background: waiting for the write would delay
              // the response (client pages are ~75 MB).
              event.waitUntil(
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
              );
            }
            return fresh;
          } catch {
            return cached || caches.match("./index.html");
          }
        }

        // Client pages: an offline copy, if the user asked for one, and
        // otherwise the network. The copy is the pristine build; the shim is
        // injected on the way out every time, so a cached client can never
        // bypass it and a new shim is picked up without re-downloading
        // 75 MB. Clients are NOT cached automatically any more — that is
        // what the "Download for offline" button is for.
        const shimPromise = getShimHtml();
        const clientCache = await caches.open(CLIENT_CACHE);
        const offline = await clientCache.match(request, { ignoreSearch: true });
        if (offline) return injectShim(offline, await shimPromise);
        try {
          const fresh = await fetch(request);
          if (!fresh.ok || fresh.type !== "basic") return fresh;
          return injectShim(withProgress(fresh), await shimPromise);
        } catch {
          return caches.match("./index.html");
        }
      })()
    );
    return;
  }

  // The client catalog: stale-while-revalidate. The cached copy goes out
  // right away and a fresh one is fetched in the background, so a newly
  // added client shows up on the next visit without a cache bump.
  if (isCatalog(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const fresh = fetch(request).then(async (res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            // Only say something when the catalog really changed. Telling the
            // launcher on every fetch would set off a loop: it refetches the
            // catalog, which refreshes it again, which tells it again...
            const previous = await caches.match(request);
            const oldText = previous ? await previous.text() : "";
            const newText = await copy.clone().text();
            if (newText !== oldText) {
              await caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
              // The launcher can pull the new list in without the user having
              // to refresh the page.
              broadcast({ type: "catalog-updated" });
            }
          }
          return res;
        }).catch(() => null);
        if (cached) {
          event.waitUntil(fresh);
          return cached;
        }
        const res = await fresh;
        return res || new Response(
          "The client catalog is not cached yet — connect once to fetch it.",
          { status: 503, headers: { "content-type": "text/plain" } }
        );
      })()
    );
    return;
  }

  // Shell assets are precached (cache-first).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request);
    })
  );
});
