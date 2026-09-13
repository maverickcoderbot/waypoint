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

// Public Overpass endpoints. If one is slow/down we fall through to the next.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

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

/* Rough difficulty from distance + OSM tags. Good enough for a first pass;
 * later we can factor in real elevation gain. */
function difficulty(lengthKm, tags = {}) {
  const sac = tags.sac_scale; // OSM hiking difficulty tag, if present
  if (sac && sac !== 'hiking') return 'Hard';
  if (lengthKm >= 8) return 'Hard';
  if (lengthKm >= 3.5) return 'Moderate';
  return 'Easy';
}

/*
 * Fetch named trails within `radius` metres of [lat, lon].
 * Returns [{ id, name, points:[[lat,lon]...], km, difficulty, tags }] sorted by distance-ish.
 */
async function fetchTrailsNear(lat, lon, radius = 6000, fetchImpl = fetch) {
  const query = `
    [out:json][timeout:50];
    (
      way["highway"~"path|footway|track|bridleway"]["name"](around:${radius},${lat},${lon});
      way["route"="hiking"]["name"](around:${radius},${lat},${lon});
    );
    out geom;`;

  let data = null, lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchImpl(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error('Overpass unreachable');

  // Merge ways that share a name into one trail (OSM splits long trails into segments).
  const byName = new Map();
  for (const el of data.elements) {
    if (!el.geometry || !el.tags || !el.tags.name) continue;
    const pts = el.geometry.map((g) => [g.lat, g.lon]);
    const key = el.tags.name;
    if (!byName.has(key)) byName.set(key, { id: el.id, name: key, segments: [], tags: el.tags });
    byName.get(key).segments.push(pts);
  }

  const trails = [];
  for (const t of byName.values()) {
    const points = t.segments.flat();
    if (points.length < 2) continue;
    const meters = t.segments.reduce((s, seg) => s + pathLength(seg), 0);
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
  // Show the more substantial, closer trails first.
  trails.sort((a, b) => a.distToUserKm - b.distToUserKm || b.km - a.km);
  return trails;
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
  module.exports = { haversine, pathLength, difficulty, fetchTrailsNear, fetchWeather, describeWeather };
}
