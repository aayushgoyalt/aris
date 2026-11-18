/* PoolSim report — formatting, SVG charts and the end-of-run report. */
(function (root) {
  'use strict';

  var MINUS = '−';

  // ------------------------------------------------------------- formatting

  function ok(v) { return v != null && isFinite(v); }
  var fmt = {
    money: function (v) {
      if (!ok(v)) return '—';
      var a = Math.abs(v);
      var s = a >= 100000 ? '$' + (a / 1000).toFixed(0) + 'K'
        : a >= 10000 ? '$' + (a / 1000).toFixed(1) + 'K'
        : a >= 100 ? '$' + Math.round(a).toLocaleString('en-US')
        : '$' + a.toFixed(2);
      return (v < -0.005 ? MINUS : '') + s;
    },
    signedMoney: function (v) {
      if (!ok(v)) return '—';
      return (v > 0.005 ? '+' : v < -0.005 ? MINUS : '') + fmt.money(Math.abs(v));
    },
    sec: function (v, d) { return ok(v) ? v.toFixed(d == null ? 1 : d) + ' s' : '—'; },
    signedSec: function (v, d) {
      if (!ok(v)) return '—';
      var s = Math.abs(v).toFixed(d == null ? 1 : d);
      return (Number(s) === 0 ? '' : v > 0 ? '+' : MINUS) + s + ' s';
    },
    pct: function (v, d) { return ok(v) ? (v * 100).toFixed(d || 0) + '%' : '—'; },
    signedPct: function (v, d) {
      if (!ok(v)) return '—';
      var s = Math.abs(v * 100).toFixed(d || 0);
      return (Number(s) === 0 ? '' : v > 0 ? '+' : MINUS) + s + '%';
    },
    ratio: function (v) { return ok(v) ? v.toFixed(2) + '×' : '—'; },
    int: function (v) { return ok(v) ? Math.round(v).toLocaleString('en-US') : '—'; },
    signedInt: function (v) {
      if (!ok(v)) return '—';
      var n = Math.round(v);
      return (n > 0 ? '+' : n < 0 ? MINUS : '') + Math.abs(n).toLocaleString('en-US');
    },
  };

  // Direction class for a delta: is this change good for the reader?
  function tone(v, upIsGood) {
    if (!ok(v) || Math.abs(v) < 1e-9) return 'flat';
    return (v > 0) === upIsGood ? 'good' : 'bad';
  }

  function attr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ------------------------------------------------------------- chart kit

  function niceStep(span, count) {
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  function ticks(lo, hi, count) {
    if (hi - lo < 1e-9) hi = lo + 1;
    var step = niceStep(hi - lo, count);
    var out = [];
    for (var v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(+v.toFixed(10));
    return out;
  }

  // Column with a 4px rounded data-end, square at the baseline.
  function colPath(x, y0, w, y1) {
    var top = Math.min(y0, y1), h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    var r = Math.min(4, w / 2, h);
    if (y1 <= y0) {
      return 'M' + x + ',' + (top + h) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top
        + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + top + ' ' + (x + w) + ',' + (top + r) + 'V' + (top + h) + 'Z';
    }
    var bot = top + h;
    return 'M' + x + ',' + top + 'V' + (bot - r) + 'Q' + x + ',' + bot + ' ' + (x + r) + ',' + bot
      + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + bot + ' ' + (x + w) + ',' + (bot - r) + 'V' + top + 'Z';
  }
  // Horizontal bar from x0 to x1 with the rounded end at x1.
  function barPath(x0, x1, y, h) {
    var w = Math.abs(x1 - x0);
    if (w < 0.5) return '';
    var r = Math.min(4, h / 2, w);
    if (x1 >= x0) {
      return 'M' + x0 + ',' + y + 'H' + (x1 - r) + 'Q' + x1 + ',' + y + ' ' + x1 + ',' + (y + r)
        + 'V' + (y + h - r) + 'Q' + x1 + ',' + (y + h) + ' ' + (x1 - r) + ',' + (y + h) + 'H' + x0 + 'Z';
    }
    return 'M' + x0 + ',' + y + 'H' + (x1 + r) + 'Q' + x1 + ',' + y + ' ' + x1 + ',' + (y + r)
      + 'V' + (y + h - r) + 'Q' + x1 + ',' + (y + h) + ' ' + (x1 + r) + ',' + (y + h) + 'H' + x0 + 'Z';
  }

  function svgOpen(W, H, label) {
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + attr(label) + '">';
  }

  function empty(msg) { return '<div class="chart-empty">' + msg + '</div>'; }

  // In-car time / original estimate, stacked: shared vs rode alone.
  function histogramChart(bins, cap) {
    var total = bins.reduce(function (s, b) { return s + b.matched + b.unmatched; }, 0);
    if (!total) return empty('No completed pool trips yet.');
    var W = 520, H = 230, m = { l: 40, r: 16, t: 26, b: 34 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var yt = ticks(0, Math.max.apply(null, bins.map(function (b) { return b.matched + b.unmatched; })), 4);
    var yMax = yt[yt.length - 1];
    var lo = bins[0].lo, hi = bins[bins.length - 1].hi;
    function x(v) { return m.l + (v - lo) / (hi - lo) * iw; }
    function y(v) { return m.t + ih - v / yMax * ih; }
    var band = iw / bins.length;
    var bw = Math.min(24, band - 4);
    var out = svgOpen(W, H, 'Histogram of pool riders’ in-car time relative to their solo estimate');
    yt.forEach(function (v) {
      out += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="tick" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    var xs = ticks(lo, hi, hi - lo > 1 ? 6 : 5);
    xs.forEach(function (v) {
      if (v < lo - 1e-9 || v > hi + 1e-9) return;
      out += '<text class="tick" x="' + x(v) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + v.toFixed(2) + '×</text>';
    });
    bins.forEach(function (b, i) {
      var cx = m.l + i * band + (band - bw) / 2;
      var y0 = y(0), yU = y(b.unmatched), yAll = y(b.unmatched + b.matched);
      if (b.unmatched) out += '<path class="fill-pool1" d="' + colPath(cx, y0, bw, yU) + '"/>';
      if (b.matched) out += '<path class="fill-shared" d="' + colPath(cx, b.unmatched ? yU - 2 : y0, bw, yAll - (b.unmatched ? 2 : 0)) + '"/>';
      var tip = '<b>' + b.lo.toFixed(2) + '–' + b.hi.toFixed(2) + '× estimate</b><br>' + b.matched + ' shared a ride<br>' + b.unmatched + ' rode alone';
      out += '<rect class="hit" x="' + (m.l + i * band) + '" y="' + m.t + '" width="' + band + '" height="' + ih + '" data-tip="' + attr(tip) + '"/>';
    });
    out += '<line class="axis" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    var cx = x(cap);
    out += '<line class="ref" x1="' + cx + '" x2="' + cx + '" y1="' + (m.t - 8) + '" y2="' + y(0) + '"/>';
    out += '<text class="ref-label" x="' + (cx - 6) + '" y="' + (m.t - 12) + '" text-anchor="end">' + cap.toFixed(2) + '× promise</text>';
    return out + '</svg>';
  }

  // Signed seconds per row, grouped; faster is good.
  function deltaChart(groups) {
    var rows = [];
    groups.forEach(function (g) { if (g.d && g.d.n) rows.push(g); });
    if (!rows.length) return empty('No rider finished in both cities yet.');
    var W = 520, label = 150, rowH = 26, headH = 24, m = { t: 6, r: 64, b: 8 };
    var H = m.t + m.b + rows.length * (headH + 3 * rowH) + (rows.length - 1) * 10;
    var maxAbs = 1;
    rows.forEach(function (g) { ['wait', 'ride', 'total'].forEach(function (k) { maxAbs = Math.max(maxAbs, Math.abs(g.d[k])); }); });
    var plotL = label + m.r, plotR = W - m.r;
    var zero = (plotL + plotR) / 2;
    var half = (plotR - plotL) / 2;
    function x(v) { return zero + v / maxAbs * half; }
    var out = svgOpen(W, H, 'Door-to-door time change versus the no-pool city');
    var yy = m.t;
    var top = m.t;
    rows.forEach(function (g, gi) {
      if (gi) yy += 10;
      out += '<text class="row-head" x="0" y="' + (yy + 15) + '">' + g.label + '</text>';
      out += '<text class="tick" x="' + W + '" y="' + (yy + 15) + '" text-anchor="end">' + g.d.n + ' riders</text>';
      yy += headH;
      [['Waiting for pickup', 'wait'], ['In the car', 'ride'], ['Door to door', 'total']].forEach(function (row) {
        var v = g.d[row[1]];
        var cls = Math.abs(v) < 0.05 ? 'fill-flat' : v < 0 ? 'fill-good' : 'fill-bad';
        var by = yy + (rowH - 12) / 2;
        out += '<text class="row-label' + (row[1] === 'total' ? ' strong' : '') + '" x="0" y="' + (yy + rowH / 2 + 4) + '">' + row[0] + '</text>';
        out += '<path class="' + cls + '" d="' + barPath(zero, x(v), by, 12) + '"/>';
        var lx = v < 0 ? x(v) - 6 : x(v) + 6;
        out += '<text class="val' + (row[1] === 'total' ? ' strong' : '') + '" x="' + lx + '" y="' + (yy + rowH / 2 + 4) + '" text-anchor="' + (v < 0 ? 'end' : 'start') + '">' + fmt.signedSec(v) + '</text>';
        var tip = '<b>' + g.label + ' · ' + row[0].toLowerCase() + '</b><br>' + fmt.signedSec(v) + ' on average vs the same riders in the no-pool city';
        out += '<rect class="hit" x="' + label + '" y="' + yy + '" width="' + (W - label) + '" height="' + rowH + '" data-tip="' + attr(tip) + '"/>';
        yy += rowH;
      });
    });
    out += '<line class="axis" x1="' + zero + '" x2="' + zero + '" y1="' + top + '" y2="' + (H - m.b) + '"/>';
    return out + '</svg>';
  }

  // Baseline earnings -> each effect -> pool earnings.
  function waterfallChart(s) {
    var steps = [
      { label: 'No-pool\ncity', value: s.base, kind: 'total', cls: 'fill-base' },
      { label: 'Shared s\npaid once', value: s.lostToSharing, kind: 'delta' },
      { label: 'Detour s\npaid', value: s.detourPay, kind: 'delta' },
      { label: 'Premium\nX', value: s.premium, kind: 'delta' },
      { label: 'Driver\nguarantee', value: s.guarantee, kind: 'delta' },
      { label: 'Fleet\neffect', value: s.fleet, kind: 'delta' },
      { label: 'Pool\ncity', value: s.pool, kind: 'total', cls: 'fill-shared' },
    ];
    var run = 0, lo = 0, hi = 0;
    steps.forEach(function (st) {
      if (st.kind === 'total') { st.from = 0; st.to = st.value; run = st.value; }
      else { st.from = run; st.to = run + st.value; run = st.to; }
      lo = Math.min(lo, st.from, st.to); hi = Math.max(hi, st.from, st.to);
    });
    var W = 520, H = 250, m = { l: 52, r: 8, t: 22, b: 40 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var yt = ticks(lo, hi, 4);
    var y0 = yt[0], y1 = yt[yt.length - 1];
    function y(v) { return m.t + ih - (v - y0) / (y1 - y0) * ih; }
    var band = iw / steps.length, bw = Math.min(40, band - 16);
    var out = svgOpen(W, H, 'Driver earnings: no-pool city to pool city');
    yt.forEach(function (v) {
      out += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="tick" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + fmt.money(v).replace('.00', '') + '</text>';
    });
    steps.forEach(function (st, i) {
      var bx = m.l + i * band + (band - bw) / 2;
      var cls = st.cls || (st.value >= 0 ? 'fill-good' : 'fill-bad');
      out += '<path class="' + cls + '" d="' + colPath(bx, y(st.from), bw, y(st.to)) + '"/>';
      if (i < steps.length - 1) {
        out += '<line class="connector" x1="' + (bx + bw) + '" x2="' + (bx + band) + '" y1="' + y(st.to) + '" y2="' + y(st.to) + '"/>';
      }
      var labelY = st.to >= st.from ? y(st.to) - 6 : y(st.to) + 14;
      if (st.kind === 'total') labelY = y(Math.max(st.to, 0)) - 6;
      out += '<text class="val' + (st.kind === 'total' ? ' strong' : '') + '" x="' + (bx + bw / 2) + '" y="' + labelY + '" text-anchor="middle">'
        + (st.kind === 'total' ? fmt.money(st.value) : fmt.signedMoney(st.value)) + '</text>';
      st.label.split('\n').forEach(function (ln, k) {
        out += '<text class="tick" x="' + (bx + bw / 2) + '" y="' + (H - m.b + 16 + k * 13) + '" text-anchor="middle">' + ln + '</text>';
      });
      out += '<rect class="hit" x="' + (m.l + i * band) + '" y="' + m.t + '" width="' + band + '" height="' + ih + '" data-tip="' + attr(st.tip || '') + '"/>';
    });
    out += '<line class="axis" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    return out + '</svg>';
  }

  // Riders waiting over time, both cities. Hover handled by wireLineChart.
  function lineChart(pool, base, key) {
    if (pool.length < 2) return empty('Not enough samples yet.');
    var W = 1000, H = 230, m = { l: 44, r: 120, t: 14, b: 30 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var tMax = pool[pool.length - 1].t || 1;
    var vMax = 1;
    pool.concat(base).forEach(function (p) { vMax = Math.max(vMax, p[key]); });
    var yt = ticks(0, vMax, 4), yMax = yt[yt.length - 1];
    function x(t) { return m.l + t / tMax * iw; }
    function y(v) { return m.t + ih - v / yMax * ih; }
    function path(arr) {
      return arr.map(function (p, i) { return (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p[key]).toFixed(1); }).join('');
    }
    var out = svgOpen(W, H, 'Riders waiting for a pickup over time, with and without Pool');
    out = out.replace('<svg ', '<svg data-line="' + key + '" ');
    yt.forEach(function (v) {
      out += '<line class="grid" x1="' + m.l + '" x2="' + (m.l + iw) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="tick" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    ticks(0, tMax, 6).forEach(function (t) {
      if (t > tMax + 1e-9) return;
      out += '<text class="tick" x="' + x(t) + '" y="' + (H - m.b + 18) + '" text-anchor="middle">' + t + ' s</text>';
    });
    out += '<line class="axis" x1="' + m.l + '" x2="' + (m.l + iw) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    out += '<path class="line-base" d="' + path(base) + '"/>';
    out += '<path class="line-pool" d="' + path(pool) + '"/>';
    var lb = base[base.length - 1], lp = pool[pool.length - 1];
    var yb = y(lb[key]), yp = y(lp[key]);
    if (Math.abs(yb - yp) < 16) { if (yb >= yp) { yb += 8; yp -= 8; } else { yb -= 8; yp += 8; } }
    out += '<circle class="dot-base" cx="' + x(lb.t) + '" cy="' + y(lb[key]) + '" r="4"/>';
    out += '<circle class="dot-pool" cx="' + x(lp.t) + '" cy="' + y(lp[key]) + '" r="4"/>';
    out += '<text class="val" x="' + (x(lp.t) + 10) + '" y="' + (yp + 4) + '">With Pool ' + lp[key] + '</text>';
    out += '<text class="val" x="' + (x(lb.t) + 10) + '" y="' + (yb + 4) + '">No Pool ' + lb[key] + '</text>';
    out += '<g class="crosshair" style="display:none"><line class="ref" y1="' + m.t + '" y2="' + y(0) + '"/>'
      + '<circle class="dot-base" r="4"/><circle class="dot-pool" r="4"/></g>';
    out += '<rect class="hit-line" x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '"/>';
    lineData[key] = { pool: pool, base: base, x: x, y: y, tMax: tMax, iw: iw, l: m.l, W: W };
    return out + '</svg>';
  }
  var lineData = {};

  function wireLineChart(svg, showTip, hideTip) {
    var d = lineData[svg.getAttribute('data-line')];
    var key = svg.getAttribute('data-line');
    if (!d) return;
    var hit = svg.querySelector('.hit-line');
    var cross = svg.querySelector('.crosshair');
    var line = cross.querySelector('line');
    var dots = cross.querySelectorAll('circle');
    hit.addEventListener('mousemove', function (e) {
      var rect = svg.getBoundingClientRect();
      var vx = (e.clientX - rect.left) / rect.width * d.W;
      var t = Math.max(0, Math.min(d.tMax, (vx - d.l) / d.iw * d.tMax));
      var i = Math.min(d.pool.length - 1, Math.round(t / (d.tMax / (d.pool.length - 1))));
      var p = d.pool[i], b = d.base[Math.min(i, d.base.length - 1)];
      var px = d.x(p.t);
      cross.style.display = '';
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      dots[0].setAttribute('cx', d.x(b.t)); dots[0].setAttribute('cy', d.y(b[key]));
      dots[1].setAttribute('cx', px); dots[1].setAttribute('cy', d.y(p[key]));
      showTip('<b>t = ' + p.t.toFixed(0) + ' s</b>'
        + '<div class="tip-row"><span class="key key-pool"></span>With Pool<b>' + p[key] + '</b></div>'
        + '<div class="tip-row"><span class="key key-base"></span>No Pool<b>' + b[key] + '</b></div>', e);
    });
    hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; hideTip(); });
  }

  // ------------------------------------------------------------- report

  // Stacked horizontal bars on one absolute scale, one row per city.
  // rows: [{ label, values: { key: n }, note }]; states: [{ key, label, cls, dark }]
  function stackBars(rows, states, unit, ariaLabel) {
    var W = 1000, labelW = 84, noteW = 170, barH = 24, gap = 14, m = { t: 4, b: 4 };
    var H = m.t + m.b + rows.length * barH + (rows.length - 1) * gap;
    var iw = W - labelW - noteW;
    var max = 0;
    rows.forEach(function (r) {
      r.total = states.reduce(function (s, st) { return s + (r.values[st.key] || 0); }, 0);
      max = Math.max(max, r.total);
    });
    var out = svgOpen(W, H, ariaLabel);
    rows.forEach(function (row, i) {
      var y = m.t + i * (barH + gap);
      out += '<text class="row-label strong" x="0" y="' + (y + barH / 2 + 4) + '">' + row.label + '</text>';
      var x = labelW;
      var vis = states.filter(function (st) { return row.values[st.key] > 0; });
      vis.forEach(function (st, k) {
        var v = row.values[st.key];
        var w = max > 0 ? v / max * iw : 0;
        var segW = Math.max(0, w - (k < vis.length - 1 ? 2 : 0));
        out += k === vis.length - 1
          ? '<path class="' + st.cls + '" d="' + barPath(x, x + segW, y, barH) + '"/>'
          : '<rect class="' + st.cls + '" x="' + x + '" y="' + y + '" width="' + segW + '" height="' + barH + '"/>';
        var share = row.total > 0 ? v / row.total : 0;
        if (segW > 46) {
          out += '<text class="in-label' + (st.dark ? ' dark' : '') + '" x="' + (x + 8) + '" y="' + (y + barH / 2 + 4) + '">' + fmt.pct(share) + '</text>';
        }
        var tip = '<b>' + row.label + ' · ' + st.label + '</b><br>' + fmt.pct(share, 1) + ' · ' + fmt.int(v) + ' ' + unit;
        out += '<rect class="hit" x="' + x + '" y="' + y + '" width="' + Math.max(1, w) + '" height="' + barH + '" data-tip="' + attr(tip) + '"/>';
        x += w;
      });
      out += '<text class="val strong" x="' + (labelW + (max > 0 ? row.total / max : 0) * iw + 10) + '" y="' + (y + barH / 2 + 4) + '">' + row.note + '</text>';
    });
    return out + '</svg>';
  }

  // One column per driver, stacked by how they spent the run, most engaged first.
  function driverColumns(perDriver, states, title) {
    var W = 500, H = 170, m = { l: 34, r: 4, t: 8, b: 22 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var rows = perDriver.map(function (d) {
      var total = d.time.idle + d.time.empty + d.time.one + d.time.two;
      return { d: d, total: total, idle: total > 0 ? d.time.idle / total : 1 };
    }).sort(function (a, b) { return a.idle - b.idle; });
    var n = rows.length;
    var colW = iw / n, gap = colW >= 5 ? 1 : 0;
    var out = svgOpen(W, H, title);
    [0, 0.5, 1].forEach(function (v) {
      var y = m.t + ih - v * ih;
      out += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y + '" y2="' + y + '"/>';
      out += '<text class="tick" x="' + (m.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + (v * 100) + '%</text>';
    });
    var stack = ['two', 'one', 'empty', 'idle']; // engaged states at the bottom
    rows.forEach(function (row, i) {
      var x = m.l + i * colW;
      var y = m.t + ih;
      stack.forEach(function (key) {
        var st = states.filter(function (s) { return s.key === key; })[0];
        var h = row.total > 0 ? row.d.time[key] / row.total * ih : 0;
        if (h > 0.2) out += '<rect class="' + st.cls + '" x="' + x + '" y="' + (y - h) + '" width="' + Math.max(0.6, colW - gap) + '" height="' + h + '"/>';
        y -= h;
      });
      var t = row.total || 1;
      var tip = '<b>Driver ' + row.d.id + '</b>'
        + stack.slice().reverse().map(function (key) {
          var st = states.filter(function (s) { return s.key === key; })[0];
          return '<div class="tip-row"><span class="key ' + st.cls + '"></span>' + st.label + '<b>' + fmt.pct(row.d.time[key] / t) + '</b></div>';
        }).join('')
        + '<div class="tip-row">Earned<b>' + fmt.money(row.d.earnings) + '</b></div>';
      out += '<rect class="hit" x="' + x + '" y="' + m.t + '" width="' + colW + '" height="' + ih + '" data-tip="' + attr(tip) + '"/>';
    });
    out += '<text class="tick" x="' + m.l + '" y="' + (H - 6) + '">Most engaged</text>';
    out += '<text class="tick" x="' + (W - m.r) + '" y="' + (H - 6) + '" text-anchor="end">Most idle</text>';
    return out + '</svg>';
  }

  function coRiderChart(counts) {
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return empty('No completed pool trips yet.');
    var labels = ['Rode alone', '1 co-rider', '2 co-riders', '3 or more'];
    var W = 520, H = 210, m = { l: 40, r: 10, t: 20, b: 30 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var yt = ticks(0, Math.max.apply(null, counts), 4), yMax = yt[yt.length - 1];
    function y(v) { return m.t + ih - v / yMax * ih; }
    var band = iw / counts.length, bw = Math.min(24, band - 8);
    var out = svgOpen(W, H, 'Pool riders by number of different co-riders on one trip');
    yt.forEach(function (v) {
      out += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="tick" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    counts.forEach(function (c, i) {
      var x = m.l + i * band + (band - bw) / 2;
      out += '<path class="' + (i ? 'fill-shared' : 'fill-pool1') + '" d="' + colPath(x, y(0), bw, y(c)) + '"/>';
      out += '<text class="val strong" x="' + (x + bw / 2) + '" y="' + (y(c) - 6) + '" text-anchor="middle">' + c + '</text>';
      out += '<text class="tick" x="' + (x + bw / 2) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + labels[i] + '</text>';
      out += '<rect class="hit" x="' + (m.l + i * band) + '" y="' + m.t + '" width="' + band + '" height="' + ih + '" data-tip="'
        + attr('<b>' + labels[i] + '</b><br>' + c + ' pool riders (' + fmt.pct(c / total) + ')') + '"/>';
    });
    out += '<line class="axis" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    return out + '</svg>';
  }

  // ------------------------------------------------------------- radius sweep

  function radiusLabel(r, cfg) { return r >= 2 * (cfg.gridSize - 1) ? '∞' : String(r); }

  function sweepChart(points, cfg, metric, recIdx) {
    var W = 340, H = 220, m = { l: 40, r: 12, t: 30, b: 30 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = points.length;
    var vMax = 0;
    points.forEach(function (p) { vMax = Math.max(vMax, p.pool[metric.key] || 0, p.base[metric.key] || 0); });
    var yt = ticks(0, vMax || 1, 4), yMax = yt[yt.length - 1];
    function x(i) { return m.l + (n > 1 ? i / (n - 1) : 0.5) * iw; }
    function y(v) { return m.t + ih - (v || 0) / yMax * ih; }
    var out = svgOpen(W, H, metric.label + ' by ping radius');
    yt.forEach(function (v) {
      out += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="tick" x="' + (m.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    var every = n > 10 ? 2 : 1;
    points.forEach(function (p, i) {
      if (i % every && i !== n - 1) return;
      out += '<text class="tick" x="' + x(i) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + radiusLabel(p.radius, cfg) + '</text>';
    });
    out += '<line class="axis" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    var curIdx = -1;
    points.forEach(function (p, i) { if (p.radius === cfg.pingRadius) curIdx = i; });
    if (curIdx >= 0) {
      out += '<line class="ref-soft" x1="' + x(curIdx) + '" x2="' + x(curIdx) + '" y1="' + (m.t - 6) + '" y2="' + y(0) + '"/>';
      out += '<text class="tick" x="' + x(curIdx) + '" y="' + (m.t - 10) + '" text-anchor="' + (curIdx > recIdx ? 'start' : 'end') + '">you</text>';
    }
    out += '<line class="ref" x1="' + x(recIdx) + '" x2="' + x(recIdx) + '" y1="' + (m.t - 6) + '" y2="' + y(0) + '"/>';
    out += '<text class="ref-label" x="' + x(recIdx) + '" y="' + (m.t - 10) + '" text-anchor="' + (curIdx > recIdx ? 'end' : 'start') + '">best</text>';
    ['base', 'pool'].forEach(function (w) {
      var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p[w][metric.key]).toFixed(1); }).join('');
      out += '<path class="line-' + w + '" d="' + d + '"/>';
    });
    out += '<circle class="dot-pool" cx="' + x(recIdx) + '" cy="' + y(points[recIdx].pool[metric.key]) + '" r="4"/>';
    points.forEach(function (p, i) {
      var half = iw / Math.max(1, n - 1) / 2;
      var tip = '<b>Radius ' + radiusLabel(p.radius, cfg) + ' blocks</b>'
        + '<div class="tip-row"><span class="key key-pool"></span>With Pool<b>' + metric.fmt(p.pool[metric.key]) + '</b></div>'
        + '<div class="tip-row"><span class="key key-base"></span>No Pool<b>' + metric.fmt(p.base[metric.key]) + '</b></div>';
      out += '<rect class="hit" x="' + (x(i) - half) + '" y="' + m.t + '" width="' + (half * 2) + '" height="' + ih + '" data-tip="' + attr(tip) + '"/>';
    });
    return out + '</svg>';
  }

  function sweepHtml(points, cfg, seeds) {
    var M = typeof module !== 'undefined' && module.exports ? require('./metrics.js') : root.PoolMetrics;
    var rec = M.recommendRadius(points, 'pool');
    var recBase = M.recommendRadius(points, 'base');
    var idx = function (r) { for (var i = 0; i < points.length; i++) if (points[i].radius === r) return i; return 0; };
    var ri = idx(rec), bi = idx(recBase);
    var recP = points[ri], last = points[points.length - 1], first = points[0];
    var cur = points[idx(cfg.pingRadius)];
    var chaseLoss = points[bi].base.completed - last.base.completed;

    var text = '<p class="lead">Ping cabs within <b>' + rec + ' blocks</b> of driving (≈ ' + fmt.sec(rec / cfg.cabSpeed, 0) + ' away). '
      + 'That is the tightest radius that still delivers within 1% of the best this city can do with Pool'
      + (recBase !== rec ? '; without Pool it is ' + recBase + ' blocks' : '') + '. '
      + 'Tighter, riders give up before any cab is in range (' + fmt.int(first.pool.lost) + ' lost at ' + first.radius + ' blocks). '
      + 'Wider adds nothing but longer empty drives: with no limit, empty blocks per pickup go from ' + recP.pool.emptyPerPickup.toFixed(1) + ' to ' + last.pool.emptyPerPickup.toFixed(1)
      + ' with Pool and from ' + points[bi].base.emptyPerPickup.toFixed(1) + ' to ' + last.base.emptyPerPickup.toFixed(1) + ' without'
      + (chaseLoss >= 1 ? ', and the no-pool city delivers <b>' + fmt.int(chaseLoss) + ' fewer riders</b> than at its best radius: far-away dispatches keep cabs busy driving empty while closer requests go unserved (the “wild goose chase”)' : '')
      + '.</p>';
    var verdict;
    if (cur.radius === rec) verdict = 'Your setting (' + cfg.pingRadius + ' blocks) is on the mark.';
    else if (cur.radius < rec) verdict = 'Your setting (' + cfg.pingRadius + ' blocks) is tighter than needed: ' + fmt.int(Math.max(0, recP.pool.completed - cur.pool.completed)) + ' fewer riders delivered and ' + fmt.int(Math.max(0, cur.pool.lost - recP.pool.lost)) + ' more give up.';
    else verdict = 'Your setting (' + cfg.pingRadius + ' blocks) is wider than needed: ' + (cur.pool.emptyPerPickup - recP.pool.emptyPerPickup).toFixed(1) + ' more empty blocks per pickup for no extra riders.';

    var metrics = [
      { key: 'completed', label: 'Riders delivered', fmt: function (v) { return fmt.int(v); } },
      { key: 'lost', label: 'Riders who gave up', fmt: function (v) { return fmt.int(v); } },
      { key: 'emptyPerPickup', label: 'Empty blocks per pickup', fmt: function (v) { return v == null ? '—' : v.toFixed(1); } },
    ];
    return text
      + '<p class="verdict">' + verdict + (cur.radius !== rec ? ' ' + tryButton({ pingRadius: rec }, 'Use ' + rec + ' blocks') : '') + '</p>'
      + '<div class="legend-row"><span><i class="key key-pool"></i>With Pool</span><span><i class="key key-base"></i>No Pool</span>'
      + '<span class="muted">x-axis: ping radius in blocks · each point is a full ' + cfg.duration + ' s run' + (seeds > 1 ? ', averaged over ' + seeds + ' random cities' : '') + '</span></div>'
      + '<div class="grid3">' + metrics.map(function (mt) {
        return '<figure><figcaption><b>' + mt.label + '</b></figcaption>' + sweepChart(points, cfg, mt, ri) + '</figure>';
      }).join('') + '</div>';
  }

  // ------------------------------------------------------------- report

  function kpi(label, value, sub, cls) {
    return '<div class="kpi ' + (cls || '') + '"><div class="kpi-label">' + label + '</div>'
      + '<div class="kpi-value">' + value + '</div><div class="kpi-sub">' + sub + '</div></div>';
  }

  function delta(v, upIsGood, text) {
    return '<span class="delta ' + tone(v, upIsGood) + '">' + text + '</span>';
  }

  function moreOrFewer(n) {
    n = Math.round(n);
    if (!n) return 'the same number of trips';
    return fmt.int(Math.abs(n)) + (n > 0 ? ' more' : ' fewer') + (Math.abs(n) === 1 ? ' trip' : ' trips');
  }

  function blocksMoreOrFewer(n) {
    n = Math.round(n);
    if (!n) return 'the same distance';
    return fmt.int(Math.abs(n)) + (n > 0 ? ' more' : ' fewer') + (Math.abs(n) === 1 ? ' block' : ' blocks');
  }

  function plural(n, word) {
    return fmt.int(n) + ' ' + word + (Math.round(n) === 1 ? '' : 's');
  }

  function tryButton(patch, text) {
    return '<button class="try" data-patch="' + attr(JSON.stringify(patch)) + '">' + text + ' <span aria-hidden="true">→</span></button>';
  }

  function fact(label, value, sub) {
    return '<div class="fact"><div class="fact-label">' + label + '</div><div class="fact-value">' + value + '</div><div class="fact-sub">' + sub + '</div></div>';
  }

  // Cabs were the bottleneck: riders were lost or left waiting, or drivers were rarely idle.
  function isScarce(bw) {
    return (bw.lost + bw.stillWaiting) / Math.max(1, bw.requested) > 0.08 || bw.idleShare < 0.25;
  }

  function insights(s) {
    var cfg = s.cfg, p = s.passengers, d = s.drivers, pw = s.pool, bw = s.base;
    var cards = [];

    // 1. Discount leakage.
    var body1;
    if (!p.poolCompleted) {
      body1 = 'No pool trip finished in this run, so there is nothing to measure yet. Raise the opt-in share or the number of riders.';
    } else {
      body1 = (p.fairPricing
        ? 'Fair pricing is on: of ' + fmt.int(p.poolCompleted) + ' completed pool riders, <b>' + fmt.int(p.unmatched) + ' (' + fmt.pct(1 - p.matchRate) + ') never shared a second</b> and got '
          + cfg.requestDiscount + '% instead of ' + cfg.poolDiscount + '%, so only ' + fmt.money(p.leaked) + ' of discount bought no pooling. Drivers’ premium'
        : 'All ' + fmt.int(p.poolCompleted) + ' completed pool riders got ' + cfg.poolDiscount + '% off, but '
        + '<b>' + fmt.int(p.unmatched) + ' (' + fmt.pct(1 - p.matchRate) + ') never shared a second</b>: '
        + fmt.money(p.leaked) + ' of discount bought no pooling at all. Drivers’ premium')
        + ', by contrast, is only paid on shared seconds ('
        + fmt.money(pw.premium) + '). Platform margin: <b>' + fmt.money(pw.margin) + '</b> with Pool vs '
        + fmt.money(bw.margin) + ' without (' + fmt.signedMoney(pw.margin - bw.margin) + ').'
        + '<span class="so">The cost of Pool scales with the opt-in rate; the benefit scales with the match rate. Match rate is a density problem (riders per cab per block), not a pricing one.</span>';
    }
    var try1 = p.matchRate != null && p.matchRate < 0.75 && cfg.riders < 1000
      ? tryButton({ riders: Math.min(1000, cfg.riders * 2) }, 'Try denser demand: K = ' + Math.min(1000, cfg.riders * 2))
      : tryButton({ poolDiscount: Math.max(5, Math.round(cfg.poolDiscount / 2)) }, 'Try a smaller discount: Y = ' + Math.max(5, Math.round(cfg.poolDiscount / 2)) + '%');
    if (!cfg.fairPricing) try1 = tryButton({ fairPricing: 1 }, 'Try fair pricing') + ' ' + try1;
    cards.push({ n: 1, title: cfg.fairPricing ? 'Y is now paid on a match, like X. Opt-ins alone get Y0.' : 'Y is paid on every opt-in. X is paid only on a match.', body: body1, action: try1 });

    // 2. Driver outcome depends on scarcity.
    var sameRider = d.steps.lostToSharing + d.steps.detourPay + d.steps.premium;
    var scarce = isScarce(bw);
    var body2;
    if (!d.pairShared) {
      body2 = 'No cab carried two riders long enough to change pay. Drivers’ earnings moved ' + fmt.signedMoney(d.delta) + ' purely from fleet timing.';
    } else {
      var xs = d.breakEvenX;
      var xsText = xs == null ? '' : xs <= 0
        ? 'For this run’s routes the detour seconds alone outweigh the shared seconds, so drivers come out ahead on every pooled trip at any X. '
        : 'For this run’s routes that balances at <b>X ≈ ' + Math.round(xs * 100) + '%</b> (you set ' + cfg.driverPremium + '%), so on the same riders drivers '
          + (sameRider >= 0 ? 'gained ' : 'lost ') + '<b>' + fmt.money(Math.abs(sameRider)) + '</b>. ';
      body2 = 'Per pooled trip a shared second is paid once instead of twice, detour seconds are paid on top, and X adds a premium. ' + xsText
        + 'The rest is the <b>fleet effect (' + fmt.signedMoney(d.steps.fleet) + ')</b>: cabs were '
        + (scarce
          ? '<b>scarce</b>, so pooled cabs freed up and completed ' + moreOrFewer(pw.completed - bw.completed) + ' than the no-pool city.'
          : '<b>plentiful</b>, so pooling mostly consolidated riders who would have been served anyway (' + moreOrFewer(pw.completed - bw.completed) + ') and left drivers idle ' + fmt.pct(pw.idleShare) + ' of the time vs ' + fmt.pct(bw.idleShare) + '.')
        + (d.steps.guarantee > 0 ? ' The driver guarantee added <b>' + fmt.money(d.steps.guarantee) + '</b> so no pooled ride paid less than solo or left a driver below $0.' : '')
        + ' Net for drivers: <b>' + fmt.signedMoney(d.delta) + '</b> gross, ' + fmt.signedMoney(d.netDelta) + ' after running costs (each pooled cab drove '
        + blocksMoreOrFewer(pw.blocksPerDriver - bw.blocksPerDriver) + ').'
        + '<span class="so">The same X can be generous in a shortage and a pay cut in a surplus. A fixed premium can’t be right in both, so it should move with supply.</span>';
    }
    var try2 = scarce
      ? tryButton({ cabs: Math.min(300, cfg.cabs * 2) }, 'Try doubling the fleet: N = ' + Math.min(300, cfg.cabs * 2))
      : tryButton({ cabs: Math.max(1, Math.round(cfg.cabs / 2)) }, 'Try halving the fleet: N = ' + Math.max(1, Math.round(cfg.cabs / 2)));
    cards.push({ n: 2, title: 'Whether drivers win is set by what’s scarce, not by X.', body: body2, action: try2 });

    // 3. The guarantee covers the ride, not the trip, and not equally.
    var tw = s.twin.pool;
    var body3;
    if (!p.poolCompleted) {
      body3 = 'No pool trip finished yet, so the promise has not been tested.';
    } else {
      body3 = 'No pool rider exceeded ' + cfg.maxDetour.toFixed(2) + '× their estimate (worst: ' + fmt.ratio(p.maxRatio) + '), even though '
        + fmt.pct(p.reroutedShare) + ' of them had their cab reroute mid-ride to fit someone in. But the promise is only about time in the car. ';
      if (tw.n) {
        body3 += '<b>' + fmt.pct(tw.later) + ' of pool riders reached their destination later</b> than the same riders in the no-pool city'
          + (tw.beyondCap > 0 ? ', and ' + fmt.pct(tw.beyondCap, 1) + ' took more than ' + cfg.maxDetour.toFixed(2) + '× as long door to door' : '') + '. ';
      }
      if (p.hostRatio != null && p.joinerRatio != null) {
        var hx = p.hostRatio - 1, jx = p.joinerRatio - 1;
        var fr = p.fairness;
        body3 += 'And the detour is lopsided: riders already aboard averaged <b>' + fmt.ratio(p.hostRatio) + '</b> their estimate, riders who joined them <b>'
          + fmt.ratio(p.joinerRatio) + '</b>. '
          + (p.fairPricing
            ? 'Fair pricing paid for it: riders already aboard saved <b>' + fmt.money(fr.hostSaved) + '</b> each on average, riders who joined ' + fmt.money(fr.joinerSaved) + ', through ' + fmt.money(p.detourCredit) + ' of detour credits.'
            : jx > 0.005 && hx > jx * 1.1 ? 'The first rider absorbs ' + (hx / jx).toFixed(1) + '× as much extra time, for the same ' + cfg.poolDiscount + '% discount.'
            : jx > 0.005 && jx > hx * 1.1 ? 'The joining rider absorbs ' + (jx / Math.max(hx, 0.001)).toFixed(1) + '× as much extra time, for the same ' + cfg.poolDiscount + '% discount.'
            : 'Both pay the same ' + cfg.poolDiscount + '% less regardless.');
      }
      body3 += p.fairPricing
        ? '<span class="so">The detour is now priced per rider. What remains open is waiting time: a door-to-door promise against the solo option.</span>'
        : '<span class="so">A fairer promise would bound door-to-door time against the solo option, and price the detour each rider actually absorbs instead of a flat Y.</span>';
    }
    var try3 = cfg.maxDetour > 1.25
      ? tryButton({ maxDetour: 1.2 }, 'Try a tighter promise: 1.20×')
      : tryButton({ maxDetour: 1.5 }, 'Try the 1.50× promise');
    cards.push({ n: 3, title: 'The ' + cfg.maxDetour.toFixed(2) + '× promise covers the ride, not the trip, and not equally.', body: body3, action: try3 });

    return cards.map(function (c) {
      return '<article class="insight"><div class="insight-n">' + c.n + '</div><div><h4>' + c.title + '</h4><p>' + c.body + '</p>' + c.action + '</div></article>';
    }).join('');
  }

  function compareTable(s) {
    var pw = s.pool, bw = s.base;
    var secs = function (v) { return fmt.sec(v); };
    var pct1 = function (v) { return fmt.pct(v, 1); };
    var dec1 = function (v) { return v == null ? '—' : v.toFixed(1); };
    var dec2 = function (v) { return v == null ? '—' : v.toFixed(2); };
    // [label, base, pool, formatter, delta kind, up is good]
    var groups = [
      ['Riders', [
        ['Riders delivered', bw.completed, pw.completed, fmt.int, 'int', true],
        ['Gave up waiting for a match', bw.lost, pw.lost, fmt.int, 'int', false],
        ['Still waiting at P', bw.stillWaiting, pw.stillWaiting, fmt.int, 'int', false],
        ['In a cab at P', bw.inProgress, pw.inProgress, fmt.int, 'int', null],
        ['Average wait for pickup', bw.avgWait, pw.avgWait, secs, 'sec', false],
        ['Mid-ride reroutes', bw.reroutes, pw.reroutes, fmt.int, 'int', null],
        ['Moved to a closer cab before pickup', bw.reassigned, pw.reassigned, fmt.int, 'int', null],
      ]],
      ['Drivers', [
        ['Earnings (gross)', bw.driverPay, pw.driverPay, fmt.money, 'money', true],
        ['Running cost', bw.runningCost, pw.runningCost, fmt.money, 'money', false],
        ['Earnings after running cost', bw.netPay, pw.netPay, fmt.money, 'money', true],
        ['Earnings per engaged minute', bw.payPerEngagedMin, pw.payPerEngagedMin, fmt.money, 'money', true],
        ['Time engaged (driving to or with riders)', bw.engagedShare, pw.engagedShare, pct1, 'pts', null],
        ['Time idle', bw.idleShare, pw.idleShare, pct1, 'pts', null],
        ['Blocks driven per driver', bw.blocksPerDriver, pw.blocksPerDriver, fmt.int, 'int', false],
        ['Empty blocks per pickup', bw.emptyPerPickup, pw.emptyPerPickup, dec1, 'dec', false],
      ]],
      ['City & platform', [
        ['Rider spend (fares charged)', bw.revenue, pw.revenue, fmt.money, 'money', null],
        ['Platform margin (fares − driver pay)', bw.margin, pw.margin, fmt.money, 'money', true],
        ['Rider-blocks delivered per cab-block', bw.efficiency, pw.efficiency, dec2, 'dec2', true],
        ['Cab-seconds with 2 aboard', bw.time.two, pw.time.two, fmt.int, 'int', null],
      ]],
    ];
    return deltaTable(groups, 'No Pool', 'With Pool');
  }

  // groups: [title, rows]; row: [label, a, b, formatter, delta kind, up is good (null = neutral)]
  function deltaTable(groups, headA, headB) {
    var out = '<table class="compare"><thead><tr><th>Metric</th><th>' + headA + '</th><th>' + headB + '</th><th>Change</th></tr></thead><tbody>';
    groups.forEach(function (g) {
      out += '<tr class="group-row"><td colspan="4">' + g[0] + '</td></tr>';
      g[1].forEach(function (r) {
        var dv = r[2] - r[1];
        var dtext = !ok(dv) ? '—'
          : r[4] === 'money' ? fmt.signedMoney(dv)
          : r[4] === 'pts' ? (dv >= 0 ? '+' : MINUS) + Math.abs(dv * 100).toFixed(1) + ' pts'
          : r[4] === 'sec' ? fmt.signedSec(dv)
          : r[4] === 'dec' ? (dv >= 0 ? '+' : MINUS) + Math.abs(dv).toFixed(1)
          : r[4] === 'dec2' ? (dv >= 0 ? '+' : MINUS) + Math.abs(dv).toFixed(2)
          : fmt.signedInt(dv);
        out += '<tr><td>' + r[0] + '</td><td>' + r[3](r[1]) + '</td><td>' + r[3](r[2]) + '</td><td>'
          + (r[5] == null ? '<span class="delta flat">' + dtext + '</span>' : delta(dv, r[5], dtext)) + '</td></tr>';
      });
    });
    return out + '</tbody></table>';
  }

  // ------------------------------------------------------------- enhancements

  // Original rules vs enhanced rules, same city, same moment.
  function abHtml(a, b, cfg, headA, headB) {
    var secs = function (v) { return fmt.sec(v); };
    var groups = [
      ['Riders', [
        ['Riders delivered', a.completed, b.completed, fmt.int, 'int', true],
        ['Gave up waiting for a match', a.lost, b.lost, fmt.int, 'int', false],
        ['Average wait for pickup', a.avgWait, b.avgWait, secs, 'sec', false],
        ['Average saving per completed pool rider', a.savedPerPoolRider, b.savedPerPoolRider, fmt.money, 'money', null],
        ['Saving: rider already aboard (absorbs the detour)', a.hostSaved, b.hostSaved, fmt.money, 'money', true],
        ['Saving: rider who joined', a.joinerSaved, b.joinerSaved, fmt.money, 'money', null],
      ]],
      ['Drivers', [
        ['Earnings (gross, incl. top-ups)', a.driverPay, b.driverPay, fmt.money, 'money', true],
        ['Earnings after running cost', a.netPay, b.netPay, fmt.money, 'money', true],
        ['Guarantee top-ups paid by Uber', a.topUp, b.topUp, fmt.money, 'money', null],
        ['Pooled rides paying less than the same riders solo', a.belowParity, b.belowParity, fmt.int, 'int', false],
        ['Pooled rides leaving the driver below $0', a.belowZero, b.belowZero, fmt.int, 'int', false],
        ['Worst pooled ride, driver net', a.worstNet, b.worstNet, fmt.money, 'money', true],
      ]],
      ['Uber', [
        ['Rider spend (fares charged)', a.revenue, b.revenue, fmt.money, 'money', null],
        ['Discount given to pool riders who never shared', a.leaked, b.leaked, fmt.money, 'money', false],
        ['Platform margin (fares − driver pay)', a.margin, b.margin, fmt.money, 'money', true],
        ['Margin vs the no-pool city', a.margin - a.baseMargin, b.margin - b.baseMargin, fmt.signedMoney, 'money', true],
      ]],
    ];
    return deltaTable(groups, headA, headB)
      + '<p class="ab-note">Both columns are full runs of this exact city (seed ' + cfg.seed + ', same settings) to the same moment; only the rule set differs. '
      + 'Pooled rides = busy stretches that carried a pool rider and ended by then (' + fmt.int(b.pooledRides) + ' in “' + headB + '”).</p>';
  }

  function economicsSection(s) {
    var cfg = s.cfg, g = s.guarantee, p = s.passengers, f = p.fairness;
    var gOn = g.floor || g.parity;
    var arrow = function (x, y) { return fmt.int(x) + ' → ' + fmt.int(y); };
    var gFacts = gOn
      ? fact('Guarantee top-ups', fmt.money(g.topUp), fmt.int(g.toppedUp) + ' of ' + fmt.int(g.pooledRides) + ' pooled rides topped up · solo parity ' + fmt.money(g.parityTopUp) + ' · no-loss floor ' + fmt.money(g.floorTopUp))
        + fact('Pooled rides paying less than solo', arrow(g.belowParityBefore, g.belowParity), 'before → after the guarantee' + (g.parity ? '' : ' (solo parity is off)'))
        + fact('Pooled rides below $0 for the driver', arrow(g.belowZeroBefore, g.belowZero), 'after running costs, incl. the unpaid drive to pickup' + (g.floor ? '' : ' (floor is off)'))
        + fact('Worst pooled ride, driver net', fmt.money(g.worstNet), 'before the guarantee: ' + fmt.money(g.worstNetBefore)
          + (g.unsettled ? ' · ' + plural(g.unsettled, 'cab') + ' still busy at the end, not settled yet' : ''))
      : fact('Driver guarantee is off', fmt.int(g.belowParityBefore) + ' / ' + fmt.int(g.pooledRides),
        'pooled rides paid the driver less than the same riders solo; ' + fmt.int(g.belowZeroBefore) + ' left them below $0'
        + tryButton({ parityFloor: 1, driverFloor: 1 }, 'Turn the guarantee on'));
    var fFacts = p.fairPricing
      ? fact('Discount to riders who never shared', fmt.money(p.leaked), fmt.int(p.unmatched) + ' unmatched pool riders got ' + cfg.requestDiscount + '% instead of ' + cfg.poolDiscount + '%')
        + fact('Detour credits', fmt.money(p.detourCredit), cfg.detourCredit + '% of the fare rate for every extra second in the car')
      : fact('Fair pricing is off', fmt.money(p.leaked), 'discount given to ' + fmt.int(p.unmatched) + ' pool riders who never shared'
        + tryButton({ fairPricing: 1 }, 'Turn fair pricing on'));
    fFacts += fact('Rider already aboard', f.hostSaved == null ? '—' : fmt.money(f.hostSaved) + ' saved', f.hostExtra == null ? 'no hosted riders' : fmt.signedSec(f.hostExtra) + ' extra in the car, on average')
      + fact('Rider who joined', f.joinerSaved == null ? '—' : fmt.money(f.joinerSaved) + ' saved', f.joinerExtra == null ? 'no joining riders' : fmt.signedSec(f.joinerExtra) + ' extra in the car, on average');
    return '<section class="rsec"><h3>Fair pool economics</h3><div class="grid2">'
      + '<div><div class="sub-cap">Driver guarantee — drivers never lose by pooling</div><div class="facts">' + gFacts + '</div></div>'
      + '<div><div class="sub-cap">Pricing — riders pay for what they actually get</div><div class="facts">' + fFacts + '</div></div>'
      + '</div></section>';
  }

  // What the threat zone did, city by city.
  function zoneSection(s) {
    var zp = s.pool.zone, zb = s.base.zone;
    if (!zp.declared) return '';
    var when = zp.history.map(function (h) {
      return '(' + h.cx + ', ' + h.cy + '), radius ' + h.r + ' blocks, from ' + fmt.sec(h.at, 0) + (h.clearedAt != null ? ' to ' + fmt.sec(h.clearedAt, 0) : ' to the end');
    }).join('; ');
    var many = zp.history.length > 1;
    var reasons = function (z, key) { return z.byReason[key] || 0; };
    var groups = [['Threat zone', [
      ['Cabs rerouted around it', zb.rerouted, zp.rerouted, fmt.int, 'int', null],
      ['Cabs that had to drive out of it', zb.evacuated, zp.evacuated, fmt.int, 'int', null],
      ['Rides cancelled: pickup inside', reasons(zb, 'pickup inside the threat zone'), reasons(zp, 'pickup inside the threat zone'), fmt.int, 'int', null],
      ['Rides cancelled: destination inside', reasons(zb, 'destination inside the threat zone'), reasons(zp, 'destination inside the threat zone'), fmt.int, 'int', null],
      ['Rides cancelled: no route around it', reasons(zb, 'no route around the threat zone'), reasons(zp, 'no route around the threat zone'), fmt.int, 'int', null],
      ['…of which new requests refused', zb.refused, zp.refused, fmt.int, 'int', null],
      ['Riders put back in the queue', zb.requeued, zp.requeued, fmt.int, 'int', null],
      ['Riders dropped short of a closed destination', zb.earlyDrops, zp.earlyDrops, fmt.int, 'int', null],
      ['Fare refunded for distance not covered', zb.refund, zp.refund, fmt.money, 'money', null],
      ['Riders delivered past the detour cap (safety first)', zb.capExceptions, zp.capExceptions, fmt.int, 'int', null],
    ]]];
    return '<section class="rsec"><h3>' + (many ? 'Threat zones' : 'Threat zone') + '</h3>'
      + '<p class="lead">' + (many ? zp.history.length + ' zones: ' : 'Declared at ') + when + '. Every intersection inside was closed in both cities at the same moment. '
      + 'No cab was routed through ' + (many ? 'them' : 'it') + '; cabs caught inside drove straight out. Cancelled riders were never charged; riders dropped short paid only for the distance covered.</p>'
      + deltaTable(groups, 'No Pool', 'With Pool') + '</section>';
  }

  // Traffic lights: what the turn-aware routes did, and one leg compared.
  function lightsSection(s) {
    var tp = s.pool.turns, tb = s.base.turns, cfg = s.cfg;
    if (!tp.on) return '';
    var R = cfg.rightTurnDelay, L = R * 0.75, U = R * 1.25;
    var groups = [['Turns', [
      ['Left turns', tb.left, tp.left, fmt.int, 'int', null],
      ['Right turns', tb.right, tp.right, fmt.int, 'int', null],
      ['U-turns (only where unavoidable)', tb.u, tp.u, fmt.int, 'int', null],
      ['Cab-seconds waiting at lights', tb.wait, tp.wait, fmt.int, 'int', false],
      ['Legs where the fastest route beat x-then-y', tb.legsImproved, tp.legsImproved, fmt.int, 'int', null],
      ['Seconds saved on those legs', tb.saving, tp.saving, fmt.int, 'int', true],
    ]]];
    var ex = tp.examples[0] || tb.examples[0], exHtml = '';
    if (ex) {
      var row = function (name, r) {
        return '<tr><td>' + name + '</td><td>' + r.blocks + '</td><td>' + r.lefts + '</td><td>' + r.rights + '</td><td>' + fmt.sec(r.turnTime, 0) + '</td><td><b>' + fmt.sec(r.time, 0) + '</b></td></tr>';
      };
      exHtml = '<figure class="wide mt"><figcaption><b>One leg from this run</b><span>(' + ex.from.x + ', ' + ex.from.y + ') → (' + ex.to.x + ', ' + ex.to.y + '), leaving a stop at ' + fmt.sec(ex.at, 0) + '</span></figcaption>'
        + '<table class="compare"><thead><tr><th>Route</th><th>Distance (blocks)</th><th>Left turns</th><th>Right turns</th><th>Turn time</th><th>Total time</th></tr></thead><tbody>'
        + row('Fastest route (taken)', ex.chosen) + row('Original x-then-y route', ex.xFirst) + '</tbody></table></figure>';
    }
    return '<section class="rsec"><h3>Traffic lights</h3>'
      + '<p class="lead">A right turn adds ' + fmt.sec(R, 0) + ' at the light, a left ' + fmt.sec(L, 2).replace('.00', '') + ' (75%), a U-turn ' + fmt.sec(U, 2).replace('.00', '') + ' (125%, only where there is no other way); straight is free, and so is setting off from a stop. '
      + 'Every route, estimate, fare, ping radius and detour cap uses this total time, and cabs really wait at the light. '
      + 'On this grid the fastest route is never longer than the shortest: avoiding one right turn means looping a block, two extra blocks and three lefts (' + fmt.sec(2 / cfg.cabSpeed + 3 * L, 0) + ' vs ' + fmt.sec(R, 0) + '). '
      + 'What the lights change is which of the equally short routes is taken: the one whose turns are lefts.</p>'
      + deltaTable(groups, 'No Pool', 'With Pool') + exHtml + '</section>';
  }

  var STATES = [
    { key: 'idle', label: 'Idle', cls: 'st-idle', dark: true },
    { key: 'empty', label: 'Driving empty', cls: 'st-empty', dark: true },
    { key: 'one', label: '1 aboard', cls: 'st-one' },
    { key: 'two', label: '2 aboard', cls: 'st-two' },
  ];

  function stateLegend(states) {
    return '<div class="legend-row">' + states.map(function (st) {
      return '<span><i class="key ' + st.cls + '"></i>' + st.label + '</span>';
    }).join('') + '</div>';
  }

  function render(s) {
    var cfg = s.cfg, p = s.passengers, d = s.drivers, pw = s.pool, bw = s.base;
    var stepsTips = {
      base: 'Driver pay in the no-pool city: rate × every occupied second.',
      lostToSharing: 'Seconds with two riders aboard are paid once, not twice (completed pool trips).',
      detourPay: 'Extra in-car seconds caused by detours are paid ride time.',
      premium: 'X% extra on every second with two riders aboard.',
      guarantee: 'Driver-guarantee top-ups paid by Uber: solo parity and the no-loss floor on pooled rides.',
      fleet: 'Everything else: more or fewer rides completed by P because pooled cabs free up sooner, plus rides in progress at P.',
      pool: 'Driver pay in the pool city.',
    };
    var w = waterfallChart(d.steps);
    var keys = ['base', 'lostToSharing', 'detourPay', 'premium', 'guarantee', 'fleet', 'pool'];
    var k = 0;
    w = w.replace(/data-tip=""/g, function () { var key = keys[k++]; return 'data-tip="' + attr('<b>' + fmt.signedMoney(d.steps[key]) + '</b><br>' + stepsTips[key]) + '"'; });

    var params = [
      ['K', cfg.riders + ' riders'], ['N', cfg.cabs + ' cabs'], ['P', cfg.duration + ' s'],
      ['Opt-in', cfg.poolOptIn + '%'], ['Cap', cfg.maxDetour.toFixed(2) + '×'],
      ['X', cfg.driverPremium + '%'], ['Y', cfg.poolDiscount + '%'], ['Radius', cfg.pingRadius + ' blocks'],
      ['Patience', cfg.patience + ' s'], ['Slip', cfg.pickupSlip + ' s'], ['Re-dispatch', cfg.reassign ? 'on' : 'off'],
      ['Pricing', cfg.fairPricing ? 'fair (Y0 ' + cfg.requestDiscount + '%, credit ' + cfg.detourCredit + '%)' : 'flat'],
      ['Guarantee', cfg.parityFloor && cfg.driverFloor ? 'parity + floor' : cfg.parityFloor ? 'parity' : cfg.driverFloor ? 'floor' : 'off'],
      ['Matching', cfg.batchMatch ? 'batch' : 'oldest first'],
      ['Lights', cfg.rightTurnDelay > 0 ? 'right +' + cfg.rightTurnDelay + ' s, left +' + (cfg.rightTurnDelay * 0.75) + ' s' : 'off'],
      ['Threat zone', pw.zone.declared ? pw.zone.history.map(function (h) { return '(' + h.cx + ', ' + h.cy + ') r ' + h.r; }).join(', ') : 'none'],
      ['Seed', cfg.seed],
    ].map(function (x) { return '<span class="chip"><b>' + x[0] + '</b> ' + x[1] + '</span>'; }).join('');

    var cutoff = s.t + 1e-6 < cfg.duration;
    var timeRows = [
      { label: 'No Pool', values: bw.time, note: fmt.pct(bw.engagedShare) + ' engaged' },
      { label: 'With Pool', values: pw.time, note: fmt.pct(pw.engagedShare) + ' engaged' },
    ];
    var blockStates = STATES.slice(1);
    var blockRows = [
      { label: 'No Pool', values: scale(bw.blocks, 1 / cfg.cabs), note: fmt.int(bw.blocksPerDriver) + ' blocks / driver' },
      { label: 'With Pool', values: scale(pw.blocks, 1 / cfg.cabs), note: fmt.int(pw.blocksPerDriver) + ' blocks / driver' },
    ];

    return ''
      + '<header class="report-head"><div>'
      + '<p class="eyebrow">' + (cutoff ? 'Interim report · stopped at ' : 'Run report · after ') + fmt.sec(s.t, 0) + '</p>'
      + '<h2 id="report-title">Same riders, same cabs — with and without Pool</h2>'
      + '<div class="chips">' + params + '</div></div>'
      + '<button class="btn icon" data-close aria-label="Close report">✕</button></header>'

      + '<section class="kpis">'
      + kpi('Pool riders saved', fmt.money(p.saved),
        fmt.int(p.poolCompleted) + ' completed pool trips · ' + fmt.money(p.savedPerRider) + ' each', 'accent')
      + kpi('Extra time in the car', p.avgExtraSec == null ? '—' : fmt.signedSec(p.avgExtraSec),
        fmt.signedPct(p.avgExtraPct, 1) + ' vs solo estimate · worst ' + fmt.ratio(p.maxRatio) + ' of ' + cfg.maxDetour.toFixed(2) + '× cap')
      + kpi('Drivers earned', fmt.signedMoney(d.delta),
        delta(d.delta, true, fmt.signedPct(d.deltaPct, 1)) + ' vs no-pool city · ' + fmt.signedMoney(d.netDelta) + ' after running cost')
      + kpi('Riders delivered', fmt.int(pw.completed),
        delta(pw.completed - bw.completed, true, fmt.signedInt(pw.completed - bw.completed)) + ' vs ' + fmt.int(bw.completed) + ' without Pool · ' + fmt.int(pw.lost) + ' gave up (vs ' + fmt.int(bw.lost) + ')')
      + '</section>'

      + '<section class="rsec"><h3>Passengers</h3><div class="grid2">'
      + '<figure><figcaption><b>Time in the car vs. original estimate</b><span>Completed pool trips. ' + fmt.pct(p.withinCap, 0) + ' within the promise; '
      + fmt.pct(p.matchRate) + ' shared at least part of the ride.</span></figcaption>'
      + '<div class="legend-row"><span><i class="key key-shared"></i>Shared a ride</span><span><i class="key key-pool1"></i>Rode alone</span></div>'
      + histogramChart(p.histogram, cfg.maxDetour) + '</figure>'
      + '<figure><figcaption><b>Door-to-door change vs. the no-pool city</b><span>Same rider, both cities (riders finished in both). Pool riders traded '
      + fmt.signedSec(p.avgExtraSec) + ' in the car for ' + fmt.money(p.savedPerRider) + ' — ' + (p.dollarsPerExtraMinute ? fmt.money(p.dollarsPerExtraMinute) + ' per extra minute' : 'no extra time') + '.</span></figcaption>'
      + '<div class="legend-row"><span><i class="key key-good"></i>Faster</span><span><i class="key key-bad"></i>Slower</span></div>'
      + deltaChart([{ label: 'Pool riders', d: s.twin.pool }, { label: 'Solo riders (did not opt in)', d: s.twin.solo }]) + '</figure>'
      + '</div><div class="grid2 mt">'
      + '<figure><figcaption><b>Co-riders per pool trip</b><span>Different people a pool rider shared the cab with on one trip — never more than one at a time. '
      + fmt.int(p.multiCo) + ' riders shared with two or more in turn.</span></figcaption>'
      + coRiderChart(p.coCounts) + '</figure>'
      + '<div class="facts">'
      + fact('Rerouted mid-ride', fmt.pct(p.reroutedShare), 'of pool riders had their cab change course to fit someone in (max ' + p.maxReroutes + ' times)')
      + fact('Moved before pickup', plural(pw.reassigned, 'rider'), 're-dispatched to a cab that freed up closer (' + fmt.int(bw.reassigned) + ' without Pool)')
      + fact('Gave up waiting', plural(pw.lost, 'rider'), 'no cab inside ' + cfg.pingRadius + ' blocks for ' + cfg.patience + ' s (' + fmt.int(bw.lost) + ' without Pool)')
      + fact('Extra distance ridden', fmt.int(p.detourBlocks) + ' blocks', 'detours across all pool riders, ' + (p.poolCompleted ? (p.detourBlocks / p.poolCompleted).toFixed(1) : '—') + ' each')
      + '</div></div></section>'

      + '<section class="rsec"><h3>Drivers</h3><div class="grid2">'
      + '<figure><figcaption><b>Where the change in driver earnings came from</b><span>Fleet total, ' + fmt.money(bw.driverPay) + ' → ' + fmt.money(pw.driverPay) + '. Hover a bar for its definition.</span></figcaption>'
      + w + '</figure>'
      + '<div class="facts">'
      + fact('Premium paid (X = ' + cfg.driverPremium + '%)', fmt.money(pw.premium), fmt.int(pw.time.two) + ' cab-seconds with two aboard')
      + fact('Break-even premium per pooled trip', d.breakEvenX == null ? '—' : d.breakEvenX <= 0 ? 'any X' : '≈ ' + Math.round(d.breakEvenX * 100) + '%', 'X at which a shared trip pays the driver what two solo trips would')
      + fact('Earnings per engaged minute', fmt.money(pw.payPerEngagedMin), fmt.money(bw.payPerEngagedMin) + ' without Pool')
      + fact('Earnings after running cost', fmt.money(pw.netPay / cfg.cabs), 'per driver, at ' + fmt.money(cfg.costPerBlock) + ' a block (' + fmt.money(bw.netPay / cfg.cabs) + ' without Pool)')
      + '</div></div>'

      + '<figure class="wide mt"><figcaption><b>Where drivers’ time went</b><span>Engaged = driving to a pickup or carrying riders. Idle = parked with no job.</span></figcaption>'
      + stateLegend(STATES) + stackBars(timeRows, STATES, 'cab-seconds', 'Driver time by state, with and without Pool')
      + '<div class="grid2 mt-sm">'
      + '<div><div class="sub-cap">No Pool — one column per driver</div>' + driverColumns(bw.perDriver, STATES, 'Each driver’s time, no-pool city') + '</div>'
      + '<div><div class="sub-cap">With Pool — one column per driver</div>' + driverColumns(pw.perDriver, STATES, 'Each driver’s time, pool city') + '</div>'
      + '</div></figure>'

      + '<figure class="wide mt"><figcaption><b>How far drivers drove</b><span>Average blocks per driver. Empty = to pickups. Rider-blocks delivered per cab-block: '
      + (pw.efficiency == null ? '—' : pw.efficiency.toFixed(2)) + ' with Pool vs ' + (bw.efficiency == null ? '—' : bw.efficiency.toFixed(2)) + ' without; empty blocks per pickup '
      + dec(pw.emptyPerPickup) + ' vs ' + dec(bw.emptyPerPickup) + '.</span></figcaption>'
      + stateLegend(blockStates) + stackBars(blockRows, blockStates, 'blocks per driver', 'Blocks driven per driver by state, with and without Pool')
      + '</figure></section>'

      + zoneSection(s)

      + lightsSection(s)

      + economicsSection(s)

      + '<section class="rsec"><h3>Original rules vs enhanced rules</h3>'
      + '<div id="ab-body"><div class="chart-empty">Re-running this city with the other rule set…</div></div></section>'

      + '<section class="rsec" id="sweep-sec"><h3>Ping radius — how close must a cab be to get the request?</h3>'
      + '<div id="sweep-body"><div class="chart-empty" id="sweep-progress">Running the radius sweep…</div></div></section>'

      + '<section class="rsec"><h3>Three things this run reveals</h3><div class="insights">' + insights(s) + '</div></section>'

      + '<section class="rsec"><h3>City-wide</h3>'
      + '<figure class="wide"><figcaption><b>Riders waiting for a pickup</b><span>Requested and not yet in a cab (matched or not), sampled every second.</span></figcaption>'
      + '<div class="legend-row"><span><i class="key key-pool"></i>With Pool</span><span><i class="key key-base"></i>No Pool</span></div>'
      + lineChart(s.series.pool, s.series.base, 'waiting') + '</figure>'
      + compareTable(s) + '</section>'

      + '<footer class="method"><b>How this is measured.</b> Two cities run side by side with identical riders (request time, origin, destination, opt-in) and identical cab start positions; the only difference is whether pool matching is allowed. '
      + 'Matching runs every second, oldest request first, and only pings cabs that can reach the pickup within ' + cfg.pingRadius + ' blocks of driving. Solo riders get a free cab; pool riders can also be slotted anywhere into a pool cab’s remaining stops, '
      + 'provided no one ever has more than one co-rider at a time, every pool rider stays within ' + cfg.maxDetour.toFixed(2) + '× their solo time, and no promised pickup slips more than ' + cfg.pickupSlip + ' s. '
      + (cfg.batchMatch ? 'Batch matching was on: each second the cheapest rider-cab pairs across the queue are committed first, with priority for riders who have waited longest. ' : '')
      + 'Passenger time and savings count trips completed by P; driver pay, time and distance accrue up to P; '
      + (cfg.fairPricing ? 'fares are charged at pickup at the no-match rate and settled at drop-off (full discount if shared, plus detour credits). ' : 'fares are charged upfront at pickup. ')
      + (cfg.parityFloor || cfg.driverFloor ? 'Driver-guarantee top-ups are paid when a cab that carried a pool rider goes idle. ' : '')
      + (pw.zone.declared ? 'While the threat zone was active, every distance was the real driving distance around it, and the radius sweep and comparison re-runs replay it at the same moment.' : '')
      + (cutoff ? ' This run was stopped before P, so these are interim numbers.' : '') + '</footer>';
  }

  function scale(obj, f) {
    var out = {};
    for (var key in obj) out[key] = obj[key] * f;
    return out;
  }
  function dec(v) { return v == null ? '—' : v.toFixed(1); }

  root.PoolReport = {
    render: render, sweepHtml: sweepHtml, abHtml: abHtml, fmt: fmt, tone: tone, wireLineChart: wireLineChart,
  };
})(this);
