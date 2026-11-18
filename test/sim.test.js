// Engine invariants. Run: node test/sim.test.js
'use strict';
const assert = require('assert');
const S = require('../js/sim.js');
const M = require('../js/metrics.js');

const EPS = 1e-6;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}
function sim(over) {
  return new S.Simulation(Object.assign({}, S.DEFAULTS, over));
}
function runChecked(over, onStep) {
  const s = sim(over);
  while (!s.done) {
    s.step();
    if (onStep) onStep(s);
  }
  return s.finish();
}
const inCar = (r) => r.dropoffAt - r.pickupAt;

const SCENARIOS = [
  {},
  { cabs: 10 },
  { cabs: 80 },
  { riders: 600, cabs: 40, seed: 3 },
  { maxDetour: 1.2, seed: 11 },
  { maxDetour: 2.5, poolOptIn: 100, seed: 5, pingRadius: 6 },
  { gridSize: 20, riders: 300, cabs: 15, cabSpeed: 2.5, seed: 9 },
  { pingRadius: 3, patience: 40, pickupSlip: 0 },
  { pingRadius: 200, reassign: 0, riders: 400 },
  { batchMatch: 1, riders: 400, seed: 4 },
  { batchMatch: 1, cabs: 10, maxDetour: 2, seed: 6 },
];
const ORIGINAL = S.ORIGINAL_RULES;
const NO_LIGHTS = { rightTurnDelay: 0 }; // the original city had no traffic lights
const cache = new Map();
function finished(over) {
  const key = JSON.stringify(over);
  if (!cache.has(key)) cache.set(key, runChecked(over));
  return cache.get(key);
}

console.log('PoolSim engine tests');

test('never more than 2 aboard, now or anywhere in a planned route', () => {
  for (const over of SCENARIOS) {
    runChecked(over, (s) => {
      for (const w of [s.pool, s.base]) {
        for (const c of w.cabs) {
          assert(c.onboard.length <= 2, 'aboard > 2');
          let load = c.onboard.length;
          for (const st of c.plan) {
            load += st.type === 'pickup' ? 1 : -1;
            assert(load <= 2 && load >= 0, `cab ${c.id} plan load ${load}`);
          }
          assert(c.plan.length <= S.MAX_PLAN_STOPS, 'plan too long');
        }
      }
    });
  }
});

test('every pool rider rides at most maxDetour x their solo estimate', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.pool.riders) {
      if (r.state !== 'done') continue;
      assert(inCar(r) <= s.cfg.maxDetour * r.est + EPS,
        `rider ${r.id}: ${inCar(r).toFixed(3)}s > ${s.cfg.maxDetour} x ${r.est.toFixed(3)}s`);
    }
  }
});

test('solo riders (both worlds) ride exactly their estimate and never share', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.base.riders.concat(s.pool.riders.filter((x) => !x.pool))) {
      if (r.state !== 'done') continue;
      assert(Math.abs(inCar(r) - r.est) < EPS, `rider ${r.id} solo ride ${inCar(r)} != ${r.est}`);
      assert(r.sharedSec < EPS && r.coRiders.length === 0, `solo rider ${r.id} shared`);
    }
    for (const c of s.base.cabs) assert(c.time.two < EPS, 'baseline cab carried 2');
  }
});

test('pickups honour the ping radius and the allowed slip', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const cfg = s.cfg;
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.pickupAt == null) continue;
        assert(r.pickupAt <= r.latestPickupAt + EPS, `rider ${r.id} picked up after the slip window`);
        assert(r.pickupAt - r.assignedAt <= cfg.pingRadius / cfg.cabSpeed + cfg.pickupSlip + EPS,
          `rider ${r.id} picked up from beyond the ping radius`);
        assert(r.pickupAt >= r.requestAt - EPS, `rider ${r.id} picked before request`);
        if (r.dropoffAt != null) assert(r.dropoffAt >= r.pickupAt, `rider ${r.id} dropped before pickup`);
      }
    }
  }
});

test('only unmatched riders give up, and only after their patience runs out', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.state !== 'lost') continue;
        assert(r.pickupAt == null && r.assignedAt == null, `rider ${r.id} lost after being matched`);
        assert(r.lostAt - r.requestAt >= s.cfg.patience - EPS, `rider ${r.id} gave up early`);
      }
    }
  }
  const tight = finished({ pingRadius: 3, patience: 40, pickupSlip: 0 });
  assert(tight.base.totals.lost > 0, 'a tight radius should strand some riders');
});

test('every cab-second is idle, empty, 1 aboard or 2 aboard', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const c of w.cabs) {
        const t = c.time.idle + c.time.empty + c.time.one + c.time.two;
        assert(Math.abs(t - w.t) < 1e-6, `cab ${c.id} time ${t} != ${w.t}`);
      }
    }
  }
});

test('driver pay = rate x (occupied s + X x 2-aboard s), and sums across cabs', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const X = s.cfg.driverPremium / 100;
    for (const w of [s.pool, s.base]) {
      let total = 0;
      for (const c of w.cabs) {
        // Plus any driver-guarantee top-ups, which are tracked separately.
        const expect = s.cfg.driverRate * (c.time.one + c.time.two + X * c.time.two) + c.topUp;
        assert(Math.abs(c.earnings - expect) < 1e-6, `cab ${c.id} pay mismatch`);
        total += c.earnings;
      }
      assert(Math.abs(total - w.totals.driverPay) < 1e-6, 'fleet pay mismatch');
    }
  }
});

test('flat pricing (original): pool riders pay (1 - Y) x standard fare, everyone else full fare', () => {
  const s = runChecked(Object.assign({ poolDiscount: 40 }, ORIGINAL));
  for (const w of [s.pool, s.base]) {
    for (const r of w.riders) {
      if (r.pickupAt == null) continue;
      const expect = r.fullFare * (r.pool ? 0.6 : 1);
      assert(Math.abs(r.fare - expect) < 1e-9, `rider ${r.id} fare`);
    }
  }
});

test('cabs reroute mid-ride and riders can share with more than one co-rider', () => {
  const s = finished({ riders: 600, cabs: 40, seed: 3 });
  assert(s.pool.totals.reroutes > 0, 'no mid-ride reroutes');
  const multi = s.pool.riders.filter((r) => r.coRiders.length >= 2);
  assert(multi.length > 0, 'no rider had two co-riders');
  // ...but never two at the same time: each co-rider pair overlapped one at a time.
  for (const r of multi) {
    const spans = r.coRiders.map((id) => s.pool.riders[id])
      .map((o) => [Math.max(o.pickupAt, r.pickupAt), Math.min(o.dropoffAt ?? Infinity, r.dropoffAt ?? Infinity)])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert(spans[i][0] >= spans[i - 1][1] - EPS, `rider ${r.id} had 2 co-riders at once`);
  }
});

test('re-dispatch only runs when enabled', () => {
  assert.strictEqual(finished({ pingRadius: 200, reassign: 0, riders: 400 }).pool.totals.reassigned, 0);
  // Needs free cabs to move riders to, so use default demand with no radius cap.
  assert(runChecked({ pingRadius: 200 }).base.totals.reassigned > 0, 'expected some re-dispatches');
});

test('with 0% opt-in the pool world is identical to the baseline', () => {
  const s = runChecked({ poolOptIn: 0, riders: 300 });
  assert.strictEqual(s.pool.totals.completed, s.base.totals.completed);
  assert(Math.abs(s.pool.totals.driverPay - s.base.totals.driverPay) < 1e-9);
  s.pool.riders.forEach((r, i) => assert.strictEqual(r.dropoffAt, s.base.riders[i].dropoffAt));
});

test('same seed reproduces the run exactly; another seed differs', () => {
  const a = sim({}).runToEnd(), b = sim({}).runToEnd(), c = sim({ seed: 8 }).runToEnd();
  assert.strictEqual(a.pool.totals.driverPay, b.pool.totals.driverPay);
  assert.strictEqual(a.pool.totals.completed, b.pool.totals.completed);
  assert.notStrictEqual(a.pool.totals.driverPay, c.pool.totals.driverPay);
});

test('changing the opt-in % does not move riders or cabs', () => {
  const a = S.makeScenario(S.normalizeConfig({ poolOptIn: 20 }));
  const b = S.makeScenario(S.normalizeConfig({ poolOptIn: 90 }));
  a.riders.forEach((r, i) => {
    const q = b.riders[i];
    assert(r.ox === q.ox && r.oy === q.oy && r.dx === q.dx && r.dy === q.dy && r.requestAt === q.requestAt);
  });
});

test('driver-earnings decomposition adds up to the pool-world total', () => {
  for (const over of SCENARIOS) {
    const d = M.summarize(finished(over)).drivers.steps;
    const total = d.base + d.lostToSharing + d.detourPay + d.premium + d.guarantee + d.fleet;
    assert(Math.abs(total - d.pool) < 1e-6, 'waterfall does not close');
  }
});

test('radius sweep: points cover the current radius and recommend one of them', () => {
  const cfg = S.normalizeConfig(S.DEFAULTS);
  const radii = M.sweepRadii(cfg);
  assert(radii.includes(cfg.pingRadius));
  const pts = radii.map((R) => M.sweepPoint(cfg, R, 1));
  assert(radii.includes(M.recommendRadius(pts, 'pool')));
  assert(pts[0].pool.lost > pts[pts.length - 1].pool.lost, 'tightest radius should lose more riders');
});

test('metrics survive degenerate runs (no riders, one cab)', () => {
  const s = M.summarize(sim({ riders: 0, cabs: 1 }).runToEnd());
  assert.strictEqual(s.pool.completed, 0);
  assert.strictEqual(s.passengers.matchRate, null);
});

// ------------------------------------------------------------ enhancements

const ORIGINAL_FINGERPRINTS = [{"over":{},"pool":[163,1,2416.95,1840.65,2906782,28587],"base":[157,0,2791,1848.35,2677334,27764]},{"over":{"cabs":10},"pool":[78,56,1199.55,933.8875,1090430,13956],"base":[59,63,1201.5,768.95,505913,10054]},{"over":{"cabs":80},"pool":[176,0,2698.5,2098.6875,3286284,29468],"base":[175,0,3313.5,2173.5,3218710,29421]},{"over":{"riders":600,"cabs":40,"seed":3},"pool":[338,53,5048.15,3823.4875,14148131,60895],"base":[260,63,4614,3028.9,7384743,42134]},{"over":{"maxDetour":1.2,"seed":11},"pool":[165,0,2686.6,2028.3375,3011850,29749],"base":[158,0,3101,2031.4,2806701,28507]},{"over":{"maxDetour":2.5,"poolOptIn":100,"seed":5,"pingRadius":6},"pool":[156,8,2054.5,1957.9,2937913,27761],"base":[114,31,2193,1465.45,1854879,20655]},{"over":{"gridSize":20,"riders":300,"cabs":15,"cabSpeed":2.5,"seed":9},"pool":[292,0,671.16,556.465,8492152.8,43995.2],"base":[291,0,813.6,564.62,8403245.4,44038.6]},{"over":{"pingRadius":3,"patience":40,"pickupSlip":0},"pool":[48,126,725.65,606.1125,732987,7406],"base":[35,139,726,484.4,487294,5569]},{"over":{"pingRadius":200,"reassign":0,"riders":400},"pool":[190,22,2606.2,2035.1625,3737501,26999],"base":[133,80,2243,1523.55,1921154,20771]}];
function fingerprint(w) {
  let d = 0, p = 0;
  w.riders.forEach((r) => {
    if (r.dropoffAt != null) d += r.dropoffAt * (r.id + 1);
    if (r.pickupAt != null) p += r.pickupAt;
  });
  return [w.totals.completed, w.totals.lost, +w.totals.revenue.toFixed(6), +w.totals.driverPay.toFixed(6), +d.toFixed(4), +p.toFixed(4)];
}

test('regression: "Original rules" with no traffic lights reproduce the original engine exactly (9 cities, both worlds)', () => {
  for (const ref of ORIGINAL_FINGERPRINTS) {
    const s = sim(Object.assign({}, ref.over, ORIGINAL, NO_LIGHTS)).runToEnd();
    assert.deepStrictEqual(fingerprint(s.pool), ref.pool, 'pool world differs for ' + JSON.stringify(ref.over));
    assert.deepStrictEqual(fingerprint(s.base), ref.base, 'no-pool world differs for ' + JSON.stringify(ref.over));
  }
});

test('the no-pool world is untouched by fair pricing and the driver guarantee', () => {
  for (const ref of ORIGINAL_FINGERPRINTS) {
    const s = sim(Object.assign({}, ref.over, NO_LIGHTS)).runToEnd(); // enhanced rules, no lights
    assert.deepStrictEqual(fingerprint(s.base), ref.base, JSON.stringify(ref.over));
    assert.strictEqual(s.base.totals.topUp, 0);
  }
});

// A city built by hand: one cab at (0, 0), riders on a straight street.
function handCity(riders, over) {
  const cfg = S.normalizeConfig(Object.assign({ cabs: 1, riders: 0, duration: 120, pingRadius: 100, rightTurnDelay: 0 }, over));
  const scenario = {
    cabs: [{ x: 0, y: 0 }],
    riders: riders.map((r, i) => Object.assign({ id: i, optIn: true }, r)),
  };
  const w = new S.World(cfg, scenario, true);
  while (w.t < cfg.duration - EPS) {
    w.step();
    assert(w.cabs[0].onboard.length <= 2, 'more than 2 aboard');
  }
  return w;
}

test('compatible pair on the way: shared, nobody delayed, exact fares and driver parity', () => {
  // A rides (0,0)->(20,0); B asks at t=1 for (3,0)->(17,0), entirely on A's way.
  const w = handCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 },
    { requestAt: 1, ox: 3, oy: 0, dx: 17, dy: 0 },
  ]);
  const [A, B] = w.riders, cfg = w.cfg;
  assert(A.state === 'done' && B.state === 'done');
  assert.deepStrictEqual(A.coRiders, [1]);
  assert(Math.abs(A.sharedSec - 14) < 1e-6 && Math.abs(B.sharedSec - 14) < 1e-6, 'shared 14 s');
  assert(Math.abs(inCar(A) - A.est) < 1e-6 && Math.abs(inCar(B) - B.est) < 1e-6, 'no detour');
  // Fair pricing: both shared, no detour -> exactly (1 - Y).
  for (const r of [A, B]) assert(Math.abs(r.fare - r.fullFare * (1 - cfg.poolDiscount / 100)) < 1e-9);
  // Driver: paid 20 s + X x 14 s; solo parity is 20 s + 14 s. Top-up covers the gap.
  const ep = w.episodes[0];
  assert(Math.abs(ep.pay - cfg.driverRate * (20 + cfg.driverPremium / 100 * 14)) < 1e-6, 'pay');
  assert(Math.abs(ep.parity - cfg.driverRate * 34) < 1e-6, 'parity');
  assert(Math.abs(ep.parityTop - (ep.parity - ep.pay)) < 1e-6 && ep.net >= 0);
});

test('incompatible pair (B heads the other way): never shares, served after A instead', () => {
  const w = handCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 },
    { requestAt: 1, ox: 3, oy: 0, dx: 3, dy: 40 },
  ]);
  const [A, B] = w.riders;
  assert(A.sharedSec < EPS && B.sharedSec < EPS, 'they should not share');
  assert(B.pickupAt >= A.dropoffAt - EPS, 'B picked up only after A got out');
  // Never shared: fair pricing charges the no-match discount Y0, not Y.
  assert(Math.abs(B.fare - B.fullFare * (1 - w.cfg.requestDiscount / 100)) < 1e-9);
  // Original flat pricing gives the full Y to the same unmatched rider.
  const f = handCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 },
    { requestAt: 1, ox: 3, oy: 0, dx: 3, dy: 40 },
  ], ORIGINAL).riders[1];
  assert(Math.abs(f.fare - f.fullFare * (1 - w.cfg.poolDiscount / 100)) < 1e-9);
});

test('three riders on one street: never a third passenger, shares one at a time', () => {
  const w = handCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 30, dy: 0 },
    { requestAt: 0.5, ox: 2, oy: 0, dx: 28, dy: 0 },
    { requestAt: 1, ox: 4, oy: 0, dx: 26, dy: 0 },
  ], { duration: 200 });
  const [A, B, C] = w.riders;
  assert(A.coRiders.length && B.coRiders.length, 'A and B share');
  // handCity already checks <= 2 aboard every step; also check at each boarding instant.
  const aboardAt = (t) => w.riders.filter((r) => r.pickupAt != null && r.pickupAt <= t + EPS
    && (r.dropoffAt == null || r.dropoffAt > t + EPS)).length;
  for (const r of [A, B, C]) if (r.pickupAt != null) assert(aboardAt(r.pickupAt) <= 2, `third passenger at ${r.pickupAt}`);
});

test('driver guarantee: no settled pooled ride leaves its driver below $0 or below solo parity', () => {
  const harsh = { driverRate: 0.1, costPerBlock: 0.12, pingRadius: 40 };
  for (const over of SCENARIOS.concat([harsh])) {
    const s = finished(over);
    for (const e of s.pool.episodes) {
      if (!e.pooled) {
        assert.strictEqual(e.parityTop + e.floorTop, 0, 'top-up on a ride with no pool rider');
        continue;
      }
      assert(e.net >= -1e-9, `pooled ride net ${e.net}`);
      assert(e.pay + e.parityTop + e.floorTop >= e.parity - 1e-9, 'below solo parity');
    }
    const sumTop = s.pool.cabs.reduce((a, c) => a + c.topUp, 0);
    assert(Math.abs(sumTop - s.pool.totals.topUp) < 1e-9, 'top-ups do not add up');
  }
  // The guarantee is doing real work: without it the harsh city loses money on pooled rides.
  const off = runChecked(Object.assign({}, harsh, { driverFloor: 0, parityFloor: 0 }));
  assert(off.pool.episodes.some((e) => e.pooled && e.net < 0), 'expected losing pooled rides without the guarantee');
  const g = M.summarize(finished(harsh)).guarantee;
  assert(g.belowZeroBefore > 0 && g.belowZero === 0 && g.floorTopUp > 0);
});

test('fair pricing: Y only if shared, Y0 otherwise, minus a detour credit; revenue adds up', () => {
  for (const over of SCENARIOS) {
    const s = finished(over), cfg = s.cfg, w = s.pool;
    let revenue = 0;
    for (const r of w.riders) {
      if (r.pickupAt == null) continue;
      revenue += r.fare;
      assert(r.fare >= -1e-12 && r.fare <= r.fullFare + 1e-12, 'fare out of range');
      if (!r.pool) { assert(Math.abs(r.fare - r.fullFare) < 1e-9); continue; }
      if (r.state !== 'done') {
        assert(Math.abs(r.fare - r.fullFare * (1 - cfg.requestDiscount / 100)) < 1e-9, 'riding: charged Y0 so far');
        continue;
      }
      const y = r.sharedSec > EPS ? cfg.poolDiscount : cfg.requestDiscount;
      const extra = inCar(r) - r.est;
      const credit = extra > EPS ? Math.min(r.fullFare * (1 - y / 100), cfg.fareRate * cfg.detourCredit / 100 * extra) : 0;
      assert(Math.abs(r.fare - (r.fullFare * (1 - y / 100) - credit)) < 1e-9, `rider ${r.id} fare`);
    }
    assert(Math.abs(revenue - w.totals.revenue) < 1e-6, 'revenue does not add up');
  }
});

test('fair pricing compensates whoever absorbed the detour (rider aboard vs rider joining)', () => {
  const f = M.summarize(finished({ riders: 600, cabs: 40, seed: 3 })).passengers.fairness;
  assert(f.hostExtra > f.joinerExtra, 'riders already aboard absorb more detour');
  assert(f.hostSaved > f.joinerSaved, 'and now save more for it');
});

test('invalid inputs are clamped by the engine itself', () => {
  const c = S.normalizeConfig({ poolDiscount: 150, requestDiscount: 200, poolOptIn: -5, driverPremium: -10,
    fareRate: -1, driverRate: 'abc', costPerBlock: -0.2, detourCredit: 500, cabs: 0, riders: -3, gridSize: 2 });
  assert.strictEqual(c.poolDiscount, 100);
  assert.strictEqual(c.requestDiscount, 100);
  assert.strictEqual(c.poolOptIn, 0);
  assert.strictEqual(c.driverPremium, 0);
  assert.strictEqual(c.fareRate, 0);
  assert.strictEqual(c.driverRate, S.DEFAULTS.driverRate);
  assert.strictEqual(c.costPerBlock, 0);
  assert.strictEqual(c.detourCredit, 100);
  assert(c.cabs === 1 && c.riders === 0 && c.gridSize === 10);
  assert.strictEqual(S.normalizeConfig({ poolDiscount: 5, requestDiscount: 20 }).requestDiscount, 5, 'Y0 <= Y');
  const s = runChecked({ poolDiscount: 100, riders: 100, fairPricing: 1 });
  s.pool.riders.forEach((r) => assert(r.fare >= -1e-12, 'negative fare'));
});

test('radius sweep: a metric with no data stays empty instead of averaging in zeros', () => {
  const pt = M.sweepPoint(S.normalizeConfig({ riders: 1, cabs: 1, duration: 30 }), 2, 3);
  assert.strictEqual(pt.pool.avgWait, null);
});

test('scorecard runs a city to a given time (for the original-vs-enhanced panel)', () => {
  const full = M.scorecardAt(S.DEFAULTS);
  assert.strictEqual(full.completed, M.summarize(sim({}).runToEnd()).pool.completed);
  const half = M.scorecardAt(S.DEFAULTS, 150);
  assert(half.completed < full.completed);
});

// ------------------------------------------------------------ threat zone

// Safety rules that must hold at every step while a zone is active.
function checkZone(w) {
  for (const c of w.cabs) {
    assert(c.onboard.length <= 2, 'more than 2 aboard');
    if (!w.zone) continue;
    if (c.next && w.blocked(c.next.x, c.next.y)) assert(c.evac, `cab ${c.id} driving into the zone`);
    if (!c.next && w.blocked(c.x, c.y)) assert(c.evac, `cab ${c.id} parked inside the zone`);
    for (const st of c.plan) assert(!w.blocked(st.x, st.y), `cab ${c.id} plans a stop inside the zone`);
  }
}

// A hand-built city with zone events: [{ t, x, y }] declares, [{ t, x, y, remove: true }] lifts the
// zone covering (x, y), [{ t, clear: true }] lifts them all.
function zoneCity(riders, over, events, cabs) {
  const cfg = S.normalizeConfig(Object.assign({ cabs: 1, riders: 0, duration: 120, pingRadius: 100, zoneRadius: 2, rightTurnDelay: 0 }, over));
  const w = new S.World(cfg, { cabs: cabs || [{ x: 0, y: 0 }], riders: riders.map((r, i) => Object.assign({ id: i, optIn: true }, r)) }, true);
  const evs = (events || []).slice();
  while (w.t < cfg.duration - EPS) {
    while (evs.length && evs[0].t <= w.t + EPS) {
      const e = evs.shift();
      if (e.clear) w.clearZone();
      else if (e.remove) w.removeZone(w.zoneAt(e.x, e.y).id);
      else w.declareZone(e.x, e.y);
    }
    w.step();
    checkZone(w);
  }
  return w;
}

test('zone: with no zone ever declared, nothing changes (covered by the regression fingerprints)', () => {
  const s = sim({}).runToEnd();
  assert.strictEqual(s.pool.totals.cancelled, 0);
  assert.strictEqual(s.pool.zone, null);
});

test('zone: declared where no cab is nearby -> no evacuations; only trips into it are refused', () => {
  const sc = S.makeScenario(S.normalizeConfig(S.DEFAULTS));
  let spot = null;
  for (let y = 0; y < 50 && !spot; y++) for (let x = 0; x < 50 && !spot; x++) {
    if (sc.cabs.every((c) => Math.hypot(c.x - x, c.y - y) > 9)) spot = { x, y };
  }
  assert(spot, 'found an empty spot');
  const s = sim({ zoneRadius: 4 });
  s.declareZone(spot.x, spot.y);
  while (!s.done) { s.step(); checkZone(s.pool); checkZone(s.base); }
  assert.strictEqual(s.pool.totals.zoneEvacuated, 0);
  for (const r of s.pool.riders) {
    if (r.state !== 'cancelled') continue;
    assert.strictEqual(r.cancelKind, 'refused');
    const inside = (x, y) => Math.hypot(x - spot.x, y - spot.y) <= 4 + EPS;
    assert(inside(r.ox, r.oy) || inside(r.dx, r.dy) || r.cancelReason.startsWith('no route'), `rider ${r.id} refused for no reason`);
  }
});

test('zone: declared around a cab -> it drives out, takes no work until out, then serves', () => {
  const w = zoneCity([{ requestAt: 1, ox: 10, oy: 10, dx: 20, dy: 10 }], {}, [{ t: 0, x: 1, y: 0 }]);
  assert.strictEqual(w.totals.zoneEvacuated, 1);
  assert.strictEqual(w.riders[0].state, 'done');
  assert(w.riders[0].assignedAt >= 1 - EPS);
});

test('zone: declared across an active route -> rerouted around it, planned time = actual time', () => {
  // A rides (0,0)->(20,0). At t=2 a zone of radius 2 closes (8..12, 0): the way round is 6 blocks longer.
  const w = zoneCity([{ requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }], {}, [{ t: 2, x: 10, y: 0 }]);
  const A = w.riders[0];
  assert.strictEqual(A.state, 'done');
  assert(Math.abs(inCar(A) - 26) < 1e-6, `in car ${inCar(A)} s, expected 26`);
  assert.strictEqual(w.totals.zoneRerouted, 1);
  assert(A.dropDeadline == null, '26 s is within 1.5 x 20 s, no exception needed');
  // Fair pricing credits the 6 s detour.
  const expect = A.fullFare * (1 - w.cfg.requestDiscount / 100) - w.cfg.fareRate * w.cfg.detourCredit / 100 * 6;
  assert(Math.abs(A.fare - expect) < 1e-9);
});

test('zone: over a pickup -> that ride is cancelled, never charged, cab freed', () => {
  const w = zoneCity([{ requestAt: 0, ox: 15, oy: 0, dx: 15, dy: 20 }], {}, [{ t: 3, x: 15, y: 0 }]);
  const A = w.riders[0];
  assert.strictEqual(A.state, 'cancelled');
  assert.strictEqual(A.cancelReason, 'pickup inside the threat zone');
  assert.strictEqual(A.fare, 0);
  assert.strictEqual(w.cabs[0].riders.length, 0);
  assert.strictEqual(w.totals.revenue, 0);
});

test('zone: over the destination of a rider aboard -> dropped at the nearest safe point, pays for distance covered', () => {
  const w = zoneCity([{ requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }], {}, [{ t: 5, x: 20, y: 0 }]);
  const A = w.riders[0];
  assert.strictEqual(A.state, 'done');
  assert.deepStrictEqual(A.earlyDrop, { x: 17, y: 0 });
  const covered = 1 - 3 / 20;
  assert(Math.abs(A.fare - A.fullFare * (1 - w.cfg.requestDiscount / 100) * covered) < 1e-9, 'prorated fare');
  assert(Math.abs(w.totals.revenue - A.fare) < 1e-9);
});

test('zone: cleared again -> the dropped-short rider is taken all the way after all', () => {
  const w = zoneCity([{ requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }], {}, [{ t: 5, x: 20, y: 0 }, { t: 8, clear: true }]);
  const A = w.riders[0];
  assert.strictEqual(A.earlyDrop, null);
  assert(Math.abs(A.dropoffAt - 20) < 1e-6);
});

test('zone: hits a pooled ride -> both riders still delivered, two at most, both rerouted', () => {
  const w = zoneCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 },
    { requestAt: 1, ox: 3, oy: 0, dx: 17, dy: 0 },
  ], {}, [{ t: 5, x: 10, y: 0 }]);
  const [A, B] = w.riders;
  assert(A.state === 'done' && B.state === 'done');
  assert(A.sharedSec > 0 && B.sharedSec > 0, 'still shared');
  assert(A.reroutes >= 1 && B.reroutes >= 1);
  assert(Math.abs(inCar(A) - 26) < 1e-6 && Math.abs(inCar(B) - 20) < 1e-6, 'both took the 6-block detour');
});

test('zone: a promised pickup that can no longer be kept -> rider back in the queue, patience restarted', () => {
  // The way round a radius-10 zone adds 22 s, more than the 20 s pickup slip.
  const w = zoneCity([{ requestAt: 0, ox: 30, oy: 0, dx: 30, dy: 30 }], { zoneRadius: 10, duration: 200 }, [{ t: 1, x: 15, y: 0 }]);
  const A = w.riders[0];
  assert.strictEqual(A.requeued, 1);
  assert(Math.abs(A.queuedAt - 1) < 1e-6, 'patience clock restarted at the declaration');
  assert.strictEqual(A.state, 'done', 'rematched and delivered');
  assert(A.pickupAt <= A.latestPickupAt + EPS);
});

test('zone: no feasible route -> rider aboard is dropped at the closest point the cab can reach; new trips refused', () => {
  // On a 20 x 20 grid a radius-3 zone at (3,3) cuts off the corner around (0,0).
  const w = zoneCity([
    { requestAt: 0, ox: 0, oy: 0, dx: 10, dy: 10 },
    { requestAt: 2, ox: 8, oy: 8, dx: 0, dy: 0 },
  ], { gridSize: 20, zoneRadius: 3, duration: 60 }, [{ t: 0.5, x: 3, y: 3 }]);
  const [A, B] = w.riders;
  assert.strictEqual(A.state, 'done');
  assert.deepStrictEqual(A.earlyDrop, { x: 2, y: 0 });
  assert(Math.abs(A.fare - A.fullFare * (1 - w.cfg.requestDiscount / 100) * (1 - 18 / 20)) < 1e-9);
  assert.strictEqual(B.state, 'cancelled');
  assert.strictEqual(B.cancelKind, 'refused');
  assert.strictEqual(B.cancelReason, 'no route around the threat zone');
});

test('zone: many requests at once in a busy city -> safety rules hold every step, every rider accounted for', () => {
  for (const over of [{}, { batchMatch: 1, riders: 400 }, { zoneRadius: 12, cabs: 15 }]) {
    const s = sim(over);
    let declared = false;
    while (!s.done) {
      if (!declared && s.t >= 100 - EPS) { s.declareZone(25, 25); declared = true; }
      s.step();
      checkZone(s.pool); checkZone(s.base);
    }
    for (const w of [s.pool, s.base]) {
      const T = w.totals;
      assert(T.zoneCancelled + T.zoneRefused === T.cancelled);
      const counts = {};
      w.riders.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });
      assert.strictEqual((counts.cancelled || 0), T.cancelled);
      assert.strictEqual(T.requested, T.pickedUp + T.lost + T.cancelled + w.queue.length
        + w.riders.filter((r) => r.state === 'assigned').length, 'every request accounted for');
      for (const r of w.riders) if (r.state === 'done' && !r.earlyDrop) {
        assert(r.dropoffAt - r.pickupAt <= s.cfg.maxDetour * r.capBase + EPS || r.dropDeadline != null, `rider ${r.id} over the cap`);
        if (r.dropDeadline != null) assert(r.dropoffAt <= r.dropDeadline + EPS, 'emergency deadline broken');
      }
      for (const e of w.episodes) if (e.pooled) assert(e.net >= -1e-9, 'driver guarantee broken under the zone');
    }
  }
});

test('zone: the comparison re-run replays the zone exactly', () => {
  const s = sim({});
  while (!s.done) {
    if (Math.abs(s.t - 80) < 1e-6) s.declareZone(20, 20);
    if (Math.abs(s.t - 200) < 1e-6) s.clearZone();
    s.step();
  }
  const live = M.scorecard(M.summarize(s));
  const replay = M.scorecardAt(S.DEFAULTS, s.t, s.zoneEvents);
  assert.deepStrictEqual(replay, live);
});

test('zones: several at once -> every one is closed and avoided; lifting one reopens only its area', () => {
  const s = sim({ zoneRadius: 5 });
  let phase = 0;
  while (!s.done) {
    if (phase === 0 && s.t >= 60 - EPS) { s.declareZone(12, 12); s.declareZone(37, 37); s.declareZone(12, 37); phase = 1; }
    if (phase === 1 && s.t >= 150 - EPS) { assert(s.removeZoneAt(37, 37)); phase = 2; }
    s.step();
    checkZone(s.pool); checkZone(s.base);
    if (phase === 1) for (const [x, y] of [[12, 12], [37, 37], [12, 37]]) assert(s.pool.blocked(x, y) && s.base.blocked(x, y));
    if (phase === 2) {
      assert(!s.pool.blocked(37, 37), 'lifted zone reopened');
      assert(s.pool.blocked(12, 12) && s.pool.blocked(12, 37), 'the other zones stay closed');
    }
  }
  assert.strictEqual(s.pool.zone.list.length, 2);
  assert.strictEqual(s.pool.zoneHistory.filter((h) => h.clearedAt != null).length, 1);
  assert(!s.removeZoneAt(37, 37), 'nothing left to lift there');
});

test('zones: overlapping -> lifting one keeps the shared area closed while the other covers it', () => {
  const w = zoneCity([], { zoneRadius: 3, duration: 5 }, [{ t: 0, x: 20, y: 20 }, { t: 0, x: 23, y: 20 }, { t: 1, x: 20, y: 20, remove: true }]);
  assert(w.blocked(22, 20), 'still covered by the second zone');
  assert(!w.blocked(18, 20), 'only the first zone covered this');
  assert.strictEqual(w.zone.list.length, 1);
});

test('zones: a rider dropped short goes all the way only when the zone over their destination is lifted', () => {
  // Destination (20,0) is under zone A; zone B at (5,30) has nothing to do with it.
  const keep = zoneCity([{ requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }], {}, [{ t: 5, x: 20, y: 0 }, { t: 5, x: 5, y: 30 }, { t: 8, x: 5, y: 30, remove: true }]);
  assert.deepStrictEqual(keep.riders[0].earlyDrop, { x: 17, y: 0 }, 'lifting the other zone changes nothing');
  const go = zoneCity([{ requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }], {}, [{ t: 5, x: 20, y: 0 }, { t: 5, x: 5, y: 30 }, { t: 8, x: 20, y: 0, remove: true }]);
  assert.strictEqual(go.riders[0].earlyDrop, null);
  assert(Math.abs(go.riders[0].dropoffAt - 20) < 1e-6);
});

test('zones: the comparison re-run replays adds and removals exactly', () => {
  const s = sim({});
  while (!s.done) {
    if (Math.abs(s.t - 60) < 1e-6) { s.declareZone(15, 15); s.declareZone(35, 35); }
    if (Math.abs(s.t - 120) < 1e-6) s.removeZoneAt(15, 15);
    if (Math.abs(s.t - 180) < 1e-6) s.declareZone(25, 10);
    s.step();
  }
  assert.deepStrictEqual(M.scorecardAt(S.DEFAULTS, s.t, s.zoneEvents), M.scorecard(M.summarize(s)));
});

// ------------------------------------------------------------ traffic lights

const LIGHTS = { rightTurnDelay: 4 }; // right turn +4 s, left +3 s, U-turn +5 s, straight free

test('lights: a left turn costs 75% of a right, a U-turn 125%, straight nothing; leaving a stop is free', () => {
  const w = new S.World(S.normalizeConfig(Object.assign({ cabs: 1, riders: 0 }, LIGHTS)), { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
  // headings: 0 east, 1 south, 2 west, 3 north; clockwise on screen = right
  assert.strictEqual(w.turnCost(0, 0), 0);
  assert.strictEqual(w.turnCost(0, 1), 4);   // east -> south: right
  assert.strictEqual(w.turnCost(0, 3), 3);   // east -> north: left
  assert.strictEqual(w.turnCost(0, 2), 5);   // U-turn
  assert.strictEqual(w.turnCost(-1, 2), 0);  // standing start
  assert.strictEqual(S.LEFT_FACTOR, 0.75);
});

test('lights: the fastest route between two points picks the left turn over the original right turn', () => {
  const w = new S.World(S.normalizeConfig(Object.assign({ cabs: 1, riders: 0 }, LIGHTS)), { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
  const chosen = w.describeRoute(10, 10, -1, 15, 15, -1);
  const xFirst = w.describeXFirst(10, 10, -1, 15, 15);
  assert.deepStrictEqual([chosen.blocks, chosen.lefts, chosen.rights, chosen.turnTime, chosen.time], [10, 1, 0, 3, 13]);
  assert.deepStrictEqual([xFirst.blocks, xFirst.lefts, xFirst.rights, xFirst.turnTime, xFirst.time], [10, 0, 1, 4, 14]);
});

test('lights: driving east with the target directly behind -> no U-turn, a loop of three lefts (14 s, not 17 s)', () => {
  const w = new S.World(S.normalizeConfig(Object.assign({ cabs: 1, riders: 0 }, LIGHTS)), { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
  const r = w.describeRoute(10, 10, 0, 7, 10);
  assert.deepStrictEqual([r.blocks, r.lefts, r.rights, r.uturns, r.time], [5, 3, 0, 0, 14]);
});

test('lights: the closed-form open-grid times equal the full route search, for every state', () => {
  for (const over of [{ gridSize: 10 }, { gridSize: 10, cabSpeed: 2.5, rightTurnDelay: 7 }, { gridSize: 12, cabSpeed: 0.5, rightTurnDelay: 1 }]) {
    const cfg = S.normalizeConfig(Object.assign({ cabs: 1, riders: 0 }, LIGHTS, over)), G = cfg.gridSize;
    const w = new S.World(cfg, { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
    for (let ty = 0; ty < G; ty++) for (let tx = 0; tx < G; tx++) {
      const T = w.timeField(tx, ty);
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) for (let h = 0; h < 4; h++) {
        assert(Math.abs(T[(x + y * G) * 4 + h] - w.openTime(x, y, h, tx, ty)) < 1e-9, `(${x},${y},${h}) -> (${tx},${ty})`);
      }
    }
  }
});

test('lights: on this grid a longer route is never faster (every state, every target)', () => {
  // Fastest route vs the shortest legal route (same move rules, near-zero light delays).
  const G = 12;
  const fast = new S.World(S.normalizeConfig(Object.assign({ gridSize: G, cabs: 1, riders: 0 }, LIGHTS)), { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
  const short = new S.World(S.normalizeConfig({ gridSize: G, cabs: 1, riders: 0, rightTurnDelay: 1e-6 }), { cabs: [{ x: 0, y: 0 }], riders: [] }, true);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) for (let h = -1; h < 4; h++) for (let ty = 0; ty < G; ty += 3) for (let tx = 0; tx < G; tx += 3) {
    if (x === tx && y === ty) continue;
    assert.strictEqual(fast.describeRoute(x, y, h, tx, ty).blocks, short.describeRoute(x, y, h, tx, ty).blocks);
  }
});

test('lights: a cab really waits at the light, and arrives exactly when planned', () => {
  // Rider (0,0) -> (5,5): south then east is one left (3 s): 10 + 3 = 13 s, the quoted estimate.
  const w = handCity([{ requestAt: 0, ox: 0, oy: 0, dx: 5, dy: 5 }], LIGHTS);
  const A = w.riders[0];
  assert(Math.abs(A.est - 13) < 1e-9);
  assert(Math.abs(inCar(A) - 13) < 1e-6, `in car ${inCar(A)}`);
  assert.deepStrictEqual([w.totals.leftTurns, w.totals.rightTurns], [1, 0]);
  assert(Math.abs(w.totals.turnWait - 3) < 1e-6);
  assert(Math.abs(A.fullFare - 13 * w.cfg.fareRate) < 1e-9, 'fare quoted on the time including the light');
});

test('lights: planned drop-off times equal actual ones in a busy city (pooling, rerouting, re-dispatch)', () => {
  for (const over of [LIGHTS, Object.assign({ riders: 400, cabs: 40, seed: 3 }, LIGHTS), Object.assign({ batchMatch: 1 }, LIGHTS)]) {
    const s = sim(over), planned = new Map();
    while (!s.done) {
      s.step();
      for (const c of s.pool.cabs) {
        if (!c.onboard.length) continue;
        const res = s.pool.evalPlan(c, c.plan, null, false);
        for (const r of c.onboard) planned.set(r.id, res.drops[r.id]);
      }
    }
    for (const r of s.pool.riders) {
      if (r.state === 'done' && planned.has(r.id)) assert(Math.abs(r.dropoffAt - planned.get(r.id)) < 1e-6, `rider ${r.id}`);
    }
  }
});

test('lights: with a threat zone, routes still avoid it, and planned time = actual time', () => {
  let plannedDrop = null;
  const cfg = S.normalizeConfig(Object.assign({ cabs: 1, riders: 0, duration: 120, pingRadius: 100, zoneRadius: 2 }, LIGHTS));
  const w = new S.World(cfg, { cabs: [{ x: 0, y: 0 }], riders: [{ id: 0, optIn: true, requestAt: 0, ox: 0, oy: 0, dx: 20, dy: 0 }] }, true);
  while (w.t < cfg.duration - EPS) {
    if (Math.abs(w.t - 2) < 1e-6) {
      w.declareZone(10, 0);
      plannedDrop = w.evalPlan(w.cabs[0], w.cabs[0].plan, null, false).drops[0];
    }
    w.step();
    checkZone(w);
  }
  const A = w.riders[0];
  assert.strictEqual(A.state, 'done');
  assert(Math.abs(A.dropoffAt - plannedDrop) < 1e-6, `dropped at ${A.dropoffAt}, planned ${plannedDrop}`);
  assert(w.totals.leftTurns + w.totals.rightTurns >= 2, 'turned round the zone');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
