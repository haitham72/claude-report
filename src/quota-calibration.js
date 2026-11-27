'use strict';

// Empirical subscription quota calibration from local utilization snapshots and transcript usage.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudProviders = require('./cloud-providers');
const { resolveBinary, formatSubscriptionTier } = cloudProviders;
const { readPlanHistory } = require('./plan-history');

const DAY = 24 * 3600 * 1000;
const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10080;
const MIN_WINDOW_MOVEMENT = 3;

function quotaResetSeconds(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  const seconds = Number.isFinite(numeric) ? (numeric >= 1e12 ? numeric / 1000 : numeric)
    : (typeof value === 'string' ? Date.parse(value) / 1000 : NaN);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function modelWeight(provider, modelId) {
  const s = String(modelId || '').toLowerCase();
  if (provider === 'claude') {
    if (s.includes('haiku')) return 0.3;
    if (s.includes('opus')) return 3.5;
    return 1.0;
  }
  if (provider === 'codex') {
    if (s.includes('mini')) return 0.3;
    return 1.0;
  }
  if (provider === 'muse') {
    if (s.includes('spark')) return 0.5;
    if (s.includes('wonder')) return 2.0;
    return 1.0;
  }
  if (provider === 'antigravity') {
    if (s.includes('flash') || s.includes('argon')) return 0.2;
    if (s.includes('opus')) return 2.5;
    if (s.includes('neon') || s.includes('hydrogen')) return 2.0;
    return 1.0;
  }
  return 1.0;
}

function effortMultiplier(effort) {
  const s = String(effort || '').toLowerCase();
  if (s === 'low') return 1.0;
  if (s === 'medium') return 1.4;
  if (s === 'high') return 2.0;
  if (s === 'xhigh') return 2.5;
  if (s === 'max') return 2.8;
  return 1.2;
}

function weightedUnits({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0, modelWeight: mw = 1, effortMultiplier: em = 1 }) {
  return mw * (Math.max(0, input) + 0.1 * Math.max(0, cacheRead) + 0.25 * Math.max(0, cacheCreate) + 5 * em * Math.max(0, output));
}

function summarizeSamples(values) {
  const clean = (values || []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const trim = clean.length >= 6 ? Math.floor(clean.length * 0.1) : 0;
  const kept = clean.slice(trim, clean.length - trim);
  const at = (q) => {
    const index = (kept.length - 1) * q;
    const lower = Math.floor(index);
    return kept[lower] + (kept[Math.ceil(index)] - kept[lower]) * (index - lower);
  };
  return { median: Math.round(at(0.5)), p25: Math.round(at(0.25)), p75: Math.round(at(0.75)), count: kept.length };
}

function walkFiles(root, match, afterMs, limit = 40) {
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && match(entry.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= afterMs) found.push({ full, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  };
  walk(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map((f) => f.full);
}

function calibrateCodex({ sessionsDir, now = Date.now() } = {}) {
  const root = sessionsDir || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const files = walkFiles(root, (name) => /^rollout-.*\.jsonl$/.test(name), now - 14 * DAY, 40);
  const events = [];
  let latest = null;

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let previous = null;
    let model = '';
    for (const line of raw.split('\n')) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const payload = rec?.payload;
      if (payload?.model) model = payload.model;
      if (payload?.type !== 'token_count') continue;
      const ts = Date.parse(rec.timestamp);
      if (!Number.isFinite(ts) || ts > now) continue;

      const totals = payload.info?.total_token_usage;
      let units = 0;
      let knownInterval = false;
      if (totals) {
        const delta = (key) => (totals[key] || 0) - (previous?.[key] || 0);
        const input = delta('input_tokens');
        const cacheRead = delta('cached_input_tokens');
        const cacheCreate = delta('cache_write_input_tokens');
        const output = delta('output_tokens');
        knownInterval = Boolean(previous && [input, cacheRead, cacheCreate, output].every((n) => Number.isFinite(n) && n >= 0));
        if (knownInterval) {
          units = weightedUnits({ input: input - cacheRead - cacheCreate, output, cacheRead, cacheCreate, modelWeight: modelWeight('codex', model) });
        }
        previous = totals;
      }
      const rl = payload.rate_limits;
      // The Codex bucket can sit beside separate quotas for individual model families.
      if (!rl?.plan_type || (rl.limit_id != null && rl.limit_id !== 'codex')) continue;
      const windows = [rl.primary, rl.secondary].filter((w) => Number.isFinite(w?.used_percent) && w.used_percent >= 0);
      const fiveHour = windows.find((w) => w.window_minutes === FIVE_HOUR_MINUTES);
      const sevenDay = windows.find((w) => w.window_minutes === WEEK_MINUTES);
      if (!fiveHour && !sevenDay) continue;
      const point = { ts, plan: rl.plan_type, fiveHour, sevenDay, units, knownInterval };
      if (ts >= now - 14 * DAY) events.push(point);
      if (!latest || ts > latest.ts) latest = point;
    }
  }

  const samples = (key) => {
    const buckets = new Map();
    for (const point of events) {
      if (point.plan !== latest?.plan) continue;
      const win = point[key];
      if (!win || !Number.isFinite(win.resets_at) || win.resets_at * 1000 <= point.ts || win.used_percent > 100) continue;
      const bucket = buckets.get(win.resets_at) || [];
      bucket.push({ ...point, pct: win.used_percent });
      buckets.set(win.resets_at, bucket);
    }
    return [...buckets.values()].map((points) => {
      points.sort((a, b) => a.ts - b.ts);
      const start = points[0];
      const end = points[points.length - 1];
      const delta = end.pct - start.pct;
      if (delta < MIN_WINDOW_MOVEMENT || points.some((p, i) => i > 0 && (!p.knownInterval || p.pct < points[i - 1].pct))) return 0;
      const units = points.slice(1).reduce((sum, p) => sum + p.units, 0);
      return units >= 2000 ? units / delta : 0;
    });
  };

  const liveWindow = (key) => {
    const win = latest?.[key];
    const resetsAt = quotaResetSeconds(win?.resets_at);
    if (!win || !resetsAt || resetsAt * 1000 <= now) return null;
    return { pct: win.used_percent, resetsAt, seenAt: latest.ts };
  };

  return {
    planLabel: latest ? `ChatGPT ${formatSubscriptionTier(latest.plan)}` : '',
    fiveHour: summarizeSamples(samples('fiveHour')),
    sevenDay: summarizeSamples(samples('sevenDay')),
    live: latest ? {
      fiveHour: liveWindow('fiveHour'),
      sevenDay: liveWindow('sevenDay'),
      updatedAt: latest.ts
    } : null
  };
}

function risingSpans(history, key, minDelta) {
  const resetKey = key + 'r';
  const spans = [];
  let cur = null;
  for (const p of history) {
    const val = p?.[key];
    const reset = quotaResetSeconds(p?.[resetKey]);
    if (!Number.isFinite(val) || !Number.isFinite(p?.t) || !reset || reset * 1000 <= p.t) continue;
    if (!cur || reset !== cur.reset || val < cur.endVal) {
      if (cur && cur.endVal - cur.startVal >= minDelta) spans.push(cur);
      cur = { reset, startT: p.t, endT: p.t, startVal: val, endVal: val };
    } else {
      cur.endT = p.t;
      cur.endVal = val;
    }
  }
  if (cur && cur.endVal - cur.startVal >= minDelta) spans.push(cur);
  return spans;
}

function readClaudeTurnEvents(projectsDir, afterMs) {
  const files = walkFiles(projectsDir, (name) => name.endsWith('.jsonl'), afterMs, 60);
  const messages = new Map();
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== 'assistant' || !rec.message?.usage || !rec.timestamp) continue;
      if (/claude-report-work/i.test(rec.cwd || '')) continue;
      const t = Date.parse(rec.timestamp);
      if (!Number.isFinite(t) || t < afterMs) continue;
      const u = rec.message.usage;
      const msgId = rec.message.id || rec.requestId || `${file}:${t}`;
      const peu = weightedUnits({
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        modelWeight: modelWeight('claude', rec.message.model)
      });
      const prev = messages.get(msgId);
      if (!prev || peu > prev.peu) messages.set(msgId, { t, peu });
    }
  }
  return [...messages.values()].sort((a, b) => a.t - b.t);
}

function calibrateClaude({ claudeDir, historyDir, controlFile, now = Date.now() } = {}) {
  const cDir = claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const hDir = historyDir || process.env.CLAUDE_REPORT_HOME || path.join(os.homedir(), '.claude-report');
  const ctrl = controlFile === undefined ? path.join(cDir, 'cursor-claude-control', 'usage-history.json') : controlFile;
  const history = readPlanHistory({ dir: hDir, controlFile: ctrl, now });
  const spans5 = risingSpans(history, 's', 5);
  const spans7 = risingSpans(history, 'w', 3);
  if (!spans5.length && !spans7.length) return { fiveHour: null, sevenDay: null };

  const earliest = Math.min(
    ...[...spans5, ...spans7].map((s) => s.startT),
    now
  );
  const events = readClaudeTurnEvents(path.join(cDir, 'projects'), earliest - 60000);
  const samplesFor = (spans) => spans.map((span) => {
    const peu = events.filter((e) => e.t > span.startT && e.t <= span.endT).reduce((sum, e) => sum + e.peu, 0);
    const delta = span.endVal - span.startVal;
    return peu >= 2000 && delta > 0 ? peu / delta : 0;
  }).filter((v) => v > 0);

  return {
    fiveHour: summarizeSamples(samplesFor(spans5)),
    sevenDay: summarizeSamples(samplesFor(spans7))
  };
}

function readMuseQuota(opts = {}) {
  const { exec = childProcess.execFileSync, resolve = resolveBinary, now = Date.now() } = opts;
  const bin = resolve('muse', opts);
  if (!bin) return { available: false, reason: 'muse_missing' };
  try {
    const env = cloudProviders.providerEnvironment('muse', opts.env || process.env);
    const raw = String(exec(bin.command, [...bin.prefix, 'usage', '--json'], { encoding: 'utf8', timeout: 3000, windowsHide: true, env }));
    const j = JSON.parse(raw);
    const a = j?.allowance ?? j?.usage;
    const planLabel = formatSubscriptionTier(j?.tierName || j?.tier_name || a?.plan || a?.tier || '');
    const subscriptionActive = j?.subscriptionActive ?? j?.subscription_active;
    if (!a || subscriptionActive === false) {
      return { available: false, reason: j?.reason || 'no_usage', ...(subscriptionActive != null ? { subscriptionActive, planLabel } : {}) };
    }
    const observedAt = a.observedAtMs ?? a.observed_at_ms;
    const seenAt = Number.isFinite(observedAt) ? observedAt : now;
    const normWin = (w) => {
      if (!w || typeof w !== 'object') return null;
      const pct = w.usedPercent ?? w.used_percent ?? w.pct;
      if (!Number.isFinite(pct) || pct < 0) return null;
      const resetsAt = quotaResetSeconds(w.resetsAtMs ?? w.resets_at_ms ?? w.resets_at ?? w.resetsAt);
      return { pct, resetsAt, seenAt };
    };
    const current = a.window;
    const duration = current?.windowDurationMins ?? current?.window_duration_mins;
    const currentWindow = normWin(current);
    const fiveHour = normWin(a.five_hour || a.fiveHour) || (duration === FIVE_HOUR_MINUTES ? currentWindow : null);
    const sevenDay = normWin(a.seven_day || a.sevenDay || a.weekly);
    const windows = [];
    if (currentWindow && duration !== FIVE_HOUR_MINUTES) {
      const label = Number.isSafeInteger(duration) && duration > 0 ? `${duration} min` : 'Current window';
      windows.push({ label, ...currentWindow });
    }
    if (Array.isArray(a.windows)) {
      for (const w of a.windows) {
        const nw = normWin(w);
        if (!nw) continue;
        const label = typeof w.label === 'string' ? w.label.trim().slice(0, 50) : 'Usage window';
        windows.push({ label: label || 'Usage window', ...nw });
      }
    }
    return {
      available: Boolean(fiveHour || sevenDay || windows.length),
      fiveHour,
      sevenDay,
      windows,
      planLabel,
      ...(subscriptionActive === true || fiveHour || sevenDay || windows.length ? { subscriptionActive: true } : {})
    };
  } catch {
    return { available: false, reason: 'error' };
  }
}

function resolveCalibration({ provider, planLabel, empirical }) {
  const normalizePlan = (label) => String(label || '').trim().toLowerCase().replace(/^chatgpt(?:\s+|$)/, '');
  const detectedPlan = normalizePlan(planLabel);
  const historyPlan = normalizePlan(empirical?.planLabel);
  const hasDifferentPlan = provider === 'codex' && detectedPlan && historyPlan && detectedPlan !== historyPlan;
  const pick = (sample) => !hasDifferentPlan && sample?.count >= 2 ? sample : null;
  const fiveHour = pick(empirical?.fiveHour);
  const sevenDay = pick(empirical?.sevenDay);
  return { source: fiveHour || sevenDay ? 'calibrated' : 'tokens-only', fiveHour, sevenDay };
}

module.exports = {
  modelWeight,
  effortMultiplier,
  weightedUnits,
  summarizeSamples,
  calibrateCodex,
  calibrateClaude,
  readMuseQuota,
  quotaResetSeconds,
  resolveCalibration
};
