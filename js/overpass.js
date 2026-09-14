/*
 * overpass.js — the "data layer" of Waypoint.
 *
 * This is where free/open data comes in. No API keys, no accounts:
 *   - Trails   -> OpenStreetMap via the Overpass API (same data AllTrails uses)
 *   - Weather  -> Open-Meteo (free, no key)
 *
 * Everything here is plain functions so you can read top-to-bottom and
 * even run it in Node to test (see the module.exports at the bottom).
 */

// Public Overpass endpoints. If one is slow/down/rate-limited we fall to the
// next. Order matters: keep responsive mirrors first. Each attempt is wrapped
// in a hard client-side timeout so a hung mirror can't freeze the UI.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 32000; // give up on a single mirror after 32s

/* fetch() with a hard timeout via AbortController — prevents a stalled mirror
 * from hanging the request (and the spinner) forever. */
async function fetchWithTimeout(fetchImpl, url, opts = {}, ms = OVERPASS_TIMEOUT_MS) {
  // Some fetch impls (older Node) may lack AbortController; degrade gracefully.
  if (typeof AbortController === 'undefined') return fetchImpl(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* Haversine distance in metres between two [lat, lon] points. */
function haversine(a, b) {
  const R = 6371000; // Earth radius, metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Total length of an ordered list of [lat, lon] points, in metres. */
function pathLength(points) {
  let m = 0;
  for (let i = 0; i < points.length - 1; i++) m += haversine(points[i], points[i + 1]);
  return m;
}

/* OSM splits a trail into segments returned in arbitrary order/direction. Chain
 * them into one continuous path by greedily attaching the nearest remaining
 * segment endpoint (flipping/prepending as needed). This makes the elevation
 * profile and the map scrubber follow the actual route instead of jumping. */
function orderSegments(segments) {
  const segs = segments.filter((s) => s && s.length).map((s) => s.slice());
  if (segs.length <= 1) return segs[0] ? segs[0].slice() : [];
  const used = new Array(segs.length).fill(false);
  let path = segs[0].slice(); used[0] = true;
  for (let n = 1; n < segs.length; n++) {
    const head = path[0], tail = path[path.length - 1];
    let best = -1, bestD = Infinity, mode = 0; // 0 append, 1 append-rev, 2 prepend-rev, 3 prepend
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const a = segs[i][0], b = segs[i][segs[i].length - 1];
      const cand = [haversine(tail, a), haversine(tail, b), haversine(head, a), haversine(head, b)];
      for (let m = 0; m < 4; m++) if (cand[m] < bestD) { bestD = cand[m]; best = i; mode = m; }
    }
    if (best < 0) break;
    used[best] = true;
    const s = segs[best];
    if (mode === 0) path = path.concat(s);
    else if (mode === 1) path = path.concat(s.slice().reverse());
    else if (mode === 2) path = s.slice().reverse().concat(path);
    else path = s.slice().concat(path);
  }
  return path;
}

/* Rough difficulty from distance + OSM tags. Good enough for a first pass;
 * later we can factor in real elevation gain. */
function difficulty(lengthKm, tags = {}) {
  const sac = tags.sac_scale; // OSM hiking difficulty tag, if present
  if (sac && sac !== 'hiking') return 'Hard';
  if (lengthKm >= 8) return 'Hard';
  if (lengthKm >= 3.5) return 'Moderate';
  return 'Easy';
}

/* ---------------------------------------------------------------------------
 * Scenic-vs-industrial filter.
 *
 * OSM lumps hiking trails in with sidewalks, farm tracks, service roads and
 * utility/industrial paths under the same `highway` values. We want the
 * nature/scenic ones only, so we (a) reject anything that is clearly urban or
 * industrial, then (b) require at least one positive "this is a real trail"
 * signal. Ambiguous leftovers (e.g. a plain named footway with no signal —
 * usually a city sidewalk) are dropped.
 * ------------------------------------------------------------------------- */

// Natural/unpaved surfaces typical of real trails.
const NATURE_SURFACE = new Set([
  'ground', 'dirt', 'earth', 'grass', 'gravel', 'fine_gravel', 'compacted',
  'unpaved', 'sand', 'rock', 'pebblestone', 'woodchips', 'mud', 'grass_paver',
]);
// Words that suggest a scenic/nature route (rail-trails count — "railroad trail").
const NATURE_WORDS = /\b(trail|loop|greenway|nature|preserve|creek|ridge|river|lake|falls?|canyon|forest|woods?|glen|gorge|summit|peak|bluff|meadow|wetland|marsh|boardwalk|path|hike|hiking|scenic|overlook|vista|hollow|hoot|spur|switchback)\b/i;
// Words that suggest an industrial/service/utility corridor (unless overridden below).
const INDUSTRIAL_WORDS = /\b(pipeline|powerline|power\s?line|transmission|substation|utility|sewer|drainage|ditch|levee\s?access|service\s?road|access\s?road|maintenance|loading|dock|plant|refinery|quarry|mine|industrial|parking|driveway|siding|spur\s?track|conveyor)\b/i;

function hasNatureSignal(tags) {
  if (tags.route === 'hiking') return true;
  if (tags.sac_scale || tags.trail_visibility || tags.mtb_scale) return true;
  if (tags.highway === 'path' || tags.highway === 'bridleway') return true;
  if (tags.surface && NATURE_SURFACE.has(tags.surface)) return true;
  if (tags.leisure === 'track' || tags.leisure === 'nature_reserve') return true;
  if (tags.name && NATURE_WORDS.test(tags.name)) return true;
  return false;
}

function isIndustrialOrUrban(tags) {
  // Hard rejects: sidewalks, crossings, private/blocked, indoor, service ways.
  if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return true;
  if (tags.highway === 'steps') return true;
  if (tags.access === 'private' || tags.access === 'no') return true;
  if (tags.indoor === 'yes') return true;
  if (tags.service) return true;                     // driveway, parking_aisle, etc.
  if (tags.landuse === 'industrial' || tags.industrial) return true;
  if (tags.man_made || tags.power || tags.pipeline) return true;
  // Name-based industrial hint, but let a strong trail signal win (rail-trails).
  if (tags.name && INDUSTRIAL_WORDS.test(tags.name) &&
      !(tags.route === 'hiking' || tags.sac_scale)) return true;
  return false;
}

/* Keep only scenic/nature trails: reject industrial/urban, then require a signal. */
function isNatureTrail(tags = {}) {
  if (isIndustrialOrUrban(tags)) return false;
  return hasNatureSignal(tags);
}

/*
 * Fetch named trails within `radius` metres of [lat, lon].
 * Returns [{ id, name, points:[[lat,lon]...], km, difficulty, tags }] sorted by distance-ish.
 */
async function fetchTrailsNear(lat, lon, radius = 20000, fetchImpl = fetch, maxResults = 150) {
  // Keep the payload light so even slow public mirrors finish in time. We
  // deliberately DON'T query cycleway here: in a metro it triples the download
  // (mostly urban bike lanes we'd filter out anyway) and stalls slow mirrors.
  // path/footway/track/bridleway + route=hiking already yields ~200 trails at
  // 24 km. isNatureTrail() does the scenic-vs-industrial call on the results.
  const a = `(around:${radius},${lat},${lon})`;
  const query = `
    [out:json][timeout:30];
    (
      way["highway"~"^(path|footway|track|bridleway)$"]["name"]["footway"!~"sidewalk|crossing"]${a};
      way["route"="hiking"]["name"]${a};
    );
    out geom;`;

  // Two passes over the mirror list: public Overpass instances frequently 429 /
  // 504 under load, and a second attempt often lands on one that has recovered.
  let data = null, lastErr = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(fetchImpl, ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        break;
      } catch (e) {
        // Timeouts surface as AbortError; treat like any other mirror failure.
        lastErr = e;
      }
    }
  }
  if (!data) throw lastErr || new Error('Overpass unreachable');

  // Merge ways that share a name into one trail (OSM splits long trails into segments).
  const byName = new Map();
  for (const el of data.elements) {
    if (!el.geometry || !el.tags || !el.tags.name) continue;
    if (!isNatureTrail(el.tags)) continue; // scenic/nature only — skip industrial/urban
    const pts = el.geometry.map((g) => [g.lat, g.lon]);
    const key = el.tags.name;
    if (!byName.has(key)) byName.set(key, { id: el.id, name: key, segments: [], tags: el.tags });
    byName.get(key).segments.push(pts);
  }

  const trails = [];
  for (const t of byName.values()) {
    const points = orderSegments(t.segments); // continuous route order, not raw concat
    if (points.length < 2) continue;
    const meters = t.segments.reduce((s, seg) => s + pathLength(seg), 0);
    if (meters < 100) continue; // skip degenerate stubs (e.g. a 30 m named fragment)
    const km = meters / 1000;
    // approx distance from the user to the trail's nearest sampled point
    let near = Infinity;
    for (const p of points) near = Math.min(near, haversine([lat, lon], p));
    trails.push({
      id: t.id, name: t.name, points, segments: t.segments,
      km: +km.toFixed(2), meters, difficulty: difficulty(km, t.tags),
      distToUserKm: +(near / 1000).toFixed(2), tags: t.tags,
    });
  }
  // Nearest first; cap the list so a dense metro doesn't flood the map/list.
  trails.sort((a, b) => a.distToUserKm - b.distToUserKm || b.km - a.km);
  return maxResults > 0 ? trails.slice(0, maxResults) : trails;
}

/* From several geocode candidates, pick the one nearest `bias` {lat,lon}.
 * Without a bias, keep the provider's top hit. This disambiguates codes that
 * exist in multiple countries (e.g. postal 63043 is both Maryland Heights, MO
 * and a village in Ukraine) by preferring what's near where the user is. */
function pickNearest(cands, bias) {
  if (!cands.length) return null;
  if (!bias || bias.lat == null || bias.lon == null) return cands[0];
  let best = cands[0], bd = Infinity;
  for (const c of cands) {
    const d = haversine([bias.lat, bias.lon], [c.lat, c.lon]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/* Geocode a zip/postal code or place name -> { lat, lon, label }.
 * Tries Nominatim first (best coverage: addresses, POIs, postcodes), then
 * falls back to Open-Meteo geocoding (very reliable for cities/zips). Both are
 * free and need no API key. `bias` {lat,lon} disambiguates toward the user's
 * area. Returns null if nothing matches anywhere. */
async function geocodePlace(q, bias = null, fetchImpl = fetch) {
  const query = String(q || '').trim();
  if (!query) return null;
  const viaNominatim = await geocodeNominatim(query, bias, fetchImpl).catch(() => null);
  if (viaNominatim) return viaNominatim;
  return geocodeOpenMeteo(query, bias, fetchImpl).catch(() => null);
}

// OpenStreetMap Nominatim. Browsers send a Referer, which its policy accepts.
async function geocodeNominatim(query, bias = null, fetchImpl = fetch) {
  const isZip = /^\d{4,6}(-\d{3,4})?$/.test(query);
  const params = isZip
    ? `postalcode=${encodeURIComponent(query)}`
    : `q=${encodeURIComponent(query)}`;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=5&${params}`;
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, 12000);
  if (!res.ok) throw new Error('nominatim HTTP ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const cands = arr.map((r) => ({
    lat: +r.lat, lon: +r.lon,
    label: String(r.display_name || query).split(',').slice(0, 3).join(',').trim(),
  }));
  return pickNearest(cands, bias);
}

// Open-Meteo geocoding — CORS-friendly, no key, resolves city names and zips.
async function geocodeOpenMeteo(query, bias = null, fetchImpl = fetch) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(fetchImpl, url, {}, 12000);
  if (!res.ok) throw new Error('open-meteo geo HTTP ' + res.status);
  const j = await res.json();
  if (!j.results || !j.results.length) return null;
  const cands = j.results.map((g) => ({
    lat: g.latitude, lon: g.longitude,
    label: [g.name, g.admin1, g.country_code].filter(Boolean).join(', '),
  }));
  return pickNearest(cands, bias);
}

/* Elevation profile along a trail via Open-Meteo's free elevation API (no key,
 * CORS-friendly). Samples up to 80 points evenly and returns:
 *   { elevations:[m...], dists:[cumulative m...], coords:[[lat,lon]...], gain:m }
 * enough to show total gain, draw the chart, and map a chart position back to a
 * point on the trail (for the interactive scrubber).
 * Returns null on failure so the UI can omit it. */
async function fetchElevationProfile(points, fetchImpl = fetch) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const N = Math.min(80, points.length);
  const step = (points.length - 1) / (N - 1);
  const samp = [];
  for (let i = 0; i < N; i++) samp.push(points[Math.round(i * step)]);
  const lats = samp.map((p) => p[0].toFixed(5)).join(',');
  const lons = samp.map((p) => p[1].toFixed(5)).join(',');
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
  const res = await fetchWithTimeout(fetchImpl, url, {}, 12000);
  if (!res.ok) throw new Error('elevation HTTP ' + res.status);
  const raw = (await res.json()).elevation;
  if (!Array.isArray(raw)) return null;
  // Open-Meteo can return null for some points (no data / water) — drop those,
  // keeping elevations, coords and distances in sync, so no NaN reaches the UI.
  const elevations = [], coords = [];
  for (let i = 0; i < raw.length; i++) {
    if (Number.isFinite(raw[i]) && samp[i]) { elevations.push(raw[i]); coords.push(samp[i]); }
  }
  if (elevations.length < 2) return null;
  const dists = [0];
  for (let i = 1; i < coords.length; i++) dists.push(dists[i - 1] + haversine(coords[i - 1], coords[i]));
  let gain = 0;
  for (let i = 1; i < elevations.length; i++) { const d = elevations[i] - elevations[i - 1]; if (d > 0) gain += d; }
  return { elevations, dists, coords, gain };
}

/* A scenic photo near [lat,lon] from Wikimedia Commons (free, no key, CORS via
 * origin=*). Geosearch returns the nearest File objects regardless of subject,
 * so we only accept ones whose title reads as scenery — otherwise return null
 * and let the UI fall back to its gradient banner. Not Google Maps: those photos
 * need a paid, billing-enabled API key and scraping breaks Google's ToS. */
const SCENIC_TITLE = /\b(park|trail|lake|creek|river|forest|wood|woods|panorama|landscape|nature|bluff|falls?|meadow|prairie|pond|glade|greenway|valley|ridge|scenic|overlook|garden|reserve|preserve|hiking|path|marsh|wetland|meramec|summit)\b/i;
/* Up to `limit` scenic landscape photos near [lat,lon] from Wikimedia Commons,
 * nearest first. Returns [] when nothing scenic is nearby (UI keeps its gradient). */
async function fetchTrailPhotos(lat, lon, limit = 6, fetchImpl = fetch) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggsradius=2000&ggscoord=${lat}|${lon}&ggslimit=20&ggsnamespace=6` +
    `&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1200`;
  const res = await fetchWithTimeout(fetchImpl, url, {}, 10000);
  if (!res.ok) throw new Error('photo HTTP ' + res.status);
  const pages = (await res.json())?.query?.pages;
  if (!pages) return [];
  return Object.values(pages)
    .sort((a, b) => (a.index || 0) - (b.index || 0)) // geosearch order = nearest first
    .map((p) => ({ title: p.title || '', ii: (p.imageinfo || [])[0] }))
    .filter((c) => c.ii && c.ii.thumburl && /image\/(jpeg|png|webp)/.test(c.ii.mime || '')
      && (c.ii.width || 0) >= (c.ii.height || 0) // landscape-ish only
      && SCENIC_TITLE.test(c.title))
    .slice(0, limit)
    .map((c) => c.ii.thumburl);
}

/* Trail conditions from Open-Meteo (free, no key): current weather at the trail
 * plus recent rainfall (past 3 days) so we can estimate how muddy the ground is.
 * Returns { tempF, code, rainProb, recentPrecipMm } or null. */
async function fetchConditions(lat, lon, fetchImpl = fetch) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code` +
    `&daily=precipitation_sum,precipitation_probability_max` +
    `&past_days=3&forecast_days=1&temperature_unit=fahrenheit&timezone=auto`;
  const res = await fetchWithTimeout(fetchImpl, url, {}, 12000);
  if (!res.ok) throw new Error('conditions HTTP ' + res.status);
  const j = await res.json();
  const cur = j.current || {}, daily = j.daily || {};
  const precip = daily.precipitation_sum || [];
  const recentPrecipMm = precip.slice(0, Math.max(0, precip.length - 1)).reduce((a, b) => a + (b || 0), 0);
  const probs = daily.precipitation_probability_max || [];
  return {
    tempF: Number.isFinite(cur.temperature_2m) ? Math.round(cur.temperature_2m) : null,
    code: cur.weather_code ?? null,
    rainProb: probs.length ? probs[probs.length - 1] : null,
    recentPrecipMm: Math.round(recentPrecipMm * 10) / 10,
  };
}

/* Current + today's weather from Open-Meteo (free, no key). */
async function fetchWeather(lat, lon, fetchImpl = fetch) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,precipitation,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,precipitation_probability_max&temperature_unit=fahrenheit` +
    `&wind_speed_unit=mph&timezone=auto&forecast_days=1`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error('weather HTTP ' + res.status);
  return res.json();
}

/* WMO weather codes -> short label + emoji. */
function describeWeather(code) {
  const m = {
    0: ['Clear', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'],
    3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
    51: ['Drizzle', '🌦️'], 61: ['Rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    71: ['Snow', '🌨️'], 80: ['Showers', '🌦️'], 95: ['Storm', '⛈️'],
  };
  return m[code] || ['—', '🌡️'];
}

// Let Node import these for testing; harmless in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { haversine, pathLength, orderSegments, difficulty, fetchTrailsNear, fetchWeather, describeWeather, isNatureTrail, hasNatureSignal, isIndustrialOrUrban, geocodePlace, geocodeNominatim, geocodeOpenMeteo, pickNearest, fetchElevationProfile, fetchTrailPhotos, fetchConditions };
}
