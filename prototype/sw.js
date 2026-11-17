// Offline-first service worker: caches the app shell so farmers can open it without network.
const CACHE = "agriconnect-v1";
const SHELL = ["index.html", "styles.css", "data.js", "manifest.json", "ussd.html", "dashboard.html"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
