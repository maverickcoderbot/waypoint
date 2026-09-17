// Tests for connectivity-based trail merging (js/overpass.js).
// Run: node tests/merge.test.js   (exits non-zero on failure)
const assert = require('assert');
const {
  fetchTrailsNear, clusterWays, waysConnected, nameComponents, clusterName, maxPointGap,
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

  await test('maxPointGap finds the largest jump between consecutive points', () => {
    assert.ok(maxPointGap([[38.70, -90.47], [38.701, -90.47]]) < 200);
    assert.ok(maxPointGap([[38.70, -90.47], [38.90, -90.10]]) > 20000);
  });

  await test('far-apart same-name paths do NOT merge into one broken trail', async () => {
    // Two unrelated "Nature Trail" paths ~30 km apart (the generic-name problem).
    const nt1 = way(10, 'Nature Trail', [[38.79, -90.10], [38.791, -90.10]]);
    const nt2 = way(11, 'Nature Trail', [[38.60, -90.40], [38.601, -90.40]]);
    const trails = await fetchTrailsNear(38.70, -90.25, 60000,
      fakeFetch([nt1, nt2]), 150, 'walk');
    assert.strictEqual(trails.length, 2, 'stay as two separate local trails, not one');
    for (const t of trails) {
      assert.ok(maxPointGap(t.points) < 1500, 'no giant internal jump (not broken)');
    }
  });

  await test('control: same-name pieces that DO connect still merge into one', async () => {
    const p1 = way(20, 'Riverside Trail', [[38.70, -90.47], [38.702, -90.47]]);
    const p2 = way(21, 'Riverside Trail', [[38.702, -90.47], [38.704, -90.47]]);
    const trails = await fetchTrailsNear(38.70, -90.47, 5000,
      fakeFetch([p1, p2]), 150, 'walk');
    assert.strictEqual(trails.length, 1, 'connected same-name segments merge');
    assert.ok(maxPointGap(trails[0].points) < 1500);
  });

  console.log(`\n${passed} passed`);
})();
