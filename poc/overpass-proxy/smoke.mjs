/*
 * smoke.mjs — proves the proxy's behavior end-to-end over real HTTP, with a FAKE upstream
 * (no network, deterministic, doesn't hammer Overpass). Run: node smoke.mjs
 *
 * Verifies the four production properties: cache (miss→hit, upstream hit once), geofence
 * (out-of-region refused), rate limit (429 past the cap), and input validation.
 */

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./proxy.mjs";
import { makeHandler } from "./server.mjs";

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${name}`); if (!ok) failures++; };

const STL = "[out:json];way[highway=path](around:5000,38.7106,-90.4907);out geom;"; // in region
const AWAY = "[out:json];way[highway=path](around:5000,48.8566,2.3522);out geom;";   // Paris — out of region

/** Start a handler on an ephemeral port; returns { base, close, calls() }. */
function boot(envOverrides) {
  let calls = 0;
  const cfg = config({ WP_CACHE_DIR: mkdtempSync(join(tmpdir(), "wp-proxy-")), ...envOverrides });
  const fakeUpstream = async (query) => { calls++; return JSON.stringify({ elements: [{ id: 1, q: query.length }] }); };
  const server = createServer(makeHandler(cfg, fakeUpstream));
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)), calls: () => calls });
    });
  });
}

const post = (base, query) =>
  fetch(base + "/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });

// --- cache + geofence + validation (generous rate cap) ---
{
  const s = await boot({ WP_RATE_MAX: "100" });

  const r1 = await post(s.base, STL);
  check("in-region query: 200 + X-Cache MISS", r1.status === 200 && r1.headers.get("x-cache") === "MISS");
  check("upstream was called once", s.calls() === 1);

  const r2 = await post(s.base, STL);
  check("repeat query: 200 + X-Cache HIT", r2.status === 200 && r2.headers.get("x-cache") === "HIT");
  check("cache served it — upstream NOT called again", s.calls() === 1);

  const r3 = await post(s.base, AWAY);
  check("out-of-region query: 403 refused", r3.status === 403);
  check("refused query never reached upstream", s.calls() === 1);

  const r4 = await post(s.base, "   ");
  check("empty query: 400", r4.status === 400);

  const r5 = await fetch(s.base + "/health");
  check("/health: 200 ok", r5.status === 200 && (await r5.json()).ok === true);

  await s.close();
}

// --- rate limit (own instance, small cap) ---
{
  const s = await boot({ WP_RATE_MAX: "2", WP_RATE_WINDOW_MS: "60000" });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post(s.base, STL)).status);
  check("rate limit: first 2 pass, then 429", codes[0] === 200 && codes[1] === 200 && codes[3] === 429);
  await s.close();
}

console.log(failures === 0 ? "\n  all proxy smoke checks passed\n" : `\n  ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
