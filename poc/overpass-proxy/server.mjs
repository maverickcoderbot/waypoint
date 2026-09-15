/*
 * server.mjs — the HTTP front of the Waypoint Overpass caching proxy (POC).
 *
 * Speaks the same shape as Overpass (`POST /api/interpreter` with a `data=` body), so
 * pointing Waypoint at it is a one-line change in js/overpass.js:
 *
 *     const OVERPASS_ENDPOINTS = ['https://trails.waypoint.app/api/interpreter'];
 *
 * Run:  node server.mjs        (PORT and WP_* env vars configure it — see proxy.mjs)
 */

import { createServer } from "node:http";
import { config, cacheGet, cacheSet, regionViolation, makeRateLimiter, fetchUpstream, sweepCache } from "./proxy.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Build the request handler. `upstreamFetch(query)` is injectable so tests can run the
 *  whole path with a fake upstream (no network). Defaults to the real mirror fan-out. */
export function makeHandler(cfg, upstreamFetch) {
  const allow = makeRateLimiter(cfg);
  const upstream = upstreamFetch || ((query) => fetchUpstream(cfg, query));

  return async function handler(req, res) {
    const send = (code, body, headers = {}) =>
      res.writeHead(code, { "Content-Type": "application/json", ...CORS, ...headers }).end(body);

    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();

    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") return send(200, JSON.stringify({ ok: true, region: cfg.bbox }));
    if (!url.pathname.endsWith("/api/interpreter")) return send(404, JSON.stringify({ error: "not found" }));

    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
    if (!allow(ip)) return send(429, JSON.stringify({ error: "rate limit — slow down" }), { "Retry-After": "60" });

    // Query arrives as form-encoded `data=` (POST) or `?data=` (GET), like real Overpass.
    let query = url.searchParams.get("data") || "";
    if (req.method === "POST") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      query = params.get("data") || raw; // tolerate a raw QL body too
    }
    query = (query || "").trim();
    if (!query) return send(400, JSON.stringify({ error: "missing Overpass query (data=…)" }));

    const violation = regionViolation(query, cfg.bbox);
    if (violation) return send(403, JSON.stringify({ error: `region: ${violation}` }));

    const cached = cacheGet(cfg, query);
    if (cached !== null) return send(200, cached, { "X-Cache": "HIT" });

    try {
      const body = await upstream(query);
      cacheSet(cfg, query, body);
      return send(200, body, { "X-Cache": "MISS" });
    } catch (e) {
      return send(502, JSON.stringify({ error: "upstream unavailable", detail: String(e?.message || e) }), { "X-Cache": "MISS" });
    }
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); }); // 1MB cap
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });
}

// Boot only when run directly (import for tests without starting a listener).
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  sweepCache(cfg);
  setInterval(() => sweepCache(cfg), 60 * 60 * 1000).unref();
  createServer(makeHandler(cfg)).listen(cfg.port, () => {
    console.log(`waypoint overpass-proxy on :${cfg.port} — region ${JSON.stringify(cfg.bbox)}, ${cfg.rateMax}/${Math.round(cfg.rateWindowMs / 1000)}s per IP, cache ttl ${Math.round(cfg.cacheTtlMs / 3600000)}h`);
  });
}
