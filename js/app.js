/*
 * app.js — the UI + map controller for Waypoint.
 *
 * Flow:
 *   1. Show a map (Leaflet + free OpenStreetMap tiles).
 *   2. "Locate me" -> browser Geolocation API -> live blue dot.
 *   3. "Find trails near here" -> ask overpass.js for trails -> draw + list them.
 *   4. Pick a trail -> highlight it, show stats, and (if we know your GPS)
 *      tell you where you are ON the trail: how far off it, and % along.
 */

// ---- Map ----------------------------------------------------------------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([38.63, -90.2], 12);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap',
}).addTo(map);

// Layers we draw onto
const trailLayer = L.layerGroup().addTo(map); // all found trails (faint)
const pickLayer = L.layerGroup().addTo(map);  // the selected trail (bold)
let meMarker = null, meAccuracy = null, mePos = null;

// ---- Elements -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  locate: $('locate'), find: $('findBtn'), status: $('status'), list: $('list'),
  sheet: $('sheet'), handle: $('sheetHandle'), detail: $('detail'), back: $('backBtn'),
  dName: $('dName'), dStats: $('dStats'), onTrail: $('onTrail'), wx: $('wx'),
  hero: $('hero'), heroForm: $('heroForm'), heroInput: $('heroInput'),
  heroSkip: $('heroSkip'), heroLocate: $('heroLocate'), heroBrowse: $('heroBrowse'),
  placeForm: $('placeForm'), placeInput: $('placeInput'),
};

let trails = [];      // last search results
let selected = null;  // currently opened trail
let autoFind = false; // find trails automatically once the first GPS fix lands

// ---- Hero landing -------------------------------------------------------
function dismissHero() {
  if (!els.hero) return;
  els.hero.classList.add('gone');
  // Leaflet sized itself under the hero; recompute once it's out of the way.
  setTimeout(() => { map.invalidateSize(); els.hero.hidden = true; }, 520);
}
// Hero search: geocode the typed place, or fall back to GPS if it's empty.
els.heroForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.heroInput.value.trim();
  dismissHero();
  if (q) searchPlace(q);
  else { autoFind = true; startLocating(); }
});
els.heroLocate.addEventListener('click', () => { autoFind = true; dismissHero(); startLocating(); });
els.heroSkip.addEventListener('click', dismissHero);
els.heroBrowse.addEventListener('click', dismissHero);

// Sheet search bar: same place search, available after the hero is gone.
els.placeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.placeInput.value.trim();
  if (q) searchPlace(q);
});

// ---- Search trails near a typed place (zip / postal code / place name) ----
async function searchPlace(q) {
  setSheet('open');
  setStatus(`Finding “${esc(q)}”… <span class="spin"></span>`);
  map.invalidateSize();
  // Bias geocoding toward where the user is looking (GPS, else map center) so
  // ambiguous codes resolve to the nearby country, not a same-numbered place abroad.
  const c = map.getCenter();
  const bias = mePos ? { lat: mePos[0], lon: mePos[1] } : { lat: c.lat, lon: c.lng };
  let loc;
  try {
    loc = await geocodePlace(q, bias);
  } catch {
    setStatus('Place lookup failed. Check your connection and try again.');
    return;
  }
  if (!loc) {
    setStatus(`Couldn’t find “${esc(q)}”. Try a zip code or a city/park name.`);
    return;
  }
  if (els.placeInput) els.placeInput.value = q;
  map.setView([loc.lat, loc.lon], 14);
  loadWeather(loc.lat, loc.lon);
  // Search around the geocoded spot (not the user's GPS).
  findTrails({ lat: loc.lat, lon: loc.lon, label: loc.label });
}

// ---- Bottom sheet expand/collapse --------------------------------------
function setSheet(state) { els.sheet.dataset.state = state; }
els.handle.addEventListener('click', () =>
  setSheet(els.sheet.dataset.state === 'open' ? 'peek' : 'open'));

// ---- Geolocation --------------------------------------------------------
els.locate.addEventListener('click', startLocating);

function startLocating() {
  if (!('geolocation' in navigator)) {
    setStatus('This device has no GPS/location support.');
    return;
  }
  els.locate.classList.add('on');
  setStatus('Locating you…');
  // watchPosition keeps updating as you move — that is what makes the
  // "you are here" dot track you while hiking.
  navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 20000,
  });
}

function onPos(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  mePos = [lat, lon];
  if (!meMarker) {
    meMarker = L.marker(mePos, {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }),
    }).addTo(map);
    meAccuracy = L.circle(mePos, { radius: accuracy, color: '#3b82f6', weight: 1, fillOpacity: 0.08 }).addTo(map);
    map.setView(mePos, 15);
    loadWeather(lat, lon);
    setStatus('Located. Now find trails near you.');
    if (autoFind) { autoFind = false; findTrails(); }
  } else {
    meMarker.setLatLng(mePos);
    meAccuracy.setLatLng(mePos).setRadius(accuracy);
  }
  if (selected) updateOnTrail(); // refresh "where am I on the trail" live
}

function onPosErr(err) {
  els.locate.classList.remove('on');
  setStatus(err.code === 1
    ? 'Location permission denied. Enable it to see where you are.'
    : 'Could not get your location. Try again with a clear sky view.');
}

// ---- Find trails --------------------------------------------------------
els.find.addEventListener('click', () => findTrails());

// Search radius tiers (metres). Start wide enough to cover a metro area (so we
// surface a comparable set to other trail apps); widen further only if a sparse
// rural spot still turns up nothing.
const SEARCH_RADII = [24000, 48000];

/* Find trails around an explicit {lat,lon,label}, else the user's GPS, else
 * the current map center. Expands the radius until it finds trails. */
async function findTrails(center) {
  const lat = center ? center.lat : (mePos ? mePos[0] : map.getCenter().lat);
  const lon = center ? center.lon : (mePos ? mePos[1] : map.getCenter().lng);
  const where = center && center.label ? ` near ${esc(center.label)}` : '';
  els.find.disabled = true;
  setSheet('open');
  try {
    let usedKm = 0;
    for (let i = 0; i < SEARCH_RADII.length; i++) {
      const km = SEARCH_RADII[i] / 1000;
      setStatus(i === 0
        ? `Searching for trails${where}… <span class="spin"></span>`
        : `No trails within ${SEARCH_RADII[i - 1] / 1000} km — widening to ${km} km… <span class="spin"></span>`);
      trails = await fetchTrailsNear(lat, lon, SEARCH_RADII[i]);
      usedKm = km;
      if (trails.length) break;
    }
    renderList();
    setStatus(trails.length
      ? `${trails.length} trails within ~${usedKm} km${where}.`
      : `No scenic trails found within ${usedKm} km${where}. Try another area.`);
  } catch (e) {
    setStatus('Trail search failed (servers busy). Try again in a moment.');
  } finally {
    els.find.disabled = false;
  }
}

function renderList() {
  trailLayer.clearLayers();
  pickLayer.clearLayers();
  els.detail.hidden = true;
  els.list.hidden = false;

  if (!trails.length) {
    els.list.innerHTML = '<div class="empty">No named trails found here.<br>Pan the map to a park and search again.</div>';
    return;
  }

  // Draw every trail faintly on the map…
  const bounds = [];
  trails.forEach((t) => {
    t.segments.forEach((seg) => {
      L.polyline(seg, { color: '#5ad07f', weight: 2, opacity: 0.5 }).addTo(trailLayer);
      seg.forEach((p) => bounds.push(p));
    });
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });

  // …and list them in the sheet.
  const cls = { Easy: 'easy', Moderate: 'mod', Hard: 'hard' };
  const thumbSvg = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M12 4l5 9H7l5-9z" fill="#fff" fill-opacity=".92"/><path d="M3 20l4-7 3 4 3-6 4 9" stroke="#fff" stroke-opacity=".85" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>';
  els.list.innerHTML = trails.map((t, i) => `
    <div class="card" data-i="${i}">
      <div class="thumb ${cls[t.difficulty]}">${thumbSvg}</div>
      <div class="meta">
        <div class="nm">${esc(t.name)}</div>
        <div class="sub">${t.km} km · ${t.distToUserKm} km away</div>
      </div>
      <span class="badge ${cls[t.difficulty]}">${t.difficulty}</span>
    </div>`).join('');

  els.list.querySelectorAll('.card').forEach((c) =>
    c.addEventListener('click', () => openTrail(trails[+c.dataset.i])));
}

// ---- Trail detail + "where am I on the trail" ---------------------------
function openTrail(t) {
  selected = t;
  els.list.hidden = true;
  els.detail.hidden = false;
  setSheet('open');
  els.dName.textContent = t.name;
  els.dStats.innerHTML = `
    <div class="stat"><div class="k">Distance</div><div class="v">${t.km} km</div></div>
    <div class="stat"><div class="k">Difficulty</div><div class="v">${t.difficulty}</div></div>
    <div class="stat"><div class="k">Miles</div><div class="v">${(t.km * 0.621).toFixed(1)}</div></div>`;

  // Highlight this trail on the map
  pickLayer.clearLayers();
  const b = [];
  t.segments.forEach((seg) => {
    L.polyline(seg, { color: '#fff', weight: 7, opacity: 0.9 }).addTo(pickLayer);
    L.polyline(seg, { color: '#c02a3b', weight: 4 }).addTo(pickLayer);
    seg.forEach((p) => b.push(p));
  });
  if (b.length) map.fitBounds(b, { padding: [50, 50] });
  updateOnTrail();
}

els.back.addEventListener('click', () => { selected = null; renderList(); });

/* Snap the user's GPS to the nearest point on the selected trail, and work
 * out how far off-trail they are and how far along the route. */
function updateOnTrail() {
  if (!selected) return;
  if (!mePos) { els.onTrail.hidden = true; return; }
  const flat = selected.points;
  let best = { d: Infinity, idx: 0 };
  for (let i = 0; i < flat.length; i++) {
    const d = haversine(mePos, flat[i]);
    if (d < best.d) best = { d, idx: i };
  }
  // Distance travelled along the trail up to the nearest point.
  let along = 0;
  for (let i = 0; i < best.idx; i++) along += haversine(flat[i], flat[i + 1]);
  const pct = Math.round((along / selected.meters) * 100);
  const off = Math.round(best.d);
  const onIt = off <= 30;
  els.onTrail.hidden = false;
  els.onTrail.innerHTML = onIt
    ? `<b>You're on the trail.</b> About <b>${pct}%</b> along · ${(along/1000).toFixed(2)} km in, ${((selected.meters-along)/1000).toFixed(2)} km to go.`
    : `You're <b>${off} m</b> from <b>${esc(selected.name)}</b> (nearest point ~${pct}% along). Head toward the red line.`;
}

// ---- Weather badge ------------------------------------------------------
async function loadWeather(lat, lon) {
  try {
    const w = await fetchWeather(lat, lon);
    const [label, emoji] = describeWeather(w.current.weather_code);
    const t = Math.round(w.current.temperature_2m);
    const rain = w.daily.precipitation_probability_max?.[0];
    els.wx.hidden = false;
    els.wx.innerHTML = `${emoji} ${t}°F · ${label}${rain != null ? ` · ${rain}% rain` : ''}`;
  } catch { /* weather is optional; ignore failures */ }
}

// ---- helpers ------------------------------------------------------------
function setStatus(html) { els.status.innerHTML = html; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Offline / installable (PWA) ---------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
