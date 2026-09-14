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
  dBadge: $('dBadge'), dType: $('dType'), dDirections: $('dDirections'),
  dChips: $('dChips'), dTrack: $('dTrack'), dDots: $('dDots'), dCount: $('dCount'), dElev: $('dElev'),
  hero: $('hero'), heroForm: $('heroForm'), heroInput: $('heroInput'),
  heroSkip: $('heroSkip'), heroLocate: $('heroLocate'), heroBrowse: $('heroBrowse'),
  placeForm: $('placeForm'), placeInput: $('placeInput'), sheetHead: $('sheetHead'),
  dDownload: $('dDownload'), savedBtn: $('savedBtn'),
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
    const key = `geo:${q.toLowerCase()}|${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}`;
    loc = await cached(key, TTL.geo, () => geocodePlace(q, bias));
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

// ---- Bottom sheet: draggable with snap points --------------------------
// Three heights: collapsed (peek the map/trail), mid, full. Drag the handle to
// resize; it snaps to the nearest. Tap toggles between mid and full.
function snapPoints() {
  const vh = window.innerHeight;
  return [76, Math.round(vh * 0.48), Math.round(vh * 0.9)];
}
let sheetPx = null;
function applySheet(px, animate) {
  const s = snapPoints();
  px = Math.max(s[0], Math.min(s[s.length - 1], px));
  els.sheet.style.transition = animate ? 'height .3s cubic-bezier(.4,0,.2,1)' : 'none';
  els.sheet.style.height = `${px}px`;
  sheetPx = px;
  els.locate.style.bottom = `${px + 16}px`; // keep the locate button above the sheet
}
function snapNearest(px) {
  return snapPoints().reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a));
}
// state: 'collapsed' | 'peek'(=mid) | 'open'(=full)
function setSheet(state) {
  const s = snapPoints();
  applySheet(state === 'open' ? s[2] : state === 'collapsed' ? s[0] : s[1], true);
  setTimeout(() => map.invalidateSize(), 320);
}

let drag = null;
const ptY = (e) => (e.touches ? e.touches[0].clientY : e.clientY);
els.handle.addEventListener('pointerdown', (e) => {
  drag = { y: ptY(e), h: els.sheet.getBoundingClientRect().height, moved: false };
  els.sheet.style.transition = 'none';
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = drag.y - ptY(e);
  if (Math.abs(dy) > 4) drag.moved = true;
  applySheet(drag.h + dy, false);
  if (e.cancelable) e.preventDefault();
}, { passive: false });
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const wasTap = !drag.moved;
  const h = els.sheet.getBoundingClientRect().height;
  drag = null;
  if (wasTap) { const s = snapPoints(); applySheet(h >= s[2] - 20 ? s[1] : s[2], true); }
  else applySheet(snapNearest(h), true);
  setTimeout(() => map.invalidateSize(), 320);
});
// Re-snap on rotate/resize so the sheet stays proportional.
window.addEventListener('resize', () => { if (sheetPx != null) applySheet(snapNearest(sheetPx), false); });
// Start at mid once the DOM is ready.
applySheet(snapPoints()[1], false);

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

/* Trail fetch with an IndexedDB cache (stale-while-revalidate): a place you've
 * viewed before returns instantly and still refreshes in the background. */
async function trailsCached(lat, lon, radius) {
  const key = `trails:${lat.toFixed(3)},${lon.toFixed(3)}:${radius}`;
  const hit = await cacheGet(key);
  if (hit && hit.length) {
    fetchTrailsNear(lat, lon, radius)
      .then((fresh) => { if (fresh && fresh.length) cacheSet(key, fresh, TTL.trails); })
      .catch(() => {});
    return { trails: hit, cached: true };
  }
  const fresh = await fetchTrailsNear(lat, lon, radius);
  if (fresh && fresh.length) cacheSet(key, fresh, TTL.trails);
  return { trails: fresh, cached: false };
}

/* Find trails around an explicit {lat,lon,label}, else the user's GPS, else
 * the current map center. Expands the radius until it finds trails. */
async function findTrails(center) {
  const lat = center ? center.lat : (mePos ? mePos[0] : map.getCenter().lat);
  const lon = center ? center.lon : (mePos ? mePos[1] : map.getCenter().lng);
  const where = center && center.label ? ` near ${esc(center.label)}` : '';
  els.find.disabled = true;
  setSheet('open');
  try {
    let usedKm = 0, fromCache = false;
    for (let i = 0; i < SEARCH_RADII.length; i++) {
      const km = SEARCH_RADII[i] / 1000;
      setStatus(i === 0
        ? `Searching for trails${where}… <span class="spin"></span>`
        : `No trails within ${SEARCH_RADII[i - 1] / 1000} km — widening to ${km} km… <span class="spin"></span>`);
      const r = await trailsCached(lat, lon, SEARCH_RADII[i]);
      trails = r.trails; fromCache = r.cached; usedKm = km;
      if (trails.length) break;
    }
    renderList();
    setStatus(trails.length
      ? `${trails.length} trails within ~${usedKm} km${where}${fromCache ? ' · cached' : ''}.`
      : `No scenic trails found within ${usedKm} km${where}. Try another area.`);
  } catch (e) {
    // Offline or all mirrors down: fall back to whatever the user downloaded.
    const saved = await getSavedTrails();
    if (saved.length) {
      trails = saved;
      renderList();
      setStatus(`Search failed (offline?). Showing your ${saved.length} downloaded trail${saved.length > 1 ? 's' : ''}.`);
    } else {
      setStatus('Trail search failed (servers busy). Try again in a moment.');
    }
  } finally {
    els.find.disabled = false;
  }
}

function renderList() {
  trailLayer.clearLayers();
  pickLayer.clearLayers();
  els.detail.hidden = true;
  els.list.hidden = false;
  els.sheetHead.hidden = false; // restore search/find on the list view

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

// Rough hiking time at ~4.5 km/h.
function fmtTime(km) {
  const mins = Math.round((km / 4.5) * 60);
  if (mins < 60) return `${Math.max(5, mins)} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
// Loop if the ends nearly meet, else an out-and-back.
function routeType(t) {
  const p = t.points;
  if (p.length < 2) return '—';
  const gap = haversine(p[0], p[p.length - 1]);
  return gap < Math.max(60, t.meters * 0.08) ? 'Loop' : 'Out & back';
}
// Human-friendly surface/type from OSM tags.
const PAVED = ['asphalt', 'concrete', 'paved', 'paving_stones'];
const NATURAL = ['ground', 'dirt', 'earth', 'grass', 'gravel', 'fine_gravel',
  'compacted', 'unpaved', 'sand', 'rock', 'woodchips', 'mud'];
function trailType(tags = {}) {
  const s = (tags.surface || '').toLowerCase();
  if (tags.highway === 'cycleway') return 'Paved greenway';
  if (PAVED.includes(s)) return 'Paved path';
  if (NATURAL.includes(s)) return 'Natural surface';
  if (tags.highway === 'track') return 'Gravel track';
  if (tags.highway === 'bridleway') return 'Bridle path';
  return 'Hiking trail';
}

// Attribute chips derived from real OSM tags (no made-up data). Route type and
// surface live in the stat row / subtitle, so they're not repeated here.
function trailChips(t) {
  const g = t.tags || {}, chips = [];
  if (g.bicycle === 'yes' || g.bicycle === 'designated') chips.push('Bikes OK');
  if (g.horse === 'yes' || g.horse === 'designated') chips.push('Horses OK');
  if (g.dog === 'leashed') chips.push('Dogs on leash');
  else if (g.dog === 'yes') chips.push('Dogs OK');
  if (g.wheelchair === 'yes') chips.push('Wheelchair OK');
  if (g.lit === 'yes') chips.push('Lit at night');
  return chips;
}

// Build the photo gallery: swipeable image slides + dots, or a gradient slide.
const DIFF_CLS = { Easy: 'easy', Moderate: 'mod', Hard: 'hard' };
function renderGallery(t, photos) {
  const grad = DIFF_CLS[t.difficulty];
  if (!photos || !photos.length) {
    els.dTrack.innerHTML = `<div class="slide grad ${grad}"></div>`;
    els.dDots.innerHTML = '';
    els.dCount.hidden = true;
    return;
  }
  els.dTrack.innerHTML = photos
    .map((src) => `<div class="slide" style="background-image:url('${src.replace(/'/g, '%27')}')"></div>`)
    .join('');
  els.dDots.innerHTML = photos.length > 1
    ? photos.map((_, i) => `<span class="dot${i === 0 ? ' on' : ''}"></span>`).join('') : '';
  els.dCount.hidden = photos.length < 2;
  els.dCount.textContent = `1/${photos.length}`;
  els.dTrack.scrollLeft = 0;
}
// Sync dots + counter as the user swipes the gallery (bound once).
els.dTrack.addEventListener('scroll', () => {
  const w = els.dTrack.clientWidth;
  if (!w) return;
  const i = Math.round(els.dTrack.scrollLeft / w);
  els.dDots.querySelectorAll('.dot').forEach((d, j) => d.classList.toggle('on', j === i));
  const n = els.dDots.children.length;
  if (!els.dCount.hidden && n) els.dCount.textContent = `${i + 1}/${n}`;
});

// Render an interactive elevation-vs-distance chart. Hover/drag scrubs a marker
// along the trail on the map and shows the elevation/distance at that point.
let elevState = null;   // { prof, min, range, total }
let elevMarker = null;  // Leaflet marker tracking the scrub position
const ftOf = (m) => Math.round(m * 3.281);

function renderElevation(prof) {
  const el = prof && prof.elevations;
  if (!el || el.length < 2) { els.dElev.hidden = true; elevState = null; return; }
  const W = 100, H = 34;
  const min = Math.min(...el), max = Math.max(...el), range = (max - min) || 1;
  const total = prof.dists[prof.dists.length - 1] || 1;
  const line = el.map((e, i) =>
    `${i ? 'L' : 'M'}${((prof.dists[i] / total) * W).toFixed(1)},${(H - ((e - min) / range) * H).toFixed(1)}`).join(' ');
  els.dElev.innerHTML = `
    <div class="elev-head"><span>Elevation</span><span id="dElevRead">${ftOf(min)}–${ftOf(max)} ft</span></div>
    <div class="elev-plot" id="dElevPlot">
      <svg class="elev-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="elev-area" d="${line} L${W},${H} L0,${H} Z"/><path class="elev-line" d="${line}"/>
      </svg>
      <div class="elev-cursor" id="dElevCursor"></div>
      <div class="elev-dot" id="dElevDot"></div>
    </div>
    <div class="elev-axis"><span>0</span><span>${(total / 1000).toFixed(1)} km</span></div>`;
  els.dElev.hidden = false;
  elevState = { prof, min, range, total };
  const plot = $('dElevPlot');
  plot.onpointerdown = (e) => { plot.setPointerCapture?.(e.pointerId); elevScrub(e); };
  plot.onpointermove = elevScrub;
  plot.onpointerleave = elevScrubEnd;
  plot.onpointercancel = elevScrubEnd;
}

function elevScrub(e) {
  if (!elevState) return;
  const plot = $('dElevPlot');
  const rect = plot.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const target = (x / rect.width) * elevState.total;
  const { dists, elevations, coords } = elevState.prof;
  let idx = 0, best = Infinity;
  for (let i = 0; i < dists.length; i++) { const d = Math.abs(dists[i] - target); if (d < best) { best = d; idx = i; } }
  const xPx = (dists[idx] / elevState.total) * rect.width;
  const yPx = rect.height * (1 - (elevations[idx] - elevState.min) / elevState.range);
  const cursor = $('dElevCursor'), dot = $('dElevDot');
  cursor.style.left = `${xPx}px`; cursor.style.display = 'block';
  dot.style.left = `${xPx}px`; dot.style.top = `${yPx}px`; dot.style.display = 'block';
  $('dElevRead').textContent = `${ftOf(elevations[idx])} ft · ${(dists[idx] / 1000).toFixed(2)} km`;
  if (coords && coords[idx]) {
    if (!elevMarker) {
      elevMarker = L.circleMarker(coords[idx], { radius: 7, color: '#fff', weight: 3, fillColor: '#c02a3b', fillOpacity: 1 }).addTo(map);
    } else { elevMarker.setLatLng(coords[idx]); }
  }
  if (e.cancelable) e.preventDefault();
}

function elevScrubEnd() {
  const c = $('dElevCursor'), d = $('dElevDot'), r = $('dElevRead');
  if (c) c.style.display = 'none';
  if (d) d.style.display = 'none';
  if (r && elevState) r.textContent = `${ftOf(elevState.min)}–${ftOf(elevState.max)} ft`;
  removeElevMarker();
}
function removeElevMarker() { if (elevMarker) { map.removeLayer(elevMarker); elevMarker = null; } }

function openTrail(t) {
  selected = t;
  els.list.hidden = true;
  els.detail.hidden = false;
  els.dElev.hidden = true; // clear previous trail's chart until this one loads
  removeElevMarker();
  els.sheetHead.hidden = true; // hide search/find while reading a trail (declutter)
  setSheet('peek'); // mid height so the highlighted trail stays visible on the map
  els.dName.textContent = t.name;
  const cls = DIFF_CLS;
  renderGallery(t, null); // gradient placeholder immediately
  // Real scenic photos (Wikimedia) near the trail's midpoint; swipeable gallery.
  const mid = t.points[Math.floor(t.points.length / 2)];
  const forPhoto = t;
  cached(`photos:${mid[0].toFixed(3)},${mid[1].toFixed(3)}`, TTL.photo,
    () => fetchTrailPhotos(mid[0], mid[1], 6)).then((photos) => {
    if (selected === forPhoto && photos && photos.length) renderGallery(t, photos);
  }).catch(() => {});
  els.dBadge.className = `badge ${cls[t.difficulty]}`;
  els.dBadge.textContent = t.difficulty;
  els.dType.textContent = trailType(t.tags);
  const mi = (t.km * 0.621).toFixed(1);
  // Inline stat row (AllTrails-style). Elevation fills in async.
  els.dStats.innerHTML = `
    <div class="st"><div class="v">${mi} mi</div><div class="k">Length</div></div>
    <div class="st"><div class="v" id="dGain">—</div><div class="k">Elev. gain</div></div>
    <div class="st"><div class="v">${fmtTime(t.km)}</div><div class="k">Est. time</div></div>
    <div class="st"><div class="v">${routeType(t)}</div><div class="k">Route</div></div>`;
  const chips = trailChips(t);
  els.dChips.innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  els.dChips.hidden = chips.length === 0;
  // Directions to the trailhead (first mapped point).
  const head = t.points[0];
  els.dDirections.href = `https://www.google.com/maps/dir/?api=1&destination=${head[0]},${head[1]}&travelmode=driving`;
  els.dDownload.disabled = false;
  isSaved(t.id).then(setDownloadState);

  // Fetch elevation profile in the background (cached by trail id): fills the
  // gain stat and draws the elevation chart. Leaves "—" / no chart if it fails.
  const forTrail = t;
  cached(`elevp:${t.id}`, TTL.elev, () => fetchElevationProfile(t.points)).then((prof) => {
    if (selected !== forTrail || !prof) return; // user moved on / no data
    const gainEl = $('dGain');
    if (gainEl) gainEl.textContent = `${Math.round((prof.gain * 3.281) / 10) * 10} ft`;
    renderElevation(prof);
  }).catch(() => {});

  // Highlight this trail on the map
  pickLayer.clearLayers();
  const b = [];
  t.segments.forEach((seg) => {
    L.polyline(seg, { color: '#fff', weight: 7, opacity: 0.9 }).addTo(pickLayer);
    L.polyline(seg, { color: '#c02a3b', weight: 4 }).addTo(pickLayer);
    seg.forEach((p) => b.push(p));
  });
  // Fit the trail into the map area that's visible above the sheet.
  if (b.length) map.fitBounds(b, { paddingTopLeft: [30, 70], paddingBottomRight: [30, (sheetPx || 300) + 20] });
  updateOnTrail();
}

els.back.addEventListener('click', () => { selected = null; removeElevMarker(); renderList(); });

// ---- Offline download ---------------------------------------------------
// Web Mercator tile math.
const lon2tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
// Tile URLs covering a trail's bounds across zoom levels, capped so we never
// bulk-download huge areas (respectful of OSM's tile policy).
function tilesForBounds(bounds, zooms, cap) {
  const urls = [];
  for (const z of zooms) {
    const x0 = lon2tileX(bounds.getWest(), z), x1 = lon2tileX(bounds.getEast(), z);
    const y0 = lat2tileY(bounds.getNorth(), z), y1 = lat2tileY(bounds.getSouth(), z);
    const zurls = [];
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        if (x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) continue;
        zurls.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
    if (urls.length + zurls.length > cap) break; // keep lower zooms complete, stop before the cap
    urls.push(...zurls);
  }
  return urls;
}

function setDownloadState(saved) {
  els.dDownload.dataset.saved = saved ? '1' : '0';
  els.dDownload.classList.toggle('done', !!saved);
  els.dDownload.querySelector('.lbl').textContent = saved ? 'Downloaded ✓  ·  Remove' : 'Download for offline';
}

async function downloadTrail(t) {
  const lbl = els.dDownload.querySelector('.lbl');
  els.dDownload.disabled = true;
  lbl.textContent = 'Preparing…';
  // Make sure elevation + photos are cached so the detail works fully offline.
  const mid = t.points[Math.floor(t.points.length / 2)];
  try { await cached(`elevp:${t.id}`, TTL.elev, () => fetchElevationProfile(t.points)); } catch {}
  try { await cached(`photos:${mid[0].toFixed(3)},${mid[1].toFixed(3)}`, TTL.photo, () => fetchTrailPhotos(mid[0], mid[1], 6)); } catch {}
  // Pre-cache the map tiles around the trail.
  const urls = tilesForBounds(L.latLngBounds(t.points), [12, 13, 14, 15, 16], 500);
  await cacheTiles(urls, (d, n) => { lbl.textContent = `Downloading map… ${Math.round((d / n) * 100)}%`; });
  await saveTrail(t);
  els.dDownload.disabled = false;
  setDownloadState(true);
  refreshSavedBtn();
}

els.dDownload.addEventListener('click', () => {
  if (!selected) return;
  if (els.dDownload.dataset.saved === '1') {
    deleteSavedTrail(selected.id).then(() => { setDownloadState(false); refreshSavedBtn(); });
  } else {
    downloadTrail(selected);
  }
});

// "Downloaded (N)" bar in the sheet head → shows saved trails (work offline).
async function refreshSavedBtn() {
  const saved = await getSavedTrails();
  if (!saved.length) { els.savedBtn.hidden = true; return; }
  els.savedBtn.hidden = false;
  els.savedBtn.textContent = `⭳ Downloaded trails (${saved.length})`;
}
async function showSaved() {
  const saved = await getSavedTrails();
  if (!saved.length) { setStatus('No downloaded trails yet.'); return; }
  trails = saved;
  selected = null;
  renderList();
  setSheet('open');
  setStatus(`${saved.length} downloaded trail${saved.length > 1 ? 's' : ''} · available offline.`);
}
els.savedBtn.addEventListener('click', showSaved);
refreshSavedBtn();

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
