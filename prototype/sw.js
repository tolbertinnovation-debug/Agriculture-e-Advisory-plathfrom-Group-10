// Service worker for the clickable prototype: it still opens without network.
// Network first, cache as the fallback: when online you always get the newest pages, so the
// officer dashboard in this folder is never served from an old copy. Old caches are deleted.
const CACHE = "agriconnect-v2";
const SHELL = ["index.html", "styles.css", "data.js", "manifest.json", "ussd.html", "dashboard.html", "assets/icons.js", "assets/inter-var.woff2"];

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
  // Only this folder's own files; API calls and other pages go straight to the network.
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(new URL("./", location).pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
