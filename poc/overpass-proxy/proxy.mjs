/*
 * proxy.mjs — the guts of the Waypoint Overpass caching proxy (POC).
 *
 * Why this exists: Waypoint currently calls public Overpass mirrors straight from the
 * browser (js/overpass.js). Public Overpass is rate-limited and explicitly not for
 * production traffic — a popular app gets throttled or blocked. This proxy is the
 * production seam: the browser talks to US, and we:
 *
 *   1. CACHE identical queries on disk (a viewed area costs the upstream nothing twice),
 *   2. RATE-LIMIT per client (one abusive tab can't burn the shared upstream),
 *   3. GEOFENCE queries to our launch region (no unbounded scraping through our IP),
 *   4. speak to upstream with a proper User-Agent and fall across mirrors.
 *
 * Node built-ins only (matches Waypoint's zero-dep ethos). The upstream fetch is
 * injectable so the logic is testable offline (see smoke.mjs) without hammering Overpass.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Public Overpass mirrors, tried in order. Same list Waypoint ships, kept here so the
 *  proxy owns upstream policy (the browser no longer needs to know these exist). */
export const DEFAULT_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Launch region (St. Louis metro by default). Every coordinate in a query must fall
 *  inside this box or the query is refused — this is what stops our IP being used to
 *  scrape the planet. Widen per launch region via env (see config()). */
export const DEFAULT_BBOX = { south: 38.35, west: -90.9, north: 39.05, east: -89.95 };

export function config(env = process.env) {
  const num = (v, d) => (v !== undefined && v !== "" ? Number(v) : d);
  return {
    port: num(env.PORT, 8787),
    cacheDir: env.WP_CACHE_DIR || join(process.cwd(), ".cache"),
    cacheTtlMs: num(env.WP_CACHE_TTL_MS, 24 * 60 * 60 * 1000), // 24h
    rateMax: num(env.WP_RATE_MAX, 30), // requests…
    rateWindowMs: num(env.WP_RATE_WINDOW_MS, 60 * 1000), // …per minute per IP
    bbox: env.WP_BBOX
      ? (([s, w, n, e]) => ({ south: s, west: w, north: n, east: e }))(env.WP_BBOX.split(",").map(Number))
      : DEFAULT_BBOX,
    mirrors: env.WP_MIRRORS ? env.WP_MIRRORS.split(",") : DEFAULT_MIRRORS,
    userAgent: env.WP_USER_AGENT || "Waypoint/0.1 (+https://github.com/maverickcoderbot/waypoint)",
    upstreamTimeoutMs: num(env.WP_UPSTREAM_TIMEOUT_MS, 32_000),
  };
}

const keyOf = (query) => createHash("sha256").update(query).digest("hex");

/* ---- on-disk cache (stale entries are simply misses) --------------------- */
export function cacheGet(cfg, query) {
  const f = join(cfg.cacheDir, keyOf(query) + ".json");
  if (!existsSync(f)) return null;
  try {
    const entry = JSON.parse(readFileSync(f, "utf8"));
    if (Date.now() - entry.ts > cfg.cacheTtlMs) return null; // expired
    return entry.body;
  } catch {
    return null;
  }
}
export function cacheSet(cfg, query, body) {
  mkdirSync(cfg.cacheDir, { recursive: true });
  writeFileSync(join(cfg.cacheDir, keyOf(query) + ".json"), JSON.stringify({ ts: Date.now(), body }));
}

/* ---- region geofence ----------------------------------------------------- */
/** Pull every coordinate a query references — both `around:radius,lat,lon` and Overpass
 *  bbox filters `(south,west,north,east)` — and require all of them inside the region.
 *  A query with no coordinates at all is refused: we only serve geofenced lookups. */
export function regionViolation(query, bbox) {
  const coords = [];
  for (const m of query.matchAll(/around:\s*\d+(?:\.\d+)?\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)) {
    coords.push([Number(m[1]), Number(m[2])]);
  }
  // bbox filter: (south,west,north,east) — check both corners
  for (const m of query.matchAll(/\(\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\)/g)) {
    coords.push([Number(m[1]), Number(m[2])]);
    coords.push([Number(m[3]), Number(m[4])]);
  }
  if (!coords.length) return "query has no geofenceable coordinates (around: or bbox) — refused";
  for (const [lat, lon] of coords) {
    if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) {
      return `coordinate ${lat},${lon} is outside the served region`;
    }
  }
  return null;
}

/* ---- per-IP rate limit (fixed window) ------------------------------------ */
export function makeRateLimiter(cfg) {
  const hits = new Map(); // ip -> { count, resetAt }
  return function allow(ip) {
    const now = Date.now();
    const e = hits.get(ip);
    if (!e || now >= e.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + cfg.rateWindowMs });
      return true;
    }
    if (e.count >= cfg.rateMax) return false;
    e.count++;
    return true;
  };
}

/* ---- upstream (injectable for tests) ------------------------------------- */
/** Try each mirror in turn with a hard timeout + our User-Agent. Returns the first OK
 *  body text, or throws after all mirrors fail. */
export async function fetchUpstream(cfg, query, fetchImpl = fetch) {
  let lastErr = null;
  for (const ep of cfg.mirrors) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.upstreamTimeoutMs);
      try {
        const res = await fetchImpl(ep, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": cfg.userAgent },
          body: "data=" + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all upstream mirrors failed");
}

/** Evict expired cache files (opportunistic housekeeping; safe to call anytime). */
export function sweepCache(cfg) {
  if (!existsSync(cfg.cacheDir)) return 0;
  let removed = 0;
  for (const f of readdirSync(cfg.cacheDir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(cfg.cacheDir, f);
    try {
      if (Date.now() - statSync(p).mtimeMs > cfg.cacheTtlMs) { unlinkSync(p); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}
