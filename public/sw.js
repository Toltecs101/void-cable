/* VOID CABLE service worker: caches only the app shell so the site opens offline-ish and installs as an app.
   "/" is network-first (updates are never stale). Video, archive.org, YouTube and /api/ are never touched. */
const CACHE = "voidcable-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
  "/fonts/vt323.woff2", "/fonts/jersey10.woff2", "/fonts/dseg7.woff2"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("voidcable-shell-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;          // archive.org, youtube, fonts, radio: hands off
  if (url.pathname.startsWith("/api/")) return;              // live functions: hands off

  // the page itself: network first, cached copy only when offline
  if (url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match("/").then(r => r || Response.error()))
    );
    return;
  }

  // other shell files (manifest, icons, fonts): cache first, refresh in the background
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(url.pathname).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)).catch(() => {}); }
        return res;
      });
      return hit || net;
    }));
  }
  // anything else: not intercepted
});
