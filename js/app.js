/* PoolSim app — controls, run loop, live readouts and report wiring. */
(function () {
  'use strict';

  var Sim = window.PoolSim;
  var Metrics = window.PoolMetrics;
  var Report = window.PoolReport;
  var fmt = Report.fmt;

  var CONTROLS = [
    {
      group: 'Demand & fleet', items: [
        { key: 'riders', label: 'Riders', sym: 'K', min: 0, max: 1000, step: 10, hint: 'Request times are spread at random across the run.' },
        { key: 'cabs', label: 'Cabs', sym: 'N', min: 1, max: 300, step: 1 },
        { key: 'duration', label: 'Duration', sym: 'P', unit: 's', min: 30, max: 1800, step: 30 },
        { key: 'poolOptIn', label: 'Riders opting in to Pool', unit: '%', min: 0, max: 100, step: 5 },
      ],
    },
    {
      group: 'Pool rules', items: [
        { key: 'maxDetour', label: 'Max time in car vs. solo', unit: '×', min: 1, max: 3, step: 0.05, decimals: 2, hint: 'Checked for both riders before every match.' },
        { key: 'driverPremium', label: 'Driver premium', sym: 'X', unit: '%', min: 0, max: 100, step: 5, hint: 'Extra pay per second while 2 riders are aboard.' },
        { key: 'poolDiscount', label: 'Pool rider discount', sym: 'Y', unit: '%', min: 0, max: 90, step: 5 },
        { key: 'fairPricing', label: 'Fair pool pricing', toggle: true, hint: 'The full discount Y only if the rider actually shares; Y0 if no one ever joins. Plus a credit for every extra second of detour. Settled at drop-off. Off = Y for every opt-in, charged at pickup (original).' },
        { key: 'requestDiscount', label: 'Discount if never matched', sym: 'Y0', unit: '%', min: 0, max: 90, step: 5, hint: 'Fair pricing only. Never more than Y.' },
        { key: 'detourCredit', label: 'Detour credit', unit: '% of fare', min: 0, max: 100, step: 5, hint: 'Fair pricing only. Credited per extra second in the car, as a share of the standard fare rate.' },
      ],
    },
    {
      group: 'Driver guarantee', items: [
        { key: 'parityFloor', label: 'Solo-parity pay', toggle: true, hint: 'A pooled ride pays the driver at least what the same riders would have paid riding solo. Uber pays any top-up when the cab goes idle.' },
        { key: 'driverFloor', label: 'No-loss floor', toggle: true, hint: 'A pooled ride never leaves the driver below $0 after running costs, including the unpaid drive to the pickup.' },
      ],
    },
    {
      group: 'Dispatch & rerouting', items: [
        { key: 'pingRadius', label: 'Ping radius', unit: 'blocks', min: 1, max: 100, step: 1, hint: 'Only cabs that can reach the pickup within this many blocks of driving are offered the request.' },
        { key: 'patience', label: 'Rider patience', unit: 's', min: 10, max: 600, step: 10, hint: 'Riders with no match for this long give up.' },
        { key: 'pickupSlip', label: 'Pickup slip allowed', unit: 's', min: 0, max: 120, step: 5, hint: 'How far a promised pickup may slip when the cab reroutes to fit a new pool rider.' },
        { key: 'reassign', label: 'Re-dispatch before pickup', toggle: true, hint: 'Move a waiting rider to a cab that frees up much closer.' },
        { key: 'batchMatch', label: 'Batch matching', toggle: true, hint: 'Each second, match the cheapest rider-cab pairs across the whole queue first, with priority for riders who have waited longest. Off = strictly oldest request first (original).' },
      ],
    },
    {
      group: 'Threat zone', items: [
        { key: 'zoneRadius', label: 'Threat zone radius', unit: 'blocks', min: 1, max: 20, step: 1, hint: 'Fixed radius of the zone. Press “Declare threat” under the maps, then click a spot on either map, at any time during the run.' },
      ],
    },
    {
      group: 'Traffic lights', items: [
        { key: 'rightTurnDelay', label: 'Right-turn delay', unit: 's', min: 0, max: 20, step: 1, hint: 'Added at the light for every right turn. A left turn adds 75% of it, a U-turn 125% (only where there is no other way). Straight is free, and leaving a stop is free. Routes minimise total time. 0 = no traffic lights.' },
      ],
    },
    {
      group: 'City & money', items: [
        { key: 'gridSize', label: 'Grid', unit: 'per side', min: 10, max: 100, step: 5, hint: 'Intersections per side of the Manhattan grid.' },
        { key: 'cabSpeed', label: 'Cab speed', unit: 'blocks/s', min: 0.5, max: 5, step: 0.5, decimals: 1 },
        { key: 'fareRate', label: 'Standard fare', unit: '$/s', min: 0.05, max: 2, step: 0.05, decimals: 2, hint: 'Per second of the solo estimate. Charged at pickup.' },
        { key: 'driverRate', label: 'Driver pay', unit: '$/s', min: 0.05, max: 2, step: 0.05, decimals: 2, hint: 'Per second with a rider aboard. Pickup driving is unpaid.' },
        { key: 'costPerBlock', label: 'Driver running cost', unit: '$/block', min: 0, max: 0.5, step: 0.01, decimals: 2, hint: 'Fuel and wear per block driven, empty or not.' },
      ],
    },
    {
      group: 'Randomness', items: [
        { key: 'seed', label: 'Seed', min: 0, max: 99999, step: 1, noSlider: true, hint: 'Same seed and settings, same city.' },
      ],
    },
  ];
  var SPEEDS = [1, 2, 5, 10, 25, 50];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    config: $('config'), sidebar: document.querySelector('.sidebar'),
    start: $('btn-start'), startLabel: $('btn-start-label'), reset: $('btn-reset'), reportBtn: $('btn-report'),
    defaults: $('btn-defaults'), original: $('btn-original'), speed: $('speed'), status: $('status'), clock: $('clock'),
    clockTotal: $('clock-total'), progress: $('progress'),
    statsPool: $('stats-pool'), statsBase: $('stats-base'), subPool: $('sub-pool'),
    live: $('live'), report: $('report'), reportPanel: $('report-panel'), tooltip: $('tooltip'),
    zoneBtn: $('btn-zone'), zoneClear: $('btn-zone-clear'), zoneStatus: $('zone-status'),
  };

  var state = {
    cfg: Object.assign({}, Sim.DEFAULTS),
    sim: null,
    status: 'ready', // ready | running | paused | finished
    speed: 5,
    acc: 0,
    last: 0,
    lastUi: 0,
    effSpeed: null,
    summary: null,
    hover: null, // { view, cab }
    arming: false, // next map click declares the threat zone
  };

  var views = {
    pool: new window.MapView($('map-pool')),
    base: new window.MapView($('map-base')),
  };

  // ------------------------------------------------------------ controls

  var inputs = {};

  function decimalsOf(c) { return c.decimals || 0; }
  function clampValue(c, v) {
    if (c.toggle) return v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0;
    v = Number(v);
    if (!isFinite(v)) v = Sim.DEFAULTS[c.key];
    v = Math.min(c.max, Math.max(c.min, v));
    var d = decimalsOf(c);
    return d ? Number(v.toFixed(d)) : Math.round(v);
  }

  function buildControls() {
    var html = '';
    CONTROLS.forEach(function (g) {
      html += '<section class="group"><div class="group-title">' + g.group + '</div>';
      g.items.forEach(function (c) {
        var id = 'in-' + c.key;
        if (c.toggle) {
          html += '<div class="ctl"><div class="ctl-head"><label for="' + id + '">' + c.label + '</label>'
            + '<label class="switch"><input type="checkbox" id="' + id + '" data-key="' + c.key + '"><span class="track"></span></label></div>'
            + (c.hint ? '<p class="ctl-hint">' + c.hint + '</p>' : '') + '</div>';
          return;
        }
        html += '<div class="ctl"><div class="ctl-head">'
          + '<label for="' + id + '">' + c.label + (c.sym ? ' <span class="sym">' + c.sym + '</span>' : '') + '</label>'
          + '<span class="ctl-val">'
          + (c.noSlider ? '<button class="dice" type="button" id="dice" title="New random seed" aria-label="New random seed">Shuffle</button>' : '')
          + '<input type="number" id="' + id + '" data-key="' + c.key + '" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '">'
          + (c.unit ? '<span>' + c.unit + '</span>' : '') + '</span></div>'
          + (c.noSlider ? '' : '<input type="range" data-key="' + c.key + '" aria-label="' + c.label + '" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '">')
          + (c.hint ? '<p class="ctl-hint">' + c.hint + '</p>' : '') + '</div>';
      });
      html += '</section>';
    });
    els.config.innerHTML = html;

    CONTROLS.forEach(function (g) {
      g.items.forEach(function (c) {
        inputs[c.key] = {
          def: c,
          num: els.config.querySelector('input[type="' + (c.toggle ? 'checkbox' : 'number') + '"][data-key="' + c.key + '"]'),
          range: els.config.querySelector('input[type="range"][data-key="' + c.key + '"]'),
        };
      });
    });

    els.config.addEventListener('input', function (e) {
      var key = e.target.getAttribute('data-key');
      if (!key || e.target.type !== 'range') return;
      setConfig(key, e.target.value);
    });
    els.config.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-key');
      if (!key) return;
      if (e.target.type === 'checkbox') setConfig(key, e.target.checked ? 1 : 0);
      else if (e.target.type === 'number') setConfig(key, e.target.value);
    });
    $('dice').addEventListener('click', function () {
      setConfig('seed', Math.floor(Math.random() * 99999));
    });
    syncControls();
  }

  function syncControls() {
    Object.keys(inputs).forEach(function (key) {
      var c = inputs[key];
      var v = state.cfg[key];
      if (c.def.toggle) {
        c.num.checked = !!v;
        return;
      }
      c.num.value = decimalsOf(c.def) ? Number(v).toFixed(decimalsOf(c.def)) : v;
      if (c.range) {
        c.range.value = v;
        c.range.style.setProperty('--pct', ((v - c.def.min) / (c.def.max - c.def.min) * 100) + '%');
      }
    });
  }

  function setConfig(key, raw) {
    if (isLocked()) return;
    state.cfg[key] = clampValue(inputs[key].def, raw);
    keepConsistent();
    syncControls();
    newRun();
  }

  // Y0 can never exceed Y (the engine clamps it too; this keeps the sidebar honest).
  function keepConsistent() {
    if (state.cfg.requestDiscount > state.cfg.poolDiscount) state.cfg.requestDiscount = state.cfg.poolDiscount;
  }

  function isOriginalRules(cfg) {
    return Object.keys(Sim.ORIGINAL_RULES).every(function (k) { return Number(cfg[k]) === Sim.ORIGINAL_RULES[k]; });
  }

  function rulesLabel(cfg) {
    if (isOriginalRules(cfg)) return cfg.rightTurnDelay > 0 ? 'original rules + lights' : 'original rules';
    var parts = [];
    if (cfg.fairPricing) parts.push('fair pricing');
    if (cfg.parityFloor || cfg.driverFloor) parts.push('driver guarantee');
    if (cfg.batchMatch) parts.push('batch matching');
    if (cfg.rightTurnDelay > 0) parts.push('lights');
    return parts.join(' + ');
  }

  function isLocked() { return state.status === 'running' || state.status === 'paused'; }

  function buildSpeed() {
    els.speed.innerHTML = SPEEDS.map(function (s) {
      return '<button class="seg" type="button" data-speed="' + s + '" aria-pressed="' + (s === state.speed) + '">' + s + '×</button>';
    }).join('');
    els.speed.addEventListener('click', function (e) {
      var s = e.target.getAttribute('data-speed');
      if (!s) return;
      state.speed = Number(s);
      state.effSpeed = null;
      els.speed.querySelectorAll('.seg').forEach(function (b) {
        b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-speed')) === state.speed));
      });
    });
  }

  // ------------------------------------------------------------ run control

  function newRun() {
    setArming(false);
    state.sim = new Sim.Simulation(state.cfg);
    state.acc = 0;
    state.summary = null;
    state.hover = null;
    views.pool.setWorld(state.sim.pool);
    views.base.setWorld(state.sim.base);
    setStatus('ready');
    updateUi();
  }

  function start() {
    if (state.status === 'finished') newRun();
    closeReport();
    state.last = 0;
    state.effSpeed = null;
    setStatus('running');
  }

  function stop() { setStatus('paused'); }

  function toggle() {
    if (state.status === 'running') stop();
    else start();
  }

  function finish() {
    state.sim.pool.sample();
    state.sim.base.sample();
    setStatus('finished');
    openReport();
  }

  function setStatus(s) {
    state.status = s;
    var labels = { ready: 'Start', running: 'Stop', paused: 'Resume', finished: 'Start again' };
    els.startLabel.textContent = labels[s];
    els.start.classList.toggle('is-running', s === 'running');
    els.status.dataset.state = s;
    els.sidebar.classList.toggle('locked', isLocked());
    var locked = isLocked();
    Object.keys(inputs).forEach(function (k) {
      inputs[k].num.disabled = locked;
      if (inputs[k].range) inputs[k].range.disabled = locked;
    });
    if (s === 'finished') setArming(false);
    $('dice').disabled = locked;
    els.defaults.disabled = locked;
    els.original.disabled = locked;
    updateUi();
  }

  // ------------------------------------------------------------ main loop

  function frame(ts) {
    var real = state.last ? Math.min(0.1, (ts - state.last) / 1000) : 0;
    state.last = ts;
    var sim = state.sim;

    if (state.status === 'running' && real > 0) {
      state.acc += real * state.speed;
      var deadline = performance.now() + 12;
      var t0 = sim.t;
      while (state.acc >= Sim.DT - 1e-9 && !sim.done) {
        sim.step();
        state.acc -= Sim.DT;
        if (performance.now() > deadline) { state.acc = 0; break; }
      }
      var eff = (sim.t - t0) / real;
      state.effSpeed = state.effSpeed == null ? eff : state.effSpeed * 0.9 + eff * 0.1;
      if (sim.done) finish();
    }

    var now = performance.now();
    views.pool.draw(now);
    views.base.draw(now);
    if (ts - state.lastUi > 120) {
      state.lastUi = ts;
      updateUi();
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ live readouts

  function statusText() {
    var map = { ready: 'Ready', running: 'Running', paused: 'Stopped', finished: 'Finished' };
    var txt = map[state.status];
    if (state.status === 'running' && state.effSpeed != null && state.effSpeed < state.speed * 0.75) {
      txt += ' <span class="lag">· ≈' + Math.max(1, Math.round(state.effSpeed)) + '× (CPU-bound)</span>';
    }
    return txt;
  }

  function mapStats(l, withShared) {
    var cells = [
      ['Waiting', l.waiting],
      ['Riding', l.riding],
    ];
    if (withShared) cells.push(['Cabs with 2', l.sharedCabs]);
    cells.push(['Idle cabs', l.idleCabs]);
    cells.push(['Gave up', l.lost]);
    return cells.map(function (c) { return '<div><b>' + c[1] + '</b><span>' + c[0] + '</span></div>'; }).join('');
  }

  function poolRiderStats(world) {
    var saved = 0, n = 0, ratioSum = 0, worst = null;
    for (var i = 0; i < world.riders.length; i++) {
      var r = world.riders[i];
      if (!r.pool || r.state !== 'done') continue;
      var ratio = (r.dropoffAt - r.pickupAt) / r.est;
      saved += r.fullFare - r.fare;
      ratioSum += ratio;
      worst = worst == null ? ratio : Math.max(worst, ratio);
      n++;
    }
    return { saved: saved, n: n, avgExtra: n ? ratioSum / n - 1 : null, worst: worst };
  }

  function engagedShare(world) {
    var engaged = 0, total = 0;
    for (var i = 0; i < world.cabs.length; i++) {
      var t = world.cabs[i].time;
      engaged += t.empty + t.one + t.two;
      total += t.idle + t.empty + t.one + t.two;
    }
    return total > 0 ? engaged / total : null;
  }

  function tile(label, value, subHtml) {
    return '<div class="tile"><div class="tile-label">' + label + '</div><div class="tile-value">' + value
      + '</div><div class="tile-sub">' + subHtml + '</div></div>';
  }
  function chip(v, upIsGood, text) {
    return '<span class="delta ' + Report.tone(v, upIsGood) + '">' + text + '</span>';
  }

  function updateUi() {
    var sim = state.sim;
    if (!sim) return;
    var cfg = sim.cfg;
    els.status.innerHTML = statusText();
    els.clock.textContent = sim.t.toFixed(1) + ' s';
    els.clockTotal.textContent = cfg.duration + ' s';
    els.progress.style.width = Math.min(100, sim.t / cfg.duration * 100) + '%';
    els.reportBtn.disabled = !(sim.t > 0 && state.status !== 'running');
    els.subPool.textContent = cfg.poolOptIn + '% opt in · cap ' + cfg.maxDetour.toFixed(2) + '× · ' + rulesLabel(cfg);

    var lp = sim.pool.live(), lb = sim.base.live();
    els.statsPool.innerHTML = mapStats(lp, true);
    els.statsBase.innerHTML = mapStats(lb, false);

    var ps = poolRiderStats(sim.pool);
    var payDelta = lp.driverPay - lb.driverPay;
    var ep = engagedShare(sim.pool), eb = engagedShare(sim.base);
    var waitDelta = lp.avgWait != null && lb.avgWait != null ? lp.avgWait - lb.avgWait : null;
    els.live.innerHTML =
      tile('Riders delivered', fmt.int(lp.completed),
        chip(lp.completed - lb.completed, true, fmt.signedInt(lp.completed - lb.completed)) + '<span>vs ' + fmt.int(lb.completed) + ' · ' + fmt.int(lp.lost) + ' gave up (' + fmt.int(lb.lost) + ')</span>')
      + tile('Average wait for pickup', fmt.sec(lp.avgWait),
        (waitDelta == null ? '' : chip(waitDelta, false, fmt.signedSec(waitDelta))) + '<span>vs ' + fmt.sec(lb.avgWait) + ' without Pool</span>')
      + tile('Pool riders saved', fmt.money(ps.saved),
        '<span>' + fmt.int(ps.n) + ' completed pool trips · '
        + (cfg.fairPricing ? cfg.poolDiscount + '% if shared, ' + cfg.requestDiscount + '% if not, + detour credit' : cfg.poolDiscount + '% off') + '</span>')
      + tile('Extra time in the car', ps.avgExtra == null ? '—' : fmt.signedPct(ps.avgExtra, 1),
        '<span>pool riders, vs solo estimate · worst ' + fmt.ratio(ps.worst) + ' of ' + cfg.maxDetour.toFixed(2) + '×</span>')
      + tile('Driver earnings', fmt.money(lp.driverPay),
        chip(payDelta, true, fmt.signedMoney(payDelta)) + '<span>vs ' + fmt.money(lb.driverPay) + ' without Pool'
        + (sim.pool.totals.topUp > 0 ? ' · incl. ' + fmt.money(sim.pool.totals.topUp) + ' guarantee' : '') + '</span>')
      + tile('Drivers engaged', ep == null ? '—' : fmt.pct(ep),
        (ep == null || eb == null ? '' : '<span class="delta flat">' + (ep >= eb ? '+' : '\u2212') + Math.abs((ep - eb) * 100).toFixed(1) + ' pts</span>')
        + '<span>of cab time · ' + (eb == null ? '—' : fmt.pct(eb)) + ' without Pool</span>');

    updateZoneUi();
    if (state.hover) showCabTip(state.hover.view, state.hover.cab, state.hover.event);
  }

  // ------------------------------------------------------------ threat zone

  function setArming(on) {
    state.arming = !!on;
    document.body.classList.toggle('arming', state.arming);
    if (els.zoneBtn) els.zoneBtn.classList.toggle('is-armed', state.arming);
    if (state.sim) updateZoneUi();
  }

  function zoneCounts(w) {
    var T = w.totals;
    return T.zoneRerouted + ' rerouted · ' + T.zoneEvacuated + ' drove out · ' + (T.zoneCancelled + T.zoneRefused) + ' cancelled or refused · '
      + T.zoneRequeued + ' back in queue · ' + T.zoneEarlyDrops + ' dropped short';
  }

  function updateZoneUi() {
    var sim = state.sim, z = sim.pool.zone;
    var open = state.status !== 'finished';
    els.zoneBtn.disabled = !open;
    els.zoneBtn.textContent = state.arming ? 'Click a spot on a map…' : z ? 'Move threat' : 'Declare threat';
    els.zoneClear.disabled = !z || !open;
    var text;
    if (state.arming) text = 'Click any intersection on either map. The same zone (radius ' + state.cfg.zoneRadius + ' blocks) is declared in both cities. Esc cancels.';
    else if (z) text = '<b>Threat zone at (' + z.cx + ', ' + z.cy + '), radius ' + z.r + ' blocks</b>, declared at ' + fmt.sec(z.at, 0)
      + ' — With Pool: ' + zoneCounts(sim.pool) + ' | No Pool: ' + zoneCounts(sim.base);
    else if (sim.pool.zoneHistory.length) text = 'Threat cleared. With Pool: ' + zoneCounts(sim.pool) + ' | No Pool: ' + zoneCounts(sim.base);
    else text = open ? 'Declare a threat zone at any moment: no cab will be routed through it.' : '';
    els.zoneStatus.innerHTML = text;
  }

  // ------------------------------------------------------------ hover inspector

  function riderLine(world, cab, r, times) {
    var kind = r.pool ? 'Pool' : 'Solo';
    var head = '<div class="tip-row"><span class="key ' + (r.pool ? 'key-pool1' : '') + '" style="' + (r.pool ? '' : 'background:var(--solo)') + '"></span>'
      + 'Rider ' + r.id + ' · ' + kind + '<b>' + fmt.sec(r.est, 0) + ' solo</b></div>';
    var detail;
    var di = cab.plan.findIndex(function (s) { return s.type === 'dropoff' && s.rider === r; });
    var dropAt = di >= 0 ? times[di] : null;
    if (r.state === 'riding') {
      var planned = (dropAt - r.pickupAt) / r.est;
      detail = 'Aboard ' + fmt.sec(world.t - r.pickupAt) + ' · arriving at <b>' + fmt.ratio(planned) + '</b>'
        + (r.pool ? ' of ' + world.cfg.maxDetour.toFixed(2) + '× cap' : '');
      if (r.pool && (r.coRiders.length || r.reroutes)) {
        detail += '<br>Shared with ' + r.coRiders.length + (r.coRiders.length === 1 ? ' rider' : ' riders') + ' so far · rerouted ' + r.reroutes + '×';
      }
    } else {
      var pi = cab.plan.findIndex(function (s) { return s.type === 'pickup' && s.rider === r; });
      detail = 'Pickup in ' + fmt.sec(times[pi] - world.t) + ' · waited ' + fmt.sec(world.t - r.requestAt);
    }
    if (r.earlyDrop) detail += '<br><span style="color:var(--bad)">Destination inside the threat zone: dropping at (' + r.earlyDrop.x + ', ' + r.earlyDrop.y + '), fare cut to the distance covered</span>';
    else if (r.dropDeadline != null) detail += '<br><span style="color:var(--bad)">Long way round the threat zone: delivered anyway, no further detours allowed</span>';
    return '<div class="tip-rider">' + head + '<div class="tip-muted">' + detail + '</div></div>';
  }

  // The route to the next stop vs the original x-then-y route.
  function legLine(world, cab) {
    if (!world.turns || !cab.plan.length) return '';
    var st = world.routeStart(cab), s = cab.plan[0];
    if (st.x === s.x && st.y === s.y) return '';
    var a = world.describeRoute(st.x, st.y, st.h, s.x, s.y), b = world.describeXFirst(st.x, st.y, st.h, s.x, s.y);
    var line = function (r) { return r.blocks + ' blocks · ' + r.lefts + ' left · ' + r.rights + ' right' + (r.uturns ? ' · ' + r.uturns + ' U' : '') + ' · ' + fmt.sec(r.turnTime, 0) + ' at lights · <b>' + fmt.sec(r.time, 0) + '</b>'; };
    return '<div class="tip-rider"><div class="tip-row">To next stop</div>'
      + '<div class="tip-muted">Route taken: ' + line(a) + '</div>'
      + '<div class="tip-muted">x-then-y route: ' + (b ? line(b) : 'blocked by the threat zone') + '</div></div>';
  }

  function showCabTip(view, cab, e) {
    var world = view.world;
    var n = cab.onboard.length;
    var status = cab.evac ? 'Driving out of the threat zone'
      : !cab.riders.length ? 'Idle'
      : n === 2 ? 'Carrying 2 — shared'
      : n === 1 ? (cab.onboard[0].pool ? 'Pool, 1 aboard' : 'Solo ride')
      : 'Driving to pickup';
    var times = world.evalPlan(cab, cab.plan, null, false);
    times = cab.plan.map(function (s) {
      return s.type === 'pickup' ? times.picks[s.rider.id] : times.drops[s.rider.id];
    });
    var html = '<div class="tip-title">Cab ' + cab.id + ' · ' + status + (cab.waitLeft > 0 ? ' · waiting ' + fmt.sec(cab.waitLeft) + ' at a light' : '') + '</div>';
    cab.riders.forEach(function (r) { html += riderLine(world, cab, r, times); });
    html += legLine(world, cab);
    html += '<div class="tip-rider"><div class="tip-row">Earned<b>' + fmt.money(cab.earnings) + '</b></div>'
      + (cab.premium > 0 ? '<div class="tip-row tip-muted">incl. 2-aboard premium<b>' + fmt.money(cab.premium) + '</b></div>' : '')
      + (cab.topUp > 0 ? '<div class="tip-row tip-muted">incl. guarantee top-ups<b>' + fmt.money(cab.topUp) + '</b></div>' : '')
      + '<div class="tip-row tip-muted">Trips completed<b>' + cab.trips + '</b></div>'
      + '<div class="tip-row tip-muted">Idle / engaged<b>' + fmt.sec(cab.time.idle, 0) + ' / ' + fmt.sec(cab.time.empty + cab.time.one + cab.time.two, 0) + '</b></div></div>';
    showTip(html, e);
  }

  function wireMap(view) {
    var canvas = view.canvas;
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var cab = view.cabAt(e.clientX - rect.left, e.clientY - rect.top);
      view.hoverCab = cab;
      if (cab) {
        state.hover = { view: view, cab: cab, event: { clientX: e.clientX, clientY: e.clientY } };
        showCabTip(view, cab, e);
        canvas.style.cursor = 'pointer';
      } else {
        state.hover = null;
        hideTip();
        canvas.style.cursor = '';
      }
    });
    canvas.addEventListener('mouseleave', function () {
      view.hoverCab = null;
      state.hover = null;
      hideTip();
    });
  }

  // ------------------------------------------------------------ tooltip

  function showTip(html, e) {
    var tip = els.tooltip;
    tip.innerHTML = html;
    tip.hidden = false;
    var pad = 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { els.tooltip.hidden = true; }

  document.addEventListener('mousemove', function (e) {
    if (state.hover) return;
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t.getAttribute('data-tip')) showTip(t.getAttribute('data-tip'), e);
    else if (!(e.target.closest && e.target.closest('.hit-line'))) hideTip();
  });

  // ------------------------------------------------------------ report

  function openReport() {
    var sim = state.sim;
    state.hover = null;
    views.pool.hoverCab = views.base.hoverCab = null;
    hideTip();
    state.summary = Metrics.summarize(sim);
    els.reportPanel.innerHTML = Report.render(state.summary);
    els.report.hidden = false;
    document.body.style.overflow = 'hidden';
    els.report.scrollTop = 0;
    els.reportPanel.querySelectorAll('svg[data-line]').forEach(function (svg) {
      Report.wireLineChart(svg, showTip, hideTip);
    });
    runSweep(sim.cfg, sim.zoneEvents.slice());
    runCompare(sim.cfg, sim.t, state.summary);
    els.reportPanel.focus();
  }

  // Original rules vs enhanced rules: the same city (same seed and settings)
  // re-run to the same moment with the other rule set. Runs are deterministic,
  // so the other column is a real run, not an estimate.
  var compareCache = {};
  var compareJob = 0;
  var compareWorker = null;

  function spawnWorker() {
    var src = workerSource(), urls = [];
    try { urls.push(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch (e) { /* no blobs */ }
    urls.push('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
    for (var u = 0; u < urls.length; u++) {
      try { return new Worker(urls[u]); } catch (e) { /* try the next */ }
    }
    return null;
  }

  function stopCompare() {
    compareJob++;
    if (compareWorker) { compareWorker.terminate(); compareWorker = null; }
  }

  function runCompare(cfg, t, summary) {
    stopCompare();
    var job = compareJob;
    var mine = Metrics.scorecard(summary);
    var original = isOriginalRules(cfg);
    var enhanced = {};
    Object.keys(Sim.ORIGINAL_RULES).forEach(function (k) { enhanced[k] = Sim.DEFAULTS[k]; });
    var otherCfg = Object.assign({}, cfg, original ? enhanced : Sim.ORIGINAL_RULES);
    var events = state.sim.zoneEvents.slice();
    var key = JSON.stringify(otherCfg) + '@' + t + JSON.stringify(events);

    function show(other) {
      var body = $('ab-body');
      if (!body || job !== compareJob) return;
      body.innerHTML = original
        ? Report.abHtml(mine, other, cfg, 'Original rules (yours)', 'Enhanced defaults')
        : Report.abHtml(other, mine, cfg, 'Original rules', 'Your rules');
    }
    if (compareCache[key]) { show(compareCache[key]); return; }
    function done(card) { compareCache[key] = card; show(card); }

    compareWorker = spawnWorker();
    if (compareWorker) {
      compareWorker.onmessage = function (e) {
        if (e.data.job !== compareJob) return;
        compareWorker.terminate(); compareWorker = null;
        done(e.data.card);
      };
      compareWorker.onerror = function () {
        if (job !== compareJob) return;
        compareWorker.terminate(); compareWorker = null;
        setTimeout(function () { if (job === compareJob) done(Metrics.scorecardAt(otherCfg, t, events)); }, 0);
      };
      compareWorker.postMessage({ type: 'compare', job: job, cfg: otherCfg, t: t, events: events });
    } else {
      setTimeout(function () { if (job === compareJob) done(Metrics.scorecardAt(otherCfg, t, events)); }, 30);
    }
  }

  // Radius sweep: re-run this city at a range of ping radii. Runs in Web
  // Workers built from the engine's own source, so the page stays smooth and
  // it still works from file://. Falls back to small main-thread chunks.
  var sweepCache = {};
  var sweepJob = 0;
  var sweepWorkers = [];

  function workerSource() {
    return '(' + window.definePoolSim.toString() + ')(self);\n'
      + '(' + window.definePoolMetrics.toString() + ')(self);\n'
      + 'self.onmessage = function (e) {\n'
      + '  var d = e.data;\n'
      + '  if (d.type === "compare") { self.postMessage({ job: d.job, card: self.PoolMetrics.scorecardAt(d.cfg, d.t, d.events) }); return; }\n'
      + '  self.postMessage({ job: d.job, idx: d.idx, point: self.PoolMetrics.sweepPoint(d.cfg, d.radius, d.seeds, d.events) });\n'
      + '};\n';
  }

  function startWorkers(n) {
    stopWorkers();
    var src = workerSource();
    var urls = [];
    try { urls.push(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch (e) { /* no blobs */ }
    urls.push('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
    for (var u = 0; u < urls.length && !sweepWorkers.length; u++) {
      try {
        for (var i = 0; i < n; i++) sweepWorkers.push(new Worker(urls[u]));
      } catch (e) {
        stopWorkers();
      }
    }
    return sweepWorkers.length > 0;
  }

  function stopWorkers() {
    sweepWorkers.forEach(function (w) { w.terminate(); });
    sweepWorkers = [];
  }

  function runSweep(cfg, events) {
    var key = JSON.stringify(cfg) + JSON.stringify(events);
    var job = ++sweepJob;
    var radii = Metrics.sweepRadii(cfg);
    // Average over 3 random cities unless the city is big enough to be slow.
    // A threat zone means full route searches, so one city keeps the sweep quick.
    var seeds = cfg.riders <= 400 && cfg.duration <= 600 && !events.length ? 3 : 1;
    var points = new Array(radii.length), done = 0;

    function show(entry) {
      var body = $('sweep-body');
      if (body) body.innerHTML = Report.sweepHtml(entry.points, cfg, entry.seeds);
    }
    function progress() {
      var prog = $('sweep-progress');
      if (prog) prog.textContent = 'Running the radius sweep… ' + done + ' of ' + radii.length + ' radii';
    }
    function finish() {
      sweepCache[key] = { points: points, seeds: seeds };
      show(sweepCache[key]);
    }
    if (sweepCache[key]) { show(sweepCache[key]); return; }

    var n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    if (startWorkers(n)) {
      var next = 0, failed = false;
      var feed = function (w) {
        if (next >= radii.length) return;
        var idx = next++;
        w.postMessage({ job: job, idx: idx, cfg: cfg, radius: radii[idx], seeds: seeds, events: events });
      };
      sweepWorkers.forEach(function (w) {
        w.onmessage = function (e) {
          if (e.data.job !== sweepJob) return;
          points[e.data.idx] = e.data.point;
          done++;
          progress();
          if (done === radii.length) { stopWorkers(); finish(); } else feed(w);
        };
        w.onerror = function () {
          if (failed || job !== sweepJob) return;
          failed = true;
          stopWorkers();
          runOnMainThread();
        };
        feed(w);
      });
      return;
    }
    runOnMainThread();

    function runOnMainThread() {
      points = []; done = 0;
      (function tick() {
        if (job !== sweepJob) return;
        var t0 = performance.now();
        while (done < radii.length && performance.now() - t0 < 30) {
          points.push(Metrics.sweepPoint(cfg, radii[done], seeds, events));
          done++;
        }
        progress();
        if (done < radii.length) setTimeout(tick, 0);
        else finish();
      })();
    }
  }

  function closeReport() {
    sweepJob++;
    stopWorkers();
    stopCompare();
    if (els.report.hidden) return;
    els.report.hidden = true;
    document.body.style.overflow = '';
    hideTip();
  }

  els.report.addEventListener('click', function (e) {
    if (e.target === els.report || e.target.closest('[data-close]')) {
      closeReport();
      return;
    }
    var tryBtn = e.target.closest('[data-patch]');
    if (tryBtn) {
      var patch = JSON.parse(tryBtn.getAttribute('data-patch'));
      Object.keys(patch).forEach(function (k) { state.cfg[k] = clampValue(inputs[k].def, patch[k]); });
      keepConsistent();
      syncControls();
      newRun();
      start();
    }
  });

  // ------------------------------------------------------------ sizing & theme

  function layoutMaps() {
    var wraps = document.querySelectorAll('.canvas-wrap');
    var size = Infinity;
    wraps.forEach(function (w) { size = Math.min(size, w.clientWidth); });
    if (!isFinite(size) || size <= 0) return;
    views.pool.resize(size);
    views.base.resize(size);
  }

  // ------------------------------------------------------------ wiring

  els.start.addEventListener('click', toggle);
  els.reset.addEventListener('click', function () { closeReport(); newRun(); });
  els.reportBtn.addEventListener('click', openReport);
  els.defaults.addEventListener('click', function () {
    if (isLocked()) return;
    state.cfg = Object.assign({}, Sim.DEFAULTS);
    syncControls();
    newRun();
  });
  // Every enhancement off: behaves exactly like the original simulation.
  els.original.addEventListener('click', function () {
    if (isLocked()) return;
    Object.assign(state.cfg, Sim.ORIGINAL_RULES, { rightTurnDelay: 0 }); // the original city had no lights
    syncControls();
    newRun();
  });

  els.zoneBtn.addEventListener('click', function () {
    if (state.status === 'finished') return;
    setArming(!state.arming);
  });
  els.zoneClear.addEventListener('click', function () {
    state.sim.clearZone();
    updateUi();
  });
  [views.pool, views.base].forEach(function (view) {
    view.canvas.addEventListener('click', function (e) {
      if (!state.arming || state.status === 'finished') return;
      var rect = view.canvas.getBoundingClientRect();
      var node = view.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      state.sim.declareZone(node.x, node.y);
      setArming(false);
      updateUi();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.arming) { setArming(false); return; }
    if (e.key === 'Escape' && !els.report.hidden) { closeReport(); return; }
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.code === 'Space' && tag !== 'input' && tag !== 'button' && els.report.hidden) {
      e.preventDefault();
      toggle();
    }
  });

  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var onTheme = function () { views.pool.setTheme(); views.base.setTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onTheme);
  else if (mq.addListener) mq.addListener(onTheme);

  if (window.ResizeObserver) {
    new ResizeObserver(layoutMaps).observe(document.querySelector('.maps'));
  } else {
    window.addEventListener('resize', layoutMaps);
  }

  buildControls();
  buildSpeed();
  wireMap(views.pool);
  wireMap(views.base);
  newRun();
  layoutMaps();
  requestAnimationFrame(frame);
})();
