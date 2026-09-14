/* Minimal service worker: cache the app shell so Waypoint opens offline.
 * Map tiles and trail data still need a connection the first time you view
 * an area — a later version can pre-cache tiles for offline hikes. */
/* Bump this version on every release so the service worker re-installs and
 * evicts the old cached app shell — otherwise cache-first serves stale UI. */
const CACHE = 'waypoint-v19';
const SHELL = [
  './', './index.html', './css/styles.css', './js/app.js', './js/overpass.js', './js/cache.js',
  './manifest.webmanifest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // Drop only OLD versioned shell caches. Keep 'waypoint-tiles' (downloaded
  // offline maps) so app updates don't wipe the user's saved trails.
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys
      .filter((k) => k.startsWith('waypoint-v') && k !== CACHE)
      .map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // Cache-first for the app shell; network-first (with cache fallback) for tiles.
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
