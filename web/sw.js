// Minimal service worker: registers the app as installable PWA.
// Strategy: network-first for HTML, cache static assets opportunistically.
const CACHE = "phone-mac-v2";
const STATIC = [
  "/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png",
  "/vendor/xterm.min.css", "/vendor/xterm.min.js", "/vendor/xterm-addon-fit.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/pty") || url.pathname === "/healthz") return;

  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp.ok && url.origin === location.origin) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
