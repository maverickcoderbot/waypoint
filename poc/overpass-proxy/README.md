# Waypoint Overpass proxy — POC

Proof-of-concept for issue #18 (and the productionization plan). Waypoint currently calls
public Overpass mirrors straight from the browser; public Overpass is rate-limited and
[not for heavy/production use](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
This proxy is the production seam that fixes that without changing Waypoint's zero-dep,
static-hosting nature.

## What it does

The browser talks to **us** instead of Overpass, and we:

1. **Cache** identical queries on disk — a viewed area costs the upstream nothing the second time.
2. **Rate-limit** per client IP — one abusive tab can't burn the shared upstream through our IP.
3. **Geofence** every query to the launch region — no unbounded planet-scraping via our IP.
4. Talk to upstream with a proper **User-Agent** and **fall across mirrors**.

It speaks the same shape as Overpass (`POST /api/interpreter`, `data=` body), so adopting it
is a **one-line change** in `js/overpass.js`:

```js
const OVERPASS_ENDPOINTS = ['https://trails.waypoint.app/api/interpreter'];
```

## Run

```bash
cd poc/overpass-proxy
node server.mjs              # :8787 by default
node smoke.mjs               # deterministic offline tests (fake upstream)
```

Node built-ins only — no `npm install`.

## Proven (this POC)

- `node smoke.mjs` → 9/9: cache miss→hit (upstream hit exactly once), geofence 403,
  rate-limit 429 past the cap, input validation, `/health`.
- Live end-to-end vs real Overpass (St. Louis): **MISS ≈ 18 s / 67 elements** (real trails
  incl. *Lakeview Loop Trail*), then **cached HIT = 7 ms**. Same query, ~2500× faster, zero
  repeat upstream load.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8787` | listen port |
| `WP_CACHE_DIR` | `./.cache` | on-disk cache location |
| `WP_CACHE_TTL_MS` | `86400000` (24h) | how long a cached query stays fresh |
| `WP_RATE_MAX` / `WP_RATE_WINDOW_MS` | `30` / `60000` | requests per window per IP |
| `WP_BBOX` | St. Louis metro | `south,west,north,east` served region |
| `WP_MIRRORS` | 4 public mirrors | comma-separated upstream list |
| `WP_USER_AGENT` | `Waypoint/0.1 (+repo)` | sent to upstream |

## Deploy (next step, not done here)

Single stateless Node process — fits any small host (Fly.io / Railway / Render free-ish tiers,
or a €4 VPS). Front it with the platform's CDN/edge cache for a second cache layer. Point
`trails.waypoint.app` at it and flip the endpoint in `js/overpass.js`. For a bigger launch,
swap the upstream fan-out for a **self-hosted Overpass** instance behind the same proxy — the
browser contract doesn't change.

## Files

- `proxy.mjs` — cache, geofence, rate-limit, upstream fan-out (pure, injectable upstream).
- `server.mjs` — the HTTP front (Overpass-compatible `/api/interpreter`, `/health`, CORS).
- `smoke.mjs` — offline end-to-end tests.

---

### Companion P0: tiles (issue #17) — the other half of the self-host path

Not built in this POC, but the plan the same way: **Protomaps**. A whole region compiles to a
single `region.pmtiles` file that Waypoint can host as a static asset (even on GitHub Pages
alongside the app) and render with `protomaps-leaflet` / MapLibre — no tile server, no per-tile
policy problem, and it doubles as the **offline** tile source (issue #20), since it's one file.
Generation sketch:

```bash
# one-time, per launch region
pmtiles extract https://build.protomaps.com/<planet>.pmtiles stlouis.pmtiles \
  --bbox=-90.9,38.35,-89.95,39.05
```

That plus this proxy covers three of the four P0 blockers (tiles, trail data, offline);
geocoding (issue #19) can ride the same proxy pattern.
