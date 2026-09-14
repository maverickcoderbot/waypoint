/*
 * cache.js — a tiny IndexedDB key/value cache with TTL for API results.
 *
 * Why: the trail data comes from public Overpass mirrors that are slow and
 * flaky. Caching each result means a place you've already viewed loads
 * instantly (and still works with no signal). Geocodes, elevation and photos
 * are cached too. Everything degrades gracefully to "no cache" if IndexedDB is
 * unavailable (private mode, old browser) — the app just hits the network.
 *
 * Design: one object store, key -> { data, expires }. All ops are wrapped so a
 * cache failure never breaks a request.
 */
const CACHE_DB = 'waypoint-cache';
const CACHE_STORE = 'kv';
const SAVED_STORE = 'saved';       // downloaded trails, kept until the user removes them
const TILE_CACHE = 'waypoint-tiles'; // persistent map-tile cache (SW does not evict it)

// TTLs (ms). Trails/photos change rarely; elevation is effectively static.
const TTL = {
  trails: 21 * 24 * 3600 * 1000,   // 3 weeks
  geo: 30 * 24 * 3600 * 1000,      // 1 month
  photo: 30 * 24 * 3600 * 1000,    // 1 month
  elev: 180 * 24 * 3600 * 1000,    // 6 months
};

let _dbPromise = null;
function _db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('no idb')); return; }
    const req = indexedDB.open(CACHE_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
      if (!db.objectStoreNames.contains(SAVED_STORE)) db.createObjectStore(SAVED_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function cacheGet(key) {
  try {
    const db = await _db();
    return await new Promise((resolve) => {
      const req = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v && (!v.expires || v.expires > Date.now()) ? v.data : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function cacheSet(key, data, ttlMs) {
  try {
    const db = await _db();
    const store = db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE);
    store.put({ data, expires: ttlMs ? Date.now() + ttlMs : 0 }, key);
  } catch { /* cache is best-effort */ }
}

/* Cache-first with TTL: return the cached value if present, else fetch + store. */
async function cached(key, ttlMs, fetchFn) {
  const hit = await cacheGet(key);
  if (hit != null) return hit;
  const data = await fetchFn();
  if (data != null) cacheSet(key, data, ttlMs);
  return data;
}

/* ---- Downloaded (offline) trails ------------------------------------------ */
async function saveTrail(trail) {
  try {
    const db = await _db();
    db.transaction(SAVED_STORE, 'readwrite').objectStore(SAVED_STORE).put({ ...trail, savedAt: Date.now() });
  } catch { /* ignore */ }
}
async function getSavedTrails() {
  try {
    const db = await _db();
    return await new Promise((resolve) => {
      const req = db.transaction(SAVED_STORE, 'readonly').objectStore(SAVED_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.savedAt - a.savedAt));
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}
async function isSaved(id) {
  try {
    const db = await _db();
    return await new Promise((resolve) => {
      const req = db.transaction(SAVED_STORE, 'readonly').objectStore(SAVED_STORE).get(id);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => resolve(false);
    });
  } catch { return false; }
}
async function deleteSavedTrail(id) {
  try {
    const db = await _db();
    db.transaction(SAVED_STORE, 'readwrite').objectStore(SAVED_STORE).delete(id);
  } catch { /* ignore */ }
}

/* Pre-fetch map tiles into a persistent cache so a trail's map works offline.
 * Uses no-cors (opaque) responses, which <img> can still render. Best-effort,
 * limited concurrency; reports progress via onProgress(done, total). */
async function cacheTiles(urls, onProgress) {
  let done = 0, ok = 0;
  try {
    if (!('caches' in self)) { if (onProgress) onProgress(urls.length, urls.length); return 0; }
    const c = await caches.open(TILE_CACHE);
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try {
          if (!(await c.match(u))) { await c.put(u, await fetch(u, { mode: 'no-cors' })); }
          ok++;
        } catch { /* skip a tile */ }
        done++;
        if (onProgress) onProgress(done, urls.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  } catch { /* ignore */ }
  return ok;
}
