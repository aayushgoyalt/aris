/*
 * PoolSim engine — pure simulation, no DOM.
 *
 * Two "twin" worlds are built from one scenario (same riders, same request
 * times, same cab start positions). One world allows pooling, the other
 * serves everyone solo. Comparing them isolates the effect of Pool.
 *
 * Model
 *  - City: G x G intersections, Manhattan metric. Cabs move one edge at a
 *    time and only turn at intersections, so a planned stop time is exactly
 *    the realised time (no traffic noise).
 *  - Requests arrive at random times over the whole run. A rider's "original
 *    estimate" is the solo in-car time: manhattan(origin, destination) / speed.
 *  - Each cab has a plan: an ordered list of pickups and drop-offs. A new pool
 *    request may be inserted anywhere in a pool cab's plan (the cab reroutes),
 *    so one rider can share with several co-riders over a single trip.
 *  - Hard rules checked on every insertion, for every rider in the plan:
 *      * never more than 2 riders aboard at any point of the plan;
 *      * a pool rider's in-car time <= maxDetour x their estimate;
 *      * an assigned rider's pickup slips at most pickupSlip seconds past
 *        the time they were promised;
 *      * the new rider's pickup is within pingRadius blocks of driving.
 *  - Unmatched riders give up after `patience` seconds.
 *  - Optional re-dispatch: an assigned rider still waiting for pickup is moved
 *    to a free cab that can reach them much sooner.
 *  - Driver pay: driverRate per occupied second, x(1 + X) while 2 are aboard.
 *    Driving to a pickup is unpaid. Running cost accrues per block driven.
 *  - Rider fare: fareRate x estimate. Original ("flat") pricing: x(1 - Y) for
 *    pool opt-ins, charged at pickup whether or not a co-rider is ever found.
 *    Fair pricing (default): an opt-in is charged x(1 - Y0) at pickup; at
 *    drop-off the fare settles to x(1 - Y) if they actually shared, minus a
 *    credit for every extra second their detour cost them.
 *  - Driver guarantee (default on): a busy stretch that carried a pool rider
 *    is settled when the cab goes idle. The platform tops the driver up so
 *    they earn at least what the same riders would have paid solo (parity)
 *    and never end below $0 after running costs (floor).
 *  - Matching: oldest request first (original), or optionally batch matching:
 *    cheapest rider-cab pair across the queue first, with an age priority.
 *  - Threat zone: a circle of fixed radius declared at any intersection while
 *    the city runs. Every intersection inside it is closed. While it is active,
 *    all distances are real driving distances around it (breadth-first search
 *    on the open grid), cabs inside drive out, impossible trips are cancelled
 *    or refused, riders headed into it are dropped at the nearest safe point,
 *    and plans that no longer fit are re-checked. With no zone, nothing changes.
 */
// Wrapped in a named factory so app.js can also boot it inside a Web Worker.
function definePoolSim(root) {
  'use strict';

  var DEFAULTS = {
    gridSize: 50,       // intersections per side
    riders: 200,        // K
    cabs: 30,           // N
    duration: 300,      // P, simulated seconds
    poolOptIn: 60,      // % of riders who opt in to Pool
    maxDetour: 1.5,     // max in-car time / original estimate
    driverPremium: 25,  // X, % extra per second while 2 riders are aboard
    poolDiscount: 30,   // Y, % off the standard fare for opting in
    pingRadius: 15,     // blocks of driving from a cab to a pickup
    patience: 120,      // seconds a rider waits unmatched before giving up
    pickupSlip: 20,     // seconds a promised pickup may slip when a cab reroutes
    reassign: 1,        // 1 = move waiting riders to a cab that frees up closer
    cabSpeed: 1,        // blocks per second
    fareRate: 0.5,      // $ per second of original estimate
    driverRate: 0.35,   // $ per occupied second
    costPerBlock: 0.05, // driver's running cost, $ per block driven
    seed: 7,
    // Enhancements. ORIGINAL_RULES switches all of them off.
    fairPricing: 1,      // 1 = pool discount settles at drop-off by what the rider actually got
    requestDiscount: 10, // Y0, % off for a pool opt-in who never shares (fair pricing)
    detourCredit: 50,    // % of the fare rate credited per extra in-car second (fair pricing)
    driverFloor: 1,      // 1 = a pooled ride never leaves its driver below $0 after running costs
    parityFloor: 1,      // 1 = a pooled ride pays at least what the same riders pay the driver solo
    batchMatch: 0,       // 1 = cheapest rider-cab pairs across the queue first (with age priority)
    zoneRadius: 6,       // radius (blocks) of a threat zone declared by clicking the map
  };

  // The rules exactly as the original simulation implemented them.
  var ORIGINAL_RULES = { fairPricing: 0, driverFloor: 0, parityFloor: 0, batchMatch: 0 };

  var DT = 0.1;               // simulation step, seconds
  var DISPATCH_EVERY = 1;     // matching batch interval, seconds
  var MIN_TRIP_BLOCKS = 3;
  var MAX_PLAN_STOPS = 6;     // pending stops a cab may hold
  var VEHICLE_WEIGHT = 0.5;   // value of a cab-second relative to a rider-second
  var MAX_QUEUE_SCAN = 250;   // riders considered per dispatch batch (oldest first)
  var REASSIGN_MIN_GAIN = 8;  // seconds of pickup a re-dispatch must save...
  var REASSIGN_MIN_RATIO = 0.7; // ...and the new ETA must be <= 70% of the old
  var AGE_WEIGHT = 2;         // batch matching: priority (rider-seconds) for time already waited
  var EPS = 1e-6;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function manhattan(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function normalizeConfig(input) {
    var cfg = {};
    for (var k in DEFAULTS) {
      var v = input && input[k] != null ? Number(input[k]) : DEFAULTS[k];
      cfg[k] = isFinite(v) ? v : DEFAULTS[k];
    }
    cfg.gridSize = Math.max(10, Math.round(cfg.gridSize));
    cfg.riders = Math.max(0, Math.round(cfg.riders));
    cfg.cabs = Math.max(1, Math.round(cfg.cabs));
    cfg.duration = Math.max(1, cfg.duration);
    cfg.maxDetour = Math.max(1, cfg.maxDetour);
    cfg.pingRadius = Math.max(1, cfg.pingRadius);
    cfg.patience = Math.max(1, cfg.patience);
    cfg.pickupSlip = Math.max(0, cfg.pickupSlip);
    cfg.reassign = cfg.reassign ? 1 : 0;
    cfg.cabSpeed = Math.max(0.1, cfg.cabSpeed);
    cfg.seed = Math.round(cfg.seed) >>> 0;
    // Money and percentages: never negative, never more than 100% off.
    cfg.poolOptIn = clamp(cfg.poolOptIn, 0, 100);
    cfg.driverPremium = Math.max(0, cfg.driverPremium);
    cfg.poolDiscount = clamp(cfg.poolDiscount, 0, 100);
    cfg.requestDiscount = clamp(cfg.requestDiscount, 0, cfg.poolDiscount);
    cfg.detourCredit = clamp(cfg.detourCredit, 0, 100);
    cfg.fareRate = Math.max(0, cfg.fareRate);
    cfg.driverRate = Math.max(0, cfg.driverRate);
    cfg.costPerBlock = Math.max(0, cfg.costPerBlock);
    cfg.zoneRadius = clamp(cfg.zoneRadius, 1, cfg.gridSize);
    ['fairPricing', 'driverFloor', 'parityFloor', 'batchMatch'].forEach(function (k) { cfg[k] = cfg[k] ? 1 : 0; });
    return cfg;
  }

  // Demand: uniform random origins/destinations, request times uniform over [0, P).
  function makeScenario(cfg) {
    var rng = mulberry32(cfg.seed);
    var G = cfg.gridSize;
    function node() {
      return { x: Math.floor(rng() * G), y: Math.floor(rng() * G) };
    }
    var cabs = [];
    for (var i = 0; i < cfg.cabs; i++) cabs.push(node());
    var riders = [];
    for (var j = 0; j < cfg.riders; j++) {
      var requestAt = rng() * cfg.duration;
      var o = node();
      var d = node();
      while (manhattan(o.x, o.y, d.x, d.y) < MIN_TRIP_BLOCKS) d = node();
      // Drawn for every rider so changing the opt-in % never moves anyone.
      var optIn = rng() * 100 < cfg.poolOptIn;
      riders.push({ requestAt: requestAt, ox: o.x, oy: o.y, dx: d.x, dy: d.y, optIn: optIn });
    }
    riders.sort(function (a, b) { return a.requestAt - b.requestAt; });
    riders.forEach(function (r, idx) { r.id = idx; });
    return { cabs: cabs, riders: riders };
  }

  function World(cfg, scenario, poolEnabled) {
    this.cfg = cfg;
    this.poolEnabled = poolEnabled;
    this.speed = cfg.cabSpeed;
    this.X = cfg.driverPremium / 100;
    this.Y = cfg.poolDiscount / 100;
    this.Y0 = cfg.requestDiscount / 100;
    this.fair = !!(poolEnabled && cfg.fairPricing);
    this.steps = 0;
    this.t = 0;
    this.nextDispatchAt = 0;
    this.arrivalIdx = 0;
    this.queue = [];
    this.series = [];
    this.lostLog = [];
    this.episodes = [];  // settled busy stretches, one per cab from busy to idle
    this.zone = null;    // active threat zone, if any
    this.zoneHistory = [];
    this.fields = {};    // cached driving-distance fields around the zone, by target node
    this.fieldCount = 0;
    this.cancelLog = []; // riders cancelled or refused because of a zone
    this.totals = {
      revenue: 0, driverPay: 0, premium: 0, discount: 0,
      requested: 0, pickedUp: 0, completed: 0, lost: 0, waitSum: 0,
      reroutes: 0, reassigned: 0,
      topUp: 0, floorTopUp: 0, parityTopUp: 0, detourCredit: 0,
      cancelled: 0, zoneCancelled: 0, zoneRefused: 0, zoneRequeued: 0, zoneEarlyDrops: 0,
      zoneRerouted: 0, zoneEvacuated: 0, zoneCapExceptions: 0, zoneRefund: 0,
    };

    var speed = this.speed;
    this.cabs = scenario.cabs.map(function (p, i) {
      return {
        id: i, x: p.x, y: p.y, next: null, progress: 0,
        plan: [],       // pending stops, in order
        riders: [],     // riders committed: assigned or aboard
        onboard: [],
        time: { idle: 0, empty: 0, one: 0, two: 0 },
        blocks: { empty: 0, one: 0, two: 0 },
        earnings: 0, premium: 0, trips: 0, reroutes: 0,
        topUp: 0,       // driver-guarantee top-ups, included in earnings
        ep: null,       // the busy stretch in progress
        evac: null,     // intersection it is driving to, to get out of a threat zone

        planVersion: 0, rerouteVersion: 0,
        _base: null, _baseKey: '',
      };
    });
    this.riders = scenario.riders.map(function (r) {
      var direct = manhattan(r.ox, r.oy, r.dx, r.dy);
      return {
        id: r.id, requestAt: r.requestAt, ox: r.ox, oy: r.oy, dx: r.dx, dy: r.dy,
        optIn: r.optIn,
        pool: poolEnabled && r.optIn,
        direct: direct,
        est: direct / speed,
        fullFare: direct / speed * cfg.fareRate,
        fare: 0,
        state: 'scheduled',     // scheduled -> waiting -> assigned -> riding -> done | lost
        cab: null,
        assignedAt: null, promisedPickupAt: null, latestPickupAt: null,
        pickupAt: null, dropoffAt: null, lostAt: null,
        sharedSec: 0,
        detourCredit: 0,        // fair pricing: $ credited back for detour seconds
        capBase: direct / speed, // in-car time the detour cap is measured against
        queuedAt: null,         // when the patience clock started (restarts if put back in the queue)
        dropDeadline: null,     // threat zone: latest drop-off committed for a rider already aboard
        earlyDrop: null,        // threat zone: safe intersection used instead of a destination inside it
        cancelReason: null,     // threat zone: why the ride was cancelled or refused
        cancelKind: null,       // 'cancelled' (already requested) or 'refused' (requested during it)
        cancelledAt: null,
        requeued: 0,            // times put back in the queue by a threat zone
        coRiders: [],           // ids of everyone this rider shared the cab with
        reroutes: 0,            // times their cab changed course while they were aboard
        reassigned: 0,          // times moved to a closer cab before pickup
        joinedOccupied: false,  // boarded a cab that already had a rider
        hosted: false,          // someone boarded while this rider was aboard
      };
    });
  }

  World.prototype.step = function () {
    // Riders who requested before this instant join the queue.
    while (this.arrivalIdx < this.riders.length && this.riders[this.arrivalIdx].requestAt <= this.t) {
      var r = this.riders[this.arrivalIdx++];
      r.state = 'waiting';
      r.queuedAt = r.requestAt;
      this.totals.requested++;
      if (this.zone && !this.zoneAdmit(r)) continue;
      this.queue.push(r);
    }
    if (this.t >= this.nextDispatchAt - EPS) {
      this.dispatch();
      this.sample();
      this.nextDispatchAt += DISPATCH_EVERY;
    }
    for (var i = 0; i < this.cabs.length; i++) this.advance(this.cabs[i]);
    this.steps++;
    this.t = this.steps * DT;
  };

  // ---------------------------------------------------------------- movement

  World.prototype.advance = function (cab) {
    var budget = this.speed * DT; // blocks this step
    var now = this.t;
    for (var guard = 0; guard < 10000; guard++) {
      if (!cab.next && cab.evac) {
        // Getting out of a threat zone comes before anything else.
        if (cab.x === cab.evac.x && cab.y === cab.evac.y) cab.evac = null;
        else if (budget > EPS) { cab.next = lStep(cab.x, cab.y, cab.evac.x, cab.evac.y); cab.progress = 0; }
        else return;
      }
      if (!cab.next) {
        this.serveStops(cab, now);
        if (!cab.plan.length) {
          cab.time.idle += budget / this.speed;
          return;
        }
        if (budget <= EPS) return;
        var s = cab.plan[0];
        // L-shaped routing (x leg, then y leg), or around the threat zone.
        cab.next = this.nextNode(cab.x, cab.y, s.x, s.y);
        cab.progress = 0;
      }
      var move = Math.min(1 - cab.progress, budget);
      var sec = move / this.speed;
      this.accrue(cab, sec, move);
      cab.progress += move;
      budget -= move;
      now += sec;
      if (cab.progress >= 1 - EPS) {
        cab.x = cab.next.x;
        cab.y = cab.next.y;
        cab.next = null;
        cab.progress = 0;
      }
      if (budget <= EPS) {
        if (!cab.next) this.serveStops(cab, now);
        return;
      }
    }
  };

  World.prototype.accrue = function (cab, sec, blocks) {
    var n = cab.onboard.length;
    if (n === 0) {
      cab.time.empty += sec;
      cab.blocks.empty += blocks;
      return;
    }
    var rate = this.cfg.driverRate;
    var pay = rate * sec;
    if (n === 1) {
      cab.time.one += sec;
      cab.blocks.one += blocks;
    } else {
      var prem = rate * this.X * sec;
      pay += prem;
      cab.premium += prem;
      cab.time.two += sec;
      cab.blocks.two += blocks;
      this.totals.premium += prem;
      cab.onboard[0].sharedSec += sec;
      cab.onboard[1].sharedSec += sec;
    }
    cab.earnings += pay;
    this.totals.driverPay += pay;
  };

  World.prototype.serveStops = function (cab, now) {
    while (cab.plan.length && cab.plan[0].x === cab.x && cab.plan[0].y === cab.y) {
      var stop = cab.plan.shift();
      var r = stop.rider;
      cab.planVersion++;
      if (stop.type === 'pickup') {
        if (cab.onboard.length === 1) {
          var host = cab.onboard[0];
          host.hosted = true;
          host.coRiders.push(r.id);
          r.joinedOccupied = true;
          r.coRiders.push(host.id);
        }
        cab.onboard.push(r);
        r.state = 'riding';
        r.pickupAt = now;
        // Fair pricing charges the no-match rate now and settles at drop-off.
        r.fare = r.fullFare * (r.pool ? 1 - (this.fair ? this.Y0 : this.Y) : 1);
        this.totals.revenue += r.fare;
        this.totals.discount += r.fullFare - r.fare;
        this.totals.pickedUp++;
        this.totals.waitSum += now - r.requestAt;
      } else {
        cab.onboard.splice(cab.onboard.indexOf(r), 1);
        cab.riders.splice(cab.riders.indexOf(r), 1);
        r.state = 'done';
        r.dropoffAt = now;
        if (r.pool && this.fair) this.settleFare(r, now);
        if (r.earlyDrop) this.prorateFare(r);
        cab.trips++;
        this.totals.completed++;
        if (cab.ep) cab.ep.done.push(r);
        if (!cab.riders.length) this.endEpisode(cab, now);
      }
    }
  };

  // ---------------------------------------------------------------- fair pricing

  // Settle a pool rider's fare at drop-off: the full discount Y only if they
  // actually shared, otherwise Y0; then a credit for the extra seconds their
  // detours cost them, so whoever absorbs the detour is the one compensated.
  World.prototype.settleFare = function (r, now) {
    var cfg = this.cfg;
    var target = r.fullFare * (1 - (r.sharedSec > EPS ? this.Y : this.Y0));
    var extra = (now - r.pickupAt) - r.est;
    var credit = extra > EPS ? Math.min(target, cfg.fareRate * cfg.detourCredit / 100 * extra) : 0;
    target -= credit;
    var refund = r.fare - target; // >= 0: Y >= Y0 and the credit only lowers the fare
    r.detourCredit = credit;
    r.fare = target;
    this.totals.revenue -= refund;
    this.totals.discount += refund;
    this.totals.detourCredit += credit;
  };

  // ---------------------------------------------------------------- driver guarantee

  function blocksOf(cab) { return cab.blocks.empty + cab.blocks.one + cab.blocks.two; }

  // A busy stretch runs from the moment an idle cab takes a rider until it has
  // no riders left. It includes the unpaid drive to the first pickup.
  World.prototype.startEpisode = function (cab) {
    cab.ep = { start: this.t, pay0: cab.earnings, blocks0: blocksOf(cab), two0: cab.time.two, done: [] };
  };

  World.prototype.endEpisode = function (cab, now) {
    var ep = cab.ep, cfg = this.cfg;
    cab.ep = null;
    if (!ep || !ep.done.length) return; // nobody was delivered: nothing to settle
    var pay = cab.earnings - ep.pay0;
    var cost = cfg.costPerBlock * (blocksOf(cab) - ep.blocks0);
    var parity = 0, pooled = false;
    for (var i = 0; i < ep.done.length; i++) {
      parity += cfg.driverRate * ep.done[i].est; // what this rider pays the driver riding solo
      if (ep.done[i].pool) pooled = true;
    }
    var parityTop = 0, floorTop = 0;
    if (pooled) {
      if (cfg.parityFloor && parity - pay > 1e-9) parityTop = parity - pay;
      if (cfg.driverFloor && cost - (pay + parityTop) > 1e-9) floorTop = cost - (pay + parityTop);
    }
    var top = parityTop + floorTop;
    if (top > 0) {
      cab.earnings += top;
      cab.topUp += top;
      this.totals.driverPay += top;
      this.totals.topUp += top;
      this.totals.parityTopUp += parityTop;
      this.totals.floorTopUp += floorTop;
    }
    this.episodes.push({
      cab: cab.id, start: ep.start, end: now, riders: ep.done.length, pooled: pooled,
      shared: cab.time.two - ep.two0 > EPS,
      pay: pay, cost: cost, parity: parity, parityTop: parityTop, floorTop: floorTop,
      net: pay + top - cost,
    });
  };

  // ---------------------------------------------------------------- planning

  function pickupStop(r) { return { type: 'pickup', rider: r, x: r.ox, y: r.oy }; }
  function dropoffStop(r) { return { type: 'dropoff', rider: r, x: r.dx, y: r.dy }; }

  // Blocks the cab must still drive to reach (x, y) directly. A cab that is
  // mid-edge finishes the edge first.
  World.prototype.reach = function (cab, x, y) {
    var d = 0, sx = cab.x, sy = cab.y;
    if (cab.next) { d = 1 - cab.progress; sx = cab.next.x; sy = cab.next.y; }
    if (cab.evac) { d += manhattan(sx, sy, cab.evac.x, cab.evac.y); sx = cab.evac.x; sy = cab.evac.y; }
    return d + this.dist(sx, sy, x, y);
  };

  // Time the plan and check every rule. Returns null if any rule breaks.
  // `newRider` is the rider being inserted (their pickup must be within the
  // ping radius); pass check=false to time a plan already committed.
  // relaxAboard (threat zone only): skip the detour cap for riders already
  // aboard, who must be delivered whatever the zone did to their route.
  World.prototype.evalPlan = function (cab, plan, newRider, check, relaxAboard) {
    var speed = this.speed, limit = this.cfg.maxDetour;
    var maxPick = this.cfg.pingRadius / speed;
    var t = this.t, x, y;
    if (cab.next) {
      t += (1 - cab.progress) / speed;
      x = cab.next.x; y = cab.next.y;
    } else {
      x = cab.x; y = cab.y;
    }
    if (cab.evac) {
      t += manhattan(x, y, cab.evac.x, cab.evac.y) / speed;
      x = cab.evac.x; y = cab.evac.y;
    }
    var load = cab.onboard.length;
    var picks = {}, drops = {}, newPick = null;
    for (var i = 0; i < plan.length; i++) {
      var s = plan[i], r = s.rider;
      t += this.dist(x, y, s.x, s.y) / speed;
      x = s.x; y = s.y;
      if (s.type === 'pickup') {
        load++;
        if (check) {
          if (load > 2) return null;
          if (r === newRider) {
            if (t - this.t > maxPick + EPS) return null;
          } else if (t > r.latestPickupAt + EPS) {
            return null;
          }
        }
        if (r === newRider) newPick = t;
        picks[r.id] = t;
      } else {
        load--;
        var pt = r.state === 'riding' ? r.pickupAt : picks[r.id];
        if (check && !(relaxAboard && r.state === 'riding')) {
          if (r.dropDeadline != null ? t > r.dropDeadline + EPS : t - pt > limit * r.capBase + EPS) return null;
        }
        drops[r.id] = t;
      }
    }
    return { end: t, picks: picks, drops: drops, newPick: newPick };
  };

  World.prototype.baseEval = function (cab) {
    var key = cab.planVersion + '@' + this.steps;
    if (cab._baseKey !== key) {
      cab._base = this.evalPlan(cab, cab.plan, null, false);
      cab._baseKey = key;
    }
    return cab._base;
  };

  // Best place to slot rider r into the cab's plan, by matching cost (in
  // rider-seconds): the new rider's wait, every extra in-car or waiting second
  // the change imposes on anyone, plus a weight on the extra cab-seconds.
  World.prototype.bestInsertion = function (cab, r) {
    var base = this.baseEval(cab);
    var P = pickupStop(r), D = dropoffStop(r);
    var S = cab.plan, n = S.length, best = null;
    for (var i = 0; i <= n; i++) {
      for (var j = i; j <= n; j++) {
        var plan = S.slice(0, i);
        plan.push(P);
        for (var k = i; k < j; k++) plan.push(S[k]);
        plan.push(D);
        for (k = j; k < n; k++) plan.push(S[k]);
        var res = this.evalPlan(cab, plan, r, true);
        if (!res) continue;
        var delay = 0;
        for (var id in base.drops) delay += res.drops[id] - base.drops[id];
        var cost = (res.newPick - this.t) + (res.drops[r.id] - res.newPick - r.est) + delay
          + VEHICLE_WEIGHT * (res.end - base.end);
        if (!best || cost < best.cost) {
          best = { cab: cab, plan: plan, cost: cost, res: res, base: base };
        }
      }
    }
    return best;
  };

  World.prototype.isPoolCab = function (cab) {
    if (!cab.riders.length || cab.plan.length + 2 > MAX_PLAN_STOPS) return false;
    for (var i = 0; i < cab.riders.length; i++) if (!cab.riders[i].pool) return false;
    return true;
  };

  World.prototype.commit = function (opt, r) {
    var cab = opt.cab, cfg = this.cfg;
    var rerouted = false;
    for (var i = 0; i < cab.onboard.length; i++) {
      var a = cab.onboard[i];
      if (opt.res.drops[a.id] > opt.base.drops[a.id] + EPS) {
        a.reroutes++;
        rerouted = true;
      }
    }
    if (rerouted) {
      cab.reroutes++;
      cab.rerouteVersion++;
      this.totals.reroutes++;
    }
    cab.plan = opt.plan;
    cab.planVersion++;
    if (!cab.riders.length) this.startEpisode(cab);
    cab.riders.push(r);
    r.state = 'assigned';
    r.cab = cab.id;
    r.assignedAt = this.t;
    r.promisedPickupAt = opt.res.newPick;
    r.latestPickupAt = opt.res.newPick + cfg.pickupSlip;
  };

  // ---------------------------------------------------------------- dispatch

  World.prototype.dispatch = function () {
    var cfg = this.cfg, now = this.t;

    // Riders who waited too long without a match give up.
    if (this.queue.length) {
      var keep = [];
      for (var q = 0; q < this.queue.length; q++) {
        var w = this.queue[q];
        if (now - w.queuedAt >= cfg.patience - EPS) {
          w.state = 'lost';
          w.lostAt = now;
          this.totals.lost++;
          this.lostLog.push(w.id);
        } else {
          keep.push(w);
        }
      }
      this.queue = keep;
    }

    var idle = [], poolable = [], i, c;
    for (i = 0; i < this.cabs.length; i++) {
      c = this.cabs[i];
      if (c.evac) continue; // still getting out of a threat zone
      if (!c.riders.length) idle.push(c);
      else if (this.poolEnabled && this.isPoolCab(c)) poolable.push(c);
    }

    if (this.queue.length) {
      if (cfg.batchMatch) this.matchQueueBatch(idle, poolable);
      else this.matchQueue(idle, poolable);
    }
    if (cfg.reassign && idle.length) this.redispatch(idle);
  };

  World.prototype.matchQueue = function (idle, poolable) {
    var radius = this.cfg.pingRadius;
    var remaining = [];
    var scanned = 0;
    for (var q = 0; q < this.queue.length; q++) {
      var r = this.queue[q];
      if (scanned >= MAX_QUEUE_SCAN || (!idle.length && !(r.pool && poolable.length))) {
        remaining.push(r);
        continue;
      }
      scanned++;
      var best = null, opt, j, c;
      // Ping only cabs whose direct drive to the pickup fits in the radius.
      for (j = 0; j < idle.length; j++) {
        c = idle[j];
        if (this.reach(c, r.ox, r.oy) > radius + EPS) continue;
        opt = this.bestInsertion(c, r);
        if (opt && (!best || opt.cost < best.cost)) best = opt;
      }
      if (r.pool) {
        for (j = 0; j < poolable.length; j++) {
          c = poolable[j];
          if (this.reach(c, r.ox, r.oy) > radius + EPS) continue;
          opt = this.bestInsertion(c, r);
          if (opt && (!best || opt.cost < best.cost)) best = opt;
        }
      }
      if (!best) {
        remaining.push(r);
        continue;
      }
      var cab = best.cab;
      var wasIdle = !cab.riders.length;
      this.commit(best, r);
      if (wasIdle) {
        idle.splice(idle.indexOf(cab), 1);
        if (r.pool && this.isPoolCab(cab)) poolable.push(cab);
      } else if (!this.isPoolCab(cab)) {
        poolable.splice(poolable.indexOf(cab), 1);
      }
    }
    this.queue = remaining;
  };

  // Batch matching: instead of serving the queue strictly oldest-first, keep
  // each waiting rider's best option and repeatedly commit the cheapest pair
  // in the whole batch. A priority for time already waited (growing with
  // age / patience) keeps old requests from being starved. After a commit only
  // the changed cab needs re-evaluating; every other cab's options still hold.
  World.prototype.optionFor = function (cab, r, idle, poolable) {
    var eligible = idle.indexOf(cab) >= 0 || (r.pool && poolable.indexOf(cab) >= 0);
    if (!eligible || this.reach(cab, r.ox, r.oy) > this.cfg.pingRadius + EPS) return null;
    return this.bestInsertion(cab, r);
  };

  World.prototype.matchQueueBatch = function (idle, poolable) {
    var self = this, now = this.t, patience = this.cfg.patience;
    var pending = this.queue.slice(0, MAX_QUEUE_SCAN), rest = this.queue.slice(MAX_QUEUE_SCAN);
    function bestFor(r) {
      var best = null, j, opt;
      var cabs = r.pool ? idle.concat(poolable) : idle;
      for (j = 0; j < cabs.length; j++) {
        opt = self.optionFor(cabs[j], r, idle, poolable);
        if (opt && (!best || opt.cost < best.cost)) best = opt;
      }
      return best;
    }
    function score(r, opt) {
      var age = now - r.requestAt;
      return opt.cost - AGE_WEIGHT * age * age / patience;
    }
    var best = pending.map(bestFor);
    for (;;) {
      var bi = -1, bs = Infinity;
      for (var i = 0; i < pending.length; i++) {
        if (!best[i]) continue;
        var sc = score(pending[i], best[i]);
        if (sc < bs) { bs = sc; bi = i; }
      }
      if (bi < 0) break;
      var r = pending[bi], cab = best[bi].cab;
      var wasIdle = !cab.riders.length;
      this.commit(best[bi], r);
      if (wasIdle) {
        idle.splice(idle.indexOf(cab), 1);
        if (r.pool && this.isPoolCab(cab)) poolable.push(cab);
      } else if (!this.isPoolCab(cab)) {
        poolable.splice(poolable.indexOf(cab), 1);
      }
      pending.splice(bi, 1);
      best.splice(bi, 1);
      for (i = 0; i < pending.length; i++) {
        if (best[i] && best[i].cab === cab) { best[i] = bestFor(pending[i]); continue; }
        var opt = this.optionFor(cab, pending[i], idle, poolable);
        if (opt && (!best[i] || opt.cost < best[i].cost)) best[i] = opt;
      }
    }
    this.queue = pending.concat(rest);
  };

  // Re-dispatch: a rider still waiting for pickup moves to a free cab that can
  // reach them much sooner. Removing stops never makes anyone else later
  // (Manhattan distances obey the triangle inequality), so the old cab's
  // remaining riders stay within every rule.
  World.prototype.redispatch = function (idle) {
    var radius = this.cfg.pingRadius, speed = this.speed;
    for (var i = 0; i < this.cabs.length && idle.length; i++) {
      var c = this.cabs[i];
      if (!c.riders.length) continue;
      var waiting = c.riders.filter(function (r) { return r.state === 'assigned'; });
      for (var w = 0; w < waiting.length && idle.length; w++) {
        var r = waiting[w];
        var cur = this.baseEval(c).picks[r.id] - this.t;
        if (cur < REASSIGN_MIN_GAIN) continue;
        var bestCab = null, bestEta = Infinity;
        for (var j = 0; j < idle.length; j++) {
          var d = this.reach(idle[j], r.ox, r.oy);
          if (d <= radius + EPS && d / speed < bestEta) { bestEta = d / speed; bestCab = idle[j]; }
        }
        if (!bestCab || bestEta > cur - REASSIGN_MIN_GAIN || bestEta > cur * REASSIGN_MIN_RATIO) continue;

        c.plan = c.plan.filter(function (s) { return s.rider !== r; });
        c.riders.splice(c.riders.indexOf(r), 1);
        c.planVersion++;
        if (c.onboard.length) c.rerouteVersion++;
        if (!c.riders.length) this.endEpisode(c, this.t);

        this.startEpisode(bestCab);
        bestCab.plan = [pickupStop(r), dropoffStop(r)];
        bestCab.riders.push(r);
        bestCab.planVersion++;
        r.cab = bestCab.id;
        r.assignedAt = this.t;
        r.promisedPickupAt = this.t + bestEta;
        r.latestPickupAt = r.promisedPickupAt + this.cfg.pickupSlip;
        r.reassigned++;
        this.totals.reassigned++;

        idle.splice(idle.indexOf(bestCab), 1);
        if (!c.riders.length) idle.push(c);
      }
    }
  };

  // ---------------------------------------------------------------- threat zone

  // One L-shaped step toward a target: x leg first, then y leg.
  function lStep(x, y, tx, ty) {
    return x !== tx ? { x: x + Math.sign(tx - x), y: y } : { x: x, y: y + Math.sign(ty - y) };
  }

  World.prototype.blocked = function (x, y) {
    return !!this.zone && this.zone.mask[x + y * this.cfg.gridSize] === 1;
  };

  // Blocks of driving from a to b. Manhattan distance with no zone; with a
  // zone, the shortest path over open intersections (Infinity if there is none).
  World.prototype.dist = function (ax, ay, bx, by) {
    if (!this.zone) return manhattan(ax, ay, bx, by);
    var d = this.fieldTo(bx, by)[ax + ay * this.cfg.gridSize];
    return d < 0 ? Infinity : d;
  };

  // Breadth-first search from (x, y) over open intersections: blocks of
  // driving from every intersection to it (-1 = unreachable). Cached per target.
  World.prototype.fieldTo = function (x, y) {
    var G = this.cfg.gridSize, id = x + y * G;
    var f = this.fields[id];
    if (f) return f;
    if (this.fieldCount >= Math.max(200, Math.floor(5e6 / (G * G)))) { this.fields = {}; this.fieldCount = 0; }
    var mask = this.zone.mask, n = G * G;
    f = new Int32Array(n).fill(-1);
    if (!mask[id]) {
      var q = new Int32Array(n), head = 0, tail = 0;
      f[id] = 0;
      q[tail++] = id;
      while (head < tail) {
        var c = q[head++], cx = c % G, d = f[c] + 1;
        if (cx > 0 && f[c - 1] < 0 && !mask[c - 1]) { f[c - 1] = d; q[tail++] = c - 1; }
        if (cx < G - 1 && f[c + 1] < 0 && !mask[c + 1]) { f[c + 1] = d; q[tail++] = c + 1; }
        if (c >= G && f[c - G] < 0 && !mask[c - G]) { f[c - G] = d; q[tail++] = c - G; }
        if (c < n - G && f[c + G] < 0 && !mask[c + G]) { f[c + G] = d; q[tail++] = c + G; }
      }
    }
    this.fields[id] = f;
    this.fieldCount++;
    return f;
  };

  // The next intersection on the way to (tx, ty). With a zone, the first
  // neighbour that is one block closer by driving distance, preferring the
  // x leg like the L-shaped route. Movement and timing therefore agree.
  World.prototype.nextNode = function (x, y, tx, ty) {
    if (!this.zone) return lStep(x, y, tx, ty);
    var G = this.cfg.gridSize, f = this.fieldTo(tx, ty), here = f[x + y * G];
    if (here > 0) {
      var sx = Math.sign(tx - x) || 1, sy = Math.sign(ty - y) || 1;
      var cand = [[x + sx, y], [x, y + sy], [x - sx, y], [x, y - sy]];
      for (var i = 0; i < 4; i++) {
        var nx = cand[i][0], ny = cand[i][1];
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        if (f[nx + ny * G] === here - 1) return { x: nx, y: ny };
      }
    }
    return lStep(x, y, tx, ty); // not reached for a planned stop: plans only hold reachable stops
  };

  // Intersections a cab will drive through from (x, y) to (tx, ty), for drawing.
  World.prototype.routeNodes = function (x, y, tx, ty) {
    var out = [];
    for (var guard = 0; (x !== tx || y !== ty) && guard < 4 * this.cfg.gridSize * this.cfg.gridSize; guard++) {
      var n = this.nextNode(x, y, tx, ty);
      out.push(n);
      x = n.x; y = n.y;
    }
    return out;
  };

  // Where the cab's route effectively starts: after finishing its current
  // edge and, if it is inside a zone, after driving out.
  World.prototype.routeStart = function (cab) {
    var x = cab.next ? cab.next.x : cab.x, y = cab.next ? cab.next.y : cab.y;
    if (cab.evac) { x = cab.evac.x; y = cab.evac.y; }
    return { x: x, y: y };
  };

  function zoneReason(w, r) {
    if (w.blocked(r.ox, r.oy)) return 'pickup inside the threat zone';
    if (w.blocked(r.dx, r.dy)) return 'destination inside the threat zone';
    if (w.dist(r.ox, r.oy, r.dx, r.dy) === Infinity) return 'no route around the threat zone';
    return null;
  }

  World.prototype.cancelRide = function (r, reason, kind) {
    r.state = 'cancelled';
    r.cancelReason = reason;
    r.cancelKind = kind;
    r.cancelledAt = this.t;
    r.cab = null;
    this.totals.cancelled++;
    this.totals[kind === 'refused' ? 'zoneRefused' : 'zoneCancelled']++;
    this.cancelLog.push(r.id);
  };

  // A new request while a zone is active: refuse it if it can't be done, and
  // measure its detour cap against the solo route that avoids the zone.
  World.prototype.zoneAdmit = function (r) {
    var reason = zoneReason(this, r);
    if (reason) { this.cancelRide(r, reason, 'refused'); return false; }
    r.capBase = Math.max(r.est, this.dist(r.ox, r.oy, r.dx, r.dy) / this.speed);
    return true;
  };

  World.prototype.requeue = function (r) {
    r.state = 'waiting';
    r.cab = null;
    r.assignedAt = r.promisedPickupAt = r.latestPickupAt = null;
    r.queuedAt = this.t; // patience starts again from the declaration
    r.requeued++;
    r.capBase = Math.max(r.est, this.dist(r.ox, r.oy, r.dx, r.dy) / this.speed);
    this.totals.zoneRequeued++;
    this.queue.push(r);
  };

  function nearestOpen(w, x, y, reachableFrom) {
    var G = w.cfg.gridSize, f = reachableFrom ? w.fieldTo(reachableFrom.x, reachableFrom.y) : null;
    var best = null, bestD = Infinity, bestTie = Infinity;
    for (var yy = 0; yy < G; yy++) {
      for (var xx = 0; xx < G; xx++) {
        var id = xx + yy * G;
        if (w.zone.mask[id] || (f && f[id] < 0)) continue;
        var d = manhattan(x, y, xx, yy), tie = f ? f[id] : 0;
        if (d < bestD || (d === bestD && tie < bestTie)) { best = { x: xx, y: yy }; bestD = d; bestTie = tie; }
      }
    }
    return best;
  }

  World.prototype.declareZone = function (cx, cy) {
    var cfg = this.cfg, G = cfg.gridSize, i;
    cx = clamp(Math.round(cx), 0, G - 1);
    cy = clamp(Math.round(cy), 0, G - 1);
    // Timings before the change, to tell which cabs it reroutes.
    var before = this.cabs.map(function (c) { return c.plan.length ? this.evalPlan(c, c.plan, null, false) : null; }, this);
    if (this.zone) this.clearZone();
    var R = cfg.zoneRadius, mask = new Uint8Array(G * G), nodes = 0;
    for (var y = 0; y < G; y++) {
      for (var x = 0; x < G; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R + EPS) { mask[x + y * G] = 1; nodes++; }
      }
    }
    this.zone = { cx: cx, cy: cy, r: R, at: this.t, mask: mask, nodes: nodes };
    this.zoneHistory.push({ cx: cx, cy: cy, r: R, at: this.t, clearedAt: null });
    this.fields = {};
    this.fieldCount = 0;

    // 1. Cabs inside the zone get out first.
    for (i = 0; i < this.cabs.length; i++) this.secureCab(this.cabs[i]);

    // 2. Riders still waiting for a match.
    var keep = [];
    for (i = 0; i < this.queue.length; i++) {
      var r = this.queue[i], reason = zoneReason(this, r);
      if (reason) this.cancelRide(r, reason, 'cancelled');
      else { r.capBase = Math.max(r.capBase, this.dist(r.ox, r.oy, r.dx, r.dy) / this.speed); keep.push(r); }
    }
    this.queue = keep;

    // 3. Every committed plan is re-checked against the new map.
    for (i = 0; i < this.cabs.length; i++) {
      if (this.cabs[i].riders.length) this.replanForZone(this.cabs[i], before[i]);
    }
    this.queue.sort(function (a, b) { return a.requestAt - b.requestAt; });
  };

  World.prototype.secureCab = function (cab) {
    var moved = false;
    if (cab.next) {
      var fromIn = this.blocked(cab.x, cab.y), nextIn = this.blocked(cab.next.x, cab.next.y);
      if (nextIn && !fromIn) {
        // Heading in: turn around on the spot and go back the way it came.
        var to = cab.next;
        cab.next = { x: cab.x, y: cab.y };
        cab.x = to.x; cab.y = to.y;
        cab.progress = 1 - cab.progress;
        moved = true;
      } else if (nextIn) {
        cab.evac = nearestOpen(this, cab.next.x, cab.next.y);
        moved = true;
      }
    } else if (this.blocked(cab.x, cab.y)) {
      cab.evac = nearestOpen(this, cab.x, cab.y);
      moved = true;
    }
    if (moved) {
      this.totals.zoneEvacuated++;
      cab.planVersion++;
      cab.rerouteVersion++;
    }
  };

  World.prototype.dropRider = function (cab, r) {
    cab.plan = cab.plan.filter(function (s) { return s.rider !== r; });
    cab.riders.splice(cab.riders.indexOf(r), 1);
    cab.planVersion++;
  };

  World.prototype.replanForZone = function (cab, before) {
    var cfg = this.cfg, self = this, i, r;
    // a) Rides not yet picked up that the zone makes impossible are cancelled.
    cab.riders.filter(function (x) { return x.state === 'assigned'; }).forEach(function (x) {
      var reason = zoneReason(self, x);
      if (reason) { self.dropRider(cab, x); self.cancelRide(x, reason, 'cancelled'); }
    });
    // b) A rider aboard whose destination is closed or cut off is taken to the
    //    nearest open intersection the cab can reach.
    var start = this.routeStart(cab);
    for (i = 0; i < cab.onboard.length; i++) {
      r = cab.onboard[i];
      if (!this.blocked(r.dx, r.dy) && this.dist(start.x, start.y, r.dx, r.dy) < Infinity) continue;
      var spot = nearestOpen(this, r.dx, r.dy, start) || start;
      r.earlyDrop = spot;
      this.totals.zoneEarlyDrops++;
      cab.plan = cab.plan.map(function (s) {
        return s.rider === r && s.type === 'dropoff' ? { type: 'dropoff', rider: r, x: spot.x, y: spot.y } : s;
      });
    }
    // c) If the plan no longer fits (pickup slip, detour cap, no route), riders
    //    not yet aboard are put back in the queue, most recently matched first.
    //    Riders aboard are always delivered.
    for (;;) {
      if (this.evalPlan(cab, cab.plan, null, true, true)) break;
      var waiting = cab.riders.filter(function (x) { return x.state === 'assigned'; });
      if (!waiting.length) break;
      var victim = waiting.reduce(function (a, b) { return b.assignedAt > a.assignedAt ? b : a; });
      this.dropRider(cab, victim);
      this.requeue(victim);
    }
    cab.planVersion++;
    if (!cab.riders.length) { this.endEpisode(cab, this.t); return; }
    // d) A rider aboard whose route now runs past the detour cap is still
    //    delivered (safety first), but the drop-off time is frozen: no later
    //    match may delay them further.
    var after = this.evalPlan(cab, cab.plan, null, false);
    for (i = 0; i < cab.onboard.length; i++) {
      r = cab.onboard[i];
      var drop = after.drops[r.id];
      if (drop - r.pickupAt > cfg.maxDetour * r.capBase + EPS && r.dropDeadline == null) {
        r.dropDeadline = drop;
        this.totals.zoneCapExceptions++;
      }
    }
    var changed = !before || Math.abs(after.end - before.end) > EPS;
    for (var id in after.drops) if (!before || !(id in before.drops) || Math.abs(after.drops[id] - before.drops[id]) > EPS) changed = true;
    if (changed) {
      this.totals.zoneRerouted++;
      cab.rerouteVersion++;
      cab.onboard.forEach(function (x) { x.reroutes++; });
    }
  };

  World.prototype.clearZone = function () {
    if (!this.zone) return;
    var h = this.zoneHistory[this.zoneHistory.length - 1];
    if (h && h.clearedAt == null) h.clearedAt = this.t;
    this.zone = null;
    this.fields = {};
    this.fieldCount = 0;
    var self = this;
    this.cabs.forEach(function (cab) {
      cab.evac = null;
      // Riders being dropped short of a closed destination go all the way
      // again, if that still fits everyone in the cab.
      cab.onboard.forEach(function (r) {
        if (!r.earlyDrop) return;
        var plan = cab.plan.map(function (s) { return s.rider === r && s.type === 'dropoff' ? dropoffStop(r) : s; });
        if (self.evalPlan(cab, plan, null, true)) { cab.plan = plan; r.earlyDrop = null; cab.planVersion++; }
      });
    });
  };

  // A rider dropped short of their destination pays only for the share of the
  // trip actually covered.
  World.prototype.prorateFare = function (r) {
    var covered = r.direct > 0 ? clamp(1 - manhattan(r.earlyDrop.x, r.earlyDrop.y, r.dx, r.dy) / r.direct, 0, 1) : 1;
    var refund = r.fare * (1 - covered);
    r.fare -= refund;
    this.totals.revenue -= refund;
    this.totals.zoneRefund += refund;
  };

  // ---------------------------------------------------------------- readouts

  World.prototype.live = function () {
    var shared = 0, busy = 0;
    for (var i = 0; i < this.cabs.length; i++) {
      var c = this.cabs[i];
      if (c.onboard.length === 2) shared++;
      if (c.riders.length) busy++;
    }
    var T = this.totals;
    return {
      t: this.t,
      waiting: T.requested - T.pickedUp - T.lost - T.cancelled,
      unassigned: this.queue.length,
      riding: T.pickedUp - T.completed,
      completed: T.completed,
      lost: T.lost,
      sharedCabs: shared,
      busyCabs: busy,
      idleCabs: this.cabs.length - busy,
      avgWait: T.pickedUp ? T.waitSum / T.pickedUp : null,
      driverPay: T.driverPay,
      revenue: T.revenue,
      discount: T.discount,
    };
  };

  World.prototype.sample = function () {
    var l = this.live();
    this.series.push({
      t: this.t, waiting: l.waiting, riding: l.riding, completed: l.completed, lost: l.lost,
      sharedCabs: l.sharedCabs, idleCabs: l.idleCabs, driverPay: l.driverPay,
    });
  };

  function Simulation(input) {
    this.cfg = normalizeConfig(input);
    this.scenario = makeScenario(this.cfg);
    this.pool = new World(this.cfg, this.scenario, true);
    this.base = new World(this.cfg, this.scenario, false);
    this.zoneEvents = []; // declarations and clears, so a run can be replayed exactly
  }

  // The same zone is declared in both cities at the same moment.
  Simulation.prototype.declareZone = function (x, y) {
    this.zoneEvents.push({ t: this.t, type: 'declare', x: x, y: y });
    this.pool.declareZone(x, y);
    this.base.declareZone(x, y);
  };

  Simulation.prototype.clearZone = function () {
    if (!this.pool.zone) return;
    this.zoneEvents.push({ t: this.t, type: 'clear' });
    this.pool.clearZone();
    this.base.clearZone();
  };

  // Re-apply recorded zone events that fall due at the current time.
  Simulation.prototype.applyEvents = function (events, from) {
    while (from < events.length && events[from].t <= this.t + EPS) {
      var e = events[from++];
      if (e.type === 'declare') this.declareZone(e.x, e.y);
      else this.clearZone();
    }
    return from;
  };

  Simulation.prototype.step = function () {
    this.pool.step();
    this.base.step();
  };

  Object.defineProperty(Simulation.prototype, 't', {
    get: function () { return this.pool.t; },
  });

  Object.defineProperty(Simulation.prototype, 'done', {
    get: function () { return this.pool.t >= this.cfg.duration - EPS; },
  });

  Simulation.prototype.finish = function () {
    this.pool.sample();
    this.base.sample();
    return this;
  };

  Simulation.prototype.runToEnd = function () {
    while (!this.done) this.step();
    return this.finish();
  };

  var api = {
    DEFAULTS: DEFAULTS,
    ORIGINAL_RULES: ORIGINAL_RULES,
    DT: DT,
    EPS: EPS,
    DISPATCH_EVERY: DISPATCH_EVERY,
    MAX_PLAN_STOPS: MAX_PLAN_STOPS,
    VEHICLE_WEIGHT: VEHICLE_WEIGHT,
    AGE_WEIGHT: AGE_WEIGHT,
    normalizeConfig: normalizeConfig,
    makeScenario: makeScenario,
    manhattan: manhattan,
    World: World,
    Simulation: Simulation,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PoolSim = api;
}
definePoolSim(this);
