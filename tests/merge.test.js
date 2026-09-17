// Tests for connectivity-based trail merging (js/overpass.js).
// Run: node tests/merge.test.js   (exits non-zero on failure)
const assert = require('assert');
const {
  fetchTrailsNear, clusterWays, waysConnected, nameComponents, clusterName,
} = require('../js/overpass.js');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  -', name); })
    .catch((e) => { console.error('  FAIL -', name, '\n', e && e.message); process.exitCode = 1; });
}

// A greenway way: highway=path (passes isNatureTrail) + a nature-word name.
const way = (id, name, pts) => ({ type: 'way', id, tags: { highway: 'path', name }, geometry: pts.map(([lat, lon]) => ({ lat, lon })) });

// Three arcs of ONE physical loop, tagged with different concurrency names but
// all sharing "Lakeview Loop Trail" (the Creve Coeur Lake case from the report).
const arcA = way(1, 'Lakeview Loop Trail / Meadows Loop Trail',
  [[38.710, -90.470], [38.712, -90.470], [38.714, -90.470]]);
const arcB = way(2, 'Lakeview Loop Trail',
  [[38.714, -90.470], [38.714, -90.468], [38.714, -90.466]]);
const arcC = way(3, 'Lakeview Loop Trail / Mallard Lake Loop Trail',
  [[38.714, -90.466], [38.712, -90.466], [38.710, -90.466]]);
// An unrelated path that physically touches arcA but shares no name → must NOT merge.
const crossing = way(4, 'River Valley Connector',
  [[38.712, -90.470], [38.712, -90.472], [38.712, -90.474]]);

const fakeFetch = (elements) => async () => ({ ok: true, json: async () => ({ elements }) });

(async () => {
  await test('nameComponents splits on slash', () => {
    assert.deepStrictEqual(nameComponents('A / B'), ['A', 'B']);
    assert.deepStrictEqual(nameComponents('Solo Trail'), ['Solo Trail']);
  });

  await test('waysConnected detects shared endpoints and rejects far ones', () => {
    const w = (pts) => ({ pts });
    assert.strictEqual(waysConnected(w(arcA.geometry.map(g => [g.lat, g.lon])),
                                    w(arcB.geometry.map(g => [g.lat, g.lon]))), true);
    assert.strictEqual(waysConnected(w([[38.7, -90.4], [38.7, -90.41]]),
                                    w([[38.9, -90.9], [38.9, -90.91]])), false);
  });

  await test('clusterWays merges the 3 concurrency arcs into one, keeps crossing separate', () => {
    const ways = [arcA, arcB, arcC, crossing].map((el) => ({
      id: el.id, name: el.tags.name, comps: nameComponents(el.tags.name),
      pts: el.geometry.map((g) => [g.lat, g.lon]), tags: el.tags,
    }));
    const clusters = clusterWays(ways);
    const loop = clusters.find((c) => c.length === 3);
    assert.ok(loop, 'expected a 3-way cluster');
    assert.strictEqual(clusters.length, 2, 'loop + crossing = 2 clusters');
    assert.deepStrictEqual(clusters.map((c) => c.length).sort(), [1, 3]);
    assert.strictEqual(clusterName(loop).name, 'Lakeview Loop Trail');
  });

  await test('fetchTrailsNear returns one merged trail for the loop', async () => {
    const trails = await fetchTrailsNear(38.712, -90.468, 5000,
      fakeFetch([arcA, arcB, arcC]), 150, 'walk');
    assert.strictEqual(trails.length, 1, `expected 1 trail, got ${trails.length}`);
    assert.strictEqual(trails[0].name, 'Lakeview Loop Trail');
    assert.strictEqual(trails[0].segments.length, 3, 'all 3 arcs kept as segments');
    assert.ok(trails[0].meters > 400, 'combined length spans all arcs');
    assert.strictEqual(trails[0].id, 1, 'id is the min member id (stable)');
  });

  await test('unrelated crossing stays its own trail', async () => {
    const trails = await fetchTrailsNear(38.712, -90.470, 5000,
      fakeFetch([arcA, arcB, arcC, crossing]), 150, 'walk');
    const names = trails.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['Lakeview Loop Trail', 'River Valley Connector']);
  });

  console.log(`\n${passed} passed`);
})();
