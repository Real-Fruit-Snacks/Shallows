const CACHE_NAME = "shallows-v1";

// Small files that must be available immediately after install
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/virtual-network.js",
  "/js/file-transfer.js",
  "/js/terminal-manager.js",
  "/js/ui.js",
  "/js/app.js",
  "/assets/bios/seabios.bin",
  "/assets/bios/vgabios.bin",
];

// Large assets cached on first use via network-first strategy
const LARGE_ASSETS = [
  "/js/libv86.js",
  "/js/v86.wasm",
  "/assets/images/alpine-virt-3.20.3-x86.iso",
];

const ALL_ASSETS = [...PRECACHE_ASSETS, ...LARGE_ASSETS];

// Install: pre-cache only small assets, then skip waiting
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: serve from cache first, fall back to network
// Also inject COOP/COEP headers to enable SharedArrayBuffer
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  const isLargeAsset = LARGE_ASSETS.some((a) => url.pathname === a);

  if (isLargeAsset) {
    // Network-first for large assets; cache on success for offline reuse
    e.respondWith(
      fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return addIsolationHeaders(resp);
      }).catch(() =>
        caches.match(e.request).then((cached) => {
          if (cached) return addIsolationHeaders(cached);
          return new Response("Asset unavailable offline", { status: 503 });
        })
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const response = cached || fetch(e.request);
      return Promise.resolve(response).then(addIsolationHeaders);
    })
  );
});

function addIsolationHeaders(resp) {
  const newHeaders = new Headers(resp.headers);
  newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
  newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: newHeaders,
  });
}
