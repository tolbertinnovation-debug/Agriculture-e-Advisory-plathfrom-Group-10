// Offline-first: the app shell is cached so the app opens with no network.
// Farmer data is cached by app.js (localStorage); API calls always go to the network.
const CACHE = "agriconnect-app-v4";
const SHELL = ["./", "index.html", "app.js", "engine.js", "styles.css", "manifest.json", "assets/icons.js", "assets/inter-var.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return; // data: network only
  // Shell: try the network first (so updates arrive), fall back to the cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});
