/* Metri    root.addEventListener('click', toggle);
cs tab. Ported in structure from claude-control (MIT, lucasdonordeste). */
(function (window) {
  'use strict';
  var SLOTS = 12;
  function hash(s){var h=2166136261;s=s.toLowerCase();for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function kfmt(n) {
    n = num(n);
    var u = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    for (var i = 0; i < u.length; i++) {
      if (n >= u[i][0]) return (n / u[i][0]).toFixed(1).replace(/\.0$/, '') + u[i][1];
    }
    return String(Math.round(n));
  }
  function minutesLabel(m) {
    m = Math.max(1, Math.ceil(m));
    if (m >= 1440) return Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h';
    return m >= 60 ? Math.floor(m / 60) + 'h ' + m % 60 + 'm' : m + 'm';
  }

  function usageColor(pct) {
    return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  }

  function scope(label, tag) {
    return '<div class="scope"><span class="dot"></span>' + esc(label) +
      (tag ? '<span class="path">' + esc(tag) + '</span>' : '') + '</div>';
  }
  function stat(v, l) {
    return '<div class="stat"><div class="stat-v">' + esc(v) + '</div><div class="stat-l">' + esc(l) + '</div></div>';
  }
  function donut(pct, label, c) {
    var p = Math.max(0, Math.min(100, num(pct))), R = 26, C = 2 * Math.PI * R;
    return '<div class="donut"><svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="32" cy="32" r="' + R + '" fill="none" stroke="var(--hair)" stroke-width="7"/>' +
      '<circle cx="32" cy="32" r="' + R + '" fill="none" stroke="' + c + '" stroke-width="7" stroke-linecap="round" ' +
      'stroke-dasharray="' + (p / 100 * C).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 32 32)"/></svg>' +
      '<div class="donut-c"><b>' + Math.round(p) + '%</b><span>' + esc(label) + '</span></div></div>';
  }
  function sparkline(points, key, from, now, maxGap, c) {
    var W = 252, H = 42, pad = 4, resetKey = key + 'r';
    var x = function (t) { return (pad + (t - from) / (now - from) * (W - 2 * pad)).toFixed(1); };
    var y = function (pct) { return (H - pad - Math.max(0, Math.min(100, pct)) / 100 * (H - 2 * pad)).toFixed(1); };
    var latest = null, segments = [];
    var resets = new Set();
    points.forEach(function (point) {
      var reset = point[resetKey] * 1000;
      if (reset >= from && reset <= now) resets.add(reset);
      if (point.t < from) return;
      var previousReset = latest && latest[resetKey] * 1000;
      var continuous = latest && point.t - latest.t <= maxGap && point[key] >= latest[key] &&
        (!previousReset || point.t < previousReset) && (!previousReset || !reset || previousReset === reset);
      if (!continuous) segments.push([]);
      segments[segments.length - 1].push([x(point.t), y(point[key])]);
      latest = point;
    });
    var markers = Array.from(resets).map(function (reset) {
      var pos = x(reset);
      return '<path d="M' + pos + ' 2V40" class="spark-reset"><title>Reset ' + esc(new Date(reset).toLocaleString()) + '</title></path>';
    }).join('');
    if (!latest && !markers) return '';
    var line = '', areas = '', dots = '';
    segments.forEach(function (segment) {
      var trace = segment.map(function (xy) { return xy.join(' '); }).join('L');
      line += 'M' + trace;
      if (segment.length > 1) {
        areas += '<path class="spark-area" d="M' + segment[0][0] + ' 38L' + trace + 'L' + segment[segment.length - 1][0] + ' 38Z" fill="' + c + '"/>';
      } else {
        dots += '<circle cx="' + segment[0][0] + '" cy="' + segment[0][1] + '" r="1.6" fill="' + c + '"/>';
      }
    });
    var end = latest ? '<circle cx="' + x(latest.t) + '" cy="' + y(latest[key]) + '" r="2.3" fill="' + c + '"/>' : '';
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="spark-grid" d="M4 21H248M4 38H248"/>' + areas + markers +
      '<path d="' + line + '" fill="none" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + end + '</svg>';
  }
  function columns(vals, titleOf) {
    if (!vals.length) return '';
    var max = Math.max.apply(null, vals.concat([1]));
    return '<div class="cols">' + vals.map(function (v, i) {
      var h = v ? Math.max(3, Math.round(v / max * 100)) : 0;
      return '<div class="col' + (v ? '' : ' zero') + '" title="' + esc(titleOf(i)) + '"><span class="col-b" style="height:' + h + '%"></span></div>';
    }).join('') + '</div>';
  }
  // One row helper for Tools, By model and By project.
  function rows(items) {
    var top = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    return items.map(function (i) {
      return '<div class="hrow"><span class="hlbl" title="' + esc(i.name) + '">' +
        (i.color ? '<i style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:' + i.color + '"></i>' : '') + esc(i.name) + '</span>' +
        '<span class="hbar"><span class="hfill" style="width:' + Math.max(2, i.value / top * 100) + '%' +
        (i.color ? ';background:' + i.color + ';opacity:1' : '') + '"></span></span>' +
        '<span class="hval">' + esc(i.display) + '</span>' +
        (i.err != null ? '<span class="herr' + (i.bad ? ' bad' : '') + '">' + esc(i.err) + '</span>' : '') + '</div>';
    }).join('');
  }

  var HOUR = 3600000;
  var PLAN = [
    { key: 's', window: 'fiveHour', label: '5-hour session', trend: '5-hour limit · last 24 hours', days: 1, rotation: 5, gap: 1.5, start: '24h ago' },
    { key: 'w', window: 'sevenDay', label: 'Weekly', trend: 'Weekly limit · last 7 days', days: 7, rotation: 168, gap: 12, start: '7 days ago' }
  ];

  // Measure the recent rise inside one active quota window. Rounded percentages
  // sampled seconds apart are too coarse for a useful projection.
  function burn(hist, spec, current, now) {
    if (!current || !Number.isFinite(current.seenAt) || current.seenAt < now - HOUR / 2 || !(current.resetsAt * 1000 > now)) return null;
    var key = spec.key, resetKey = key + 'r';
    var from = Math.max(current.seenAt - HOUR, current.resetsAt * 1000 - spec.rotation * HOUR);
    var oldest = { t: current.seenAt, pct: current.pct };
    for (var i = hist.length - 1; i >= 0; i--) {
      var point = hist[i];
      if (point.t < from) break;
      if (point.t >= current.seenAt || !Number.isFinite(point[key])) continue;
      if ((point[resetKey] && point[resetKey] !== current.resetsAt) || point[key] > oldest.pct) break;
      oldest = { t: point.t, pct: point[key] };
    }
    var hours = (current.seenAt - oldest.t) / HOUR;
    if (hours < 0.25) return null;
    var rate = (current.pct - oldest.pct) / hours;
    var left = rate > 0.05 ? (100 - current.pct) / rate * 60 : null;
    return { rate: rate, left: left, resetsFirst: left != null && (current.resetsAt * 1000 - now) / 60000 <= left };
  }
  function burnLine(label, b) {
    if (!b) return '';
    var txt = b.resetsFirst ? 'Resets before full' : b.left == null ? 'Stable' : b.left <= 0 ? 'Limit reached' : 'Full in ~' + minutesLabel(b.left);
    return '<div class="burn' + (!b.resetsFirst && b.left != null && b.left < 60 ? ' burn-danger' : '') + '"><span class="burn-l">' + esc(label) +
      '</span><span class="burn-r">' + esc((b.rate > 0.05 ? '+' : '') + b.rate.toFixed(1)) + '%/h</span><span class="burn-e" title="' + esc(txt) + '">' + esc(txt) + '</span></div>';
  }

  function planUsage(live, history, now) {
    var gauges = '', forecast = '';
    PLAN.forEach(function (spec) {
      var reading = live[spec.window];
      var resetMs = reading && reading.resetsAt * 1000;
      if (!reading || !Number.isFinite(reading.pct) || (resetMs && resetMs <= now)) {
        gauges += '<div class="plan-window"><span>' + spec.label + '</span><span class="plan-wait">Waiting for reading</span></div>';
        return;
      }
      var pct = Math.max(0, Math.min(100, reading.pct));
      var reset = resetMs ? '<span title="' + esc('Resets ' + new Date(resetMs).toLocaleString()) + '">' + minutesLabel((resetMs - now) / 60000) + '</span>' : '<span>—</span>';
      var time = Number.isFinite(reading.seenAt) ? ' title="' + esc('Measured ' + new Date(reading.seenAt).toLocaleString()) + '"' : '';
      gauges += '<div class="plan-window"' + time + '><span>' + spec.label + '</span><span class="plan-track" aria-hidden="true"><span style="width:' + pct +
        '%;background:' + usageColor(pct) + '"></span></span><strong style="color:' + usageColor(pct) + '">' + Math.round(pct) + '%</strong>' + reset + '</div>';
      forecast += burnLine(spec.label, burn(history, spec, reading, now));
    });
    return scope('Plan usage', 'Claude status line') + '<div class="plan-panel">' + gauges + '</div>' + scope('Burn rate', 'Estimate') +
      '<div class="plan-panel">' + (forecast || '<div class="spark-empty">Available after a short period of activity.</div>') + '</div>';
  }

  function colors(names) {
    var used = {}, color = {};
    names.slice().sort().forEach(function (n) {
      var k = hash(n) % SLOTS, t = 0;
      while (used[k] && t++ < SLOTS) k = (k + 1) % SLOTS;
      used[k] = 1; color[n] = 'var(--c' + k + ')';
    });
    return color;
  }

  function render(D, state) {
    D = D || {}; state = state || {};
    var all = Array.isArray(D.projects) ? D.projects.filter(Boolean).map(function (p) {
      return { name: String(p.name == null ? '' : p.name), t: p.t || {}, daily: p.daily || {}, dailyTurns: p.dailyTurns || {},
        tools: p.tools || {}, models: p.models || {}, hours: p.hours || [], cache: p.cache || {} };
    }) : [];
    var color = colors(all.map(function (p) { return p.name; }));
    var open = D.openProject != null && D.openProject !== '' ? D.openProject : null;
    var openOnly = !!state.openOnly && open != null;
    var ps = openOnly ? all.filter(function (p) { return p.name === open; }) : all;
    var days = Array.isArray(D.days) ? D.days : [];
    var h = '';
    var i;

    // Trend
    var now = Number.isFinite(D.now) ? D.now : Date.now();
    var hist = Array.isArray(D.history) ? D.history.filter(function (p) { return p && Number.isFinite(p.t) && p.t <= now; }) : [];
    hist.sort(function (a, b) { return a.t - b.t; });
    var block = function (spec) {
      var key = spec.key, from = now - spec.days * 24 * HOUR;
      var points = hist.filter(function (p) { return Number.isFinite(p[key]); });
      var latest = points[points.length - 1];
      var pct = latest && latest.t >= from ? latest[key] : null;
      var c = pct == null ? 'var(--mute)' : usageColor(pct);
      var svg = sparkline(points, key, from, now, spec.gap * HOUR, c);
      var reading = pct == null ? '' : '<span style="color:' + c + '" title="' +
        esc((latest[key + 'Source'] === 'control' ? 'Claude Control reading ' : 'Last reading ') + new Date(latest.t).toLocaleString()) + '">' + Math.round(pct) + '%</span>';
      return '<div class="sparkrow"><div class="sparklbl"><span>' + esc(spec.trend) + '</span>' + reading + '</div>' +
        (svg ? svg + '<div class="spark-axis"><span>' + esc(spec.start) + '</span><span>Now</span></div>' : '<div class="spark-empty">No readings in this period</div>') + '</div>';
    };
    if (D.showUsageTrend !== false) {
      var control = hist.some(function (p) { return p.t >= now - 7 * 24 * HOUR && (p.sSource === 'control' || p.wSource === 'control'); });
      h += planUsage(D.live || {}, hist, now) + scope('Trend', control ? 'Includes Claude Control' : 'Claude plan') + PLAN.map(block).join('');
    }

    // Tokens header and switch
    h += scope('Tokens', 'last ' + (num(D.windowDays) || days.length || 30) + ' days');
    h += '<div class="row' + (openOnly ? ' on' : '') + '"><span class="led' + (openOnly ? ' on' : '') + '"></span>' +
      '<div class="body"><div class="l">Only the open project</div></div>' +
      '<div class="sw' + (openOnly ? ' on' : '') + '" role="switch" tabindex="0" data-mx="open" aria-checked="' + openOnly + '" aria-label="Only the open project"' +
      (open == null ? ' data-off="1" style="opacity:.4;pointer-events:none"' : '') + '></div><span class="state">' + (openOnly ? 'ON' : 'OFF') + '</span></div>';
    if (openOnly && all.length > ps.length) {
      h += '<div class="usenote">' + (all.length - ps.length) + (all.length - ps.length === 1 ? ' other project' : ' other projects') + ' hidden</div>';
    }

    var T = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0 }, cold = 0, rebuilt = 0, idle = 0, cIn = 0, cRead = 0, cWrite = 0;
    ps.forEach(function (p) {
      for (var k in T) T[k] += num(p.t[k]);
      if (num(p.t.cacheRead) + num(p.t.cacheCreate) > 0) { cIn += num(p.t.input); cRead += num(p.t.cacheRead); cWrite += num(p.t.cacheCreate); }
      cold += num(p.cache.cold); rebuilt += num(p.cache.rebuilt); idle += num(p.cache.afterIdle);
    });
    var total = T.input + T.output + T.cacheRead + T.cacheCreate;
    if (!T.turns && !total) {
      return h + '<div class="empty">No usage found for this window yet.</div>';
    }
    // Sources like Antigravity and Cursor report turns but no tokens: show turns instead of zeros.
    var turnsOnly = !total && T.turns > 0;
    h += '<div class="stats">' + (turnsOnly ? stat(kfmt(T.turns), 'turns') : stat(kfmt(total), 'tokens') + stat(kfmt(T.turns), 'turns') + stat(kfmt(T.output), 'generated')) + '</div>';

    // Cache ratio only counts projects that report cache reads or writes.
    var denom = cIn + cRead + cWrite;
    var chr = denom ? Math.round(cRead / denom * 100) : 0;
    if (!turnsOnly) h += '<div class="cachebox">' + donut(chr, 'cache', chr >= 80 ? 'var(--led-on)' : chr >= 50 ? 'var(--warn)' : 'var(--danger)') +
      '<div class="cache-t"><div class="cache-h">Cache efficiency</div>' +
      '<div class="cache-d">Share of the prompt replayed from cache instead of re-sent. Higher means longer sessions cost far less.</div>' +
      '<div class="cache-n">' + esc(kfmt(cRead)) + ' read · ' + esc(kfmt(cWrite)) + ' written</div></div></div>' +
      (cold > 0 ? '<div class="usenote">' + esc(kfmt(cold) + (cold === 1 ? ' cache reset' : ' cache resets') + (idle > 0 ? ', ' + kfmt(idle) + ' after idle pauses.' : '.')) + '</div>' : '');

    // Daily columns
    if (days.length) {
      var dv = days.map(function (d) { return ps.reduce(function (n, p) { return n + num(p.daily[d]); }, 0); });
      var dt = days.map(function (d) { return ps.reduce(function (n, p) { return n + num(p.dailyTurns[d]); }, 0); });
      var dp = turnsOnly ? dt : dv;
      h += scope('Daily', days.length + ' days' + (turnsOnly ? ' · turns' : '')) +
        columns(dp, function (x) { return days[x] + ' · ' + (turnsOnly ? '' : kfmt(dv[x]) + ' · ') + dt[x] + ' turns'; }) +
        '<div class="colsx"><span>' + esc(String(days[0]).slice(5)) + '</span><span>' + esc(String(days[days.length - 1]).slice(5)) + '</span></div>';
    }

    // Tools
    var tools = {};
    ps.forEach(function (p) {
      Object.keys(p.tools).forEach(function (n) {
        var t = p.tools[n] || {}, key = n.indexOf('mcp__') === 0 ? (n.slice(n.lastIndexOf('__') + 2) || n) : n;
        var o = tools[key] || (tools[key] = { calls: 0, fails: 0 });
        o.calls += num(t.calls); o.fails += num(t.fails);
      });
    });
    var tl = Object.keys(tools).map(function (n) { return { name: n, calls: tools[n].calls, fails: tools[n].fails }; })
      .sort(function (a, b) { return b.calls - a.calls; });
    if (tl.length) {
      var calls = tl.reduce(function (n, t) { return n + t.calls; }, 0);
      h += scope('Tools', kfmt(calls) + ' calls') + rows(tl.slice(0, 8).map(function (t) {
        var pct = t.calls ? Math.round(t.fails / t.calls * 100) : 0;
        return { name: t.name, value: t.calls, display: kfmt(t.calls), err: t.fails ? pct + '%' : '', bad: pct >= 10 };
      }));
    }

    // Hours
    var hrs = [];
    for (i = 0; i < 24; i++) hrs.push(ps.reduce(function (n, p) { return n + num(p.hours[i]); }, 0));
    var hmax = Math.max.apply(null, hrs);
    if (hmax > 0) {
      h += scope('When you work', 'busiest at ' + hrs.indexOf(hmax) + 'h') +
        columns(hrs, function (x) { return ('0' + x).slice(-2) + ':00 — ' + kfmt(hrs[x]); }) +
        '<div class="colsx"><span>00h</span><span>12h</span><span>23h</span></div>';
    }

    // By model
    var models = {};
    ps.forEach(function (p) { Object.keys(p.models).forEach(function (m) { models[m] = (models[m] || 0) + num(p.models[m]); }); });
    var ml = Object.keys(models).map(function (m) { return { name: m.replace(/^claude-/, ''), value: models[m], display: kfmt(models[m]) }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 6);
    if (ml.length && !turnsOnly) h += scope('By model') + rows(ml);

    // By project
    var pl = ps.map(function (p) {
      var v = turnsOnly ? num(p.t.turns) : num(p.t.input) + num(p.t.output) + num(p.t.cacheRead) + num(p.t.cacheCreate);
      return { name: p.name, value: v, display: kfmt(v), color: color[p.name] };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
    if (pl.length) h += scope('By project') + rows(pl);

    h += '<div class="usenote">Counted locally; Antigravity and recent Cursor logs do not record tokens.</div>';
    return h;
  }

  function bind(root, state, onChange) {
    if (!root || !root.addEventListener) return;
    var toggle = function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-mx="open"]') : null;
      if (!el || (el.getAttribute && el.getAttribute('data-off'))) return false;
      if (onChange) onChange({ openOnly: !(state && state.openOnly) });
      return true;
    };
    root.addEventListener('click', toggle);
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && toggle(e) && e.preventDefault) e.preventDefault();
    });
  }

  window.ClaudeReportMetrics = { render: render, bind: bind };
})(window);
