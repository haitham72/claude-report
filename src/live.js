'use strict';

// Live snapshot written by the statusLine hook, read by the status bar.
// Only a fixed allow-list of fields is stored: no prompts, tokens or other paths.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The runtime copy lives at <home>/runtime/<x.y.z>/src/live.js and the hook runs without the extension's
// environment, so home is derived from that location; otherwise CLAUDE_REPORT_HOME or ~/.claude-report.
function homeDir(dirname = __dirname, env = process.env) {
  const ver = path.dirname(dirname);
  if (/^\d+\.\d+\.\d+$/.test(path.basename(ver)) && path.basename(path.dirname(ver)) === 'runtime') return path.dirname(path.dirname(ver));
  return env.CLAUDE_REPORT_HOME || path.join(os.homedir(), '.claude-report');
}
const DEFAULT_DIR = homeDir();

// Renames over a file that Windows may briefly lock; the temp file never outlives the call.
function writeTmpRename(file, text, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const opts = mode == null ? undefined : { mode };
    fs.writeFileSync(tmp, text, opts);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone after a successful rename */ }
  }
}
const DAY = 24 * 3600 * 1000;
const STALE_MS = 10 * 60 * 1000;

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function windowOf(w) {
  const pct = num(w && w.used_percentage);
  if (pct === null || pct < 0 || pct > 100) return null;
  return { pct, resetsAt: num(w.resets_at) };
}

function writeLive(status, { dir = DEFAULT_DIR, now = Date.now() } = {}) {
  if (!status || typeof status.session_id !== 'string' || !status.session_id) return null;
  const rl = status.rate_limits || {};
  const snap = {
    sessionId: status.session_id,
    cwd: typeof status.cwd === 'string' ? status.cwd : null,
    model: status.model && typeof status.model.display_name === 'string' ? status.model.display_name : null,
    ctxPct: num(status.context_window && status.context_window.used_percentage),
    fiveHour: windowOf(rl.five_hour),
    sevenDay: windowOf(rl.seven_day),
    updatedAt: now,
  };
  if (snap.fiveHour || snap.sevenDay) saveWindows(dir, snap, now);
  const live = path.join(dir, 'live');
  fs.mkdirSync(live, { recursive: true });
  const file = path.join(live, safeId(snap.sessionId) + '.json');
  writeTmpRename(file, JSON.stringify(snap));
  recordHistory(dir, snap, now);
  prune(live);
  return snap;
}

// The 5h and 7d windows belong to the account, not to one session. Claude Code only reports them
// after a session's first response, so after a restart the first readings come without them. The
// last good values are kept here and used until the window resets.
function readWindows(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'windows.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveWindows(dir, snap, now) {
  try {
    const saved = readWindows(dir);
    const next = {
      fiveHour: snap.fiveHour ? { ...snap.fiveHour, seenAt: now } : saved.fiveHour || null,
      sevenDay: snap.sevenDay ? { ...snap.sevenDay, seenAt: now } : saved.sevenDay || null
    };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'windows.json');
    writeTmpRename(file, JSON.stringify(next));
  } catch { /* remembering the windows is best effort */ }
}

// Keep a week of readings plus a day for reset markers at the left edge.
const HISTORY_AGE_MS = 8 * DAY;
const HISTORY_BUCKET_MS = 5 * 60 * 1000;

function readHistory({ dir = DEFAULT_DIR } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'usage-history.json'), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function recordHistory(dir, snap, now) {
  if (!snap.fiveHour && !snap.sevenDay) return;
  try {
    const hist = readHistory({ dir }).filter((entry) => entry?.t >= now - HISTORY_AGE_MS && entry.t <= now);
    const point = { t: now, s: snap.fiveHour?.pct ?? null, w: snap.sevenDay?.pct ?? null,
      sr: snap.fiveHour?.resetsAt ?? null, wr: snap.sevenDay?.resetsAt ?? null };
    const sameBucket = (entry) => entry && Math.floor(entry.t / HISTORY_BUCKET_MS) === Math.floor(now / HISTORY_BUCKET_MS)
      && entry.sr === point.sr && entry.wr === point.wr && (entry.s == null) === (point.s == null) && (entry.w == null) === (point.w == null);
    // Keep the first and most recent readings in each bucket and each rotation.
    if (sameBucket(hist.at(-1)) && sameBucket(hist.at(-2))) hist[hist.length - 1] = point;
    else hist.push(point);
    const file = path.join(dir, 'usage-history.json');
    writeTmpRename(file, JSON.stringify(hist));
  } catch { /* history is best effort */ }
}

// Plan usage from Anthropic's /usage shape (utilization + resets_at ISO). Updates windows and history
// so OAuth polling and the status-line hook share one store.
function windowFromUtilization(w) {
  const pct = num(w && w.utilization);
  if (pct === null || pct < 0 || pct > 100) return null;
  const t = Date.parse(w && w.resets_at);
  return { pct, resetsAt: Number.isFinite(t) ? Math.round(t / 1000) : null };
}

// `at` is when the reading was taken. A shared file's reading can be older than what the hook has
// stored since, so each window and the history point are written only when they are newer: an old
// reading must neither replace a newer window nor trim newer history (recordHistory drops t > at).
function ingestUsagePayload(dir, payload, at = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const snap = {
    fiveHour: windowFromUtilization(payload.five_hour),
    sevenDay: windowFromUtilization(payload.seven_day),
  };
  if (!snap.fiveHour && !snap.sevenDay) return null;
  const saved = readWindows(dir);
  const newer = (key) => (snap[key] && !(saved[key]?.seenAt >= at) ? snap[key] : null);
  const windows = { fiveHour: newer('fiveHour'), sevenDay: newer('sevenDay') };
  if (windows.fiveHour || windows.sevenDay) saveWindows(dir, windows, at);
  // Points dated after the real clock are junk from a clock change; recordHistory drops those itself.
  const clock = Date.now();
  const latest = readHistory({ dir }).reduce((t, e) => (Number.isFinite(e?.t) && e.t <= clock && e.t > t ? e.t : t), -Infinity);
  if (at > latest) recordHistory(dir, snap, at);
  return snap;
}

function prune(live) {
  try {
    for (const f of fs.readdirSync(live)) {
      const tmp = f.endsWith('.tmp');
      if (!tmp && !f.endsWith('.json')) continue;
      const p = path.join(live, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > (tmp ? 3600 * 1000 : 7 * DAY)) fs.unlinkSync(p); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// Plan usage as Claude Code's /usage reports it, cached under the temp dir by status tools
// that poll the usage endpoint. Used when the statusLine hook is not delivering readings, so
// the gauges do not depend on one script being present. Treated as untrusted input.
const SHARED_USAGE = path.join(os.tmpdir(), 'claude_oauth_usage.json');
const SHARED_MAX_AGE_MS = 6 * 3600 * 1000; // past the 5h window an old value stops meaning anything

function readSharedUsage({ file = SHARED_USAGE, now = Date.now() } = {}) {
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > SHARED_MAX_AGE_MS) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const win = (w) => {
      const pct = num(w && w.utilization);
      if (pct === null || pct < 0 || pct > 100) return null;
      const t = Date.parse(w.resets_at);
      return { pct, resetsAt: Number.isFinite(t) ? Math.round(t / 1000) : null, seenAt: st.mtimeMs };
    };
    const out = { fiveHour: win(j && j.five_hour), sevenDay: win(j && j.seven_day) };
    return out.fiveHour || out.sevenDay ? out : null;
  } catch { return null; }
}

const normCwd = (p) => {
  const n = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

function readLive({ dir = DEFAULT_DIR, now = Date.now(), maxAgeMs = 6 * 3600 * 1000, cwd, sharedFile = null } = {}) {
  const live = path.join(dir, 'live');
  let files = [];
  try { files = fs.readdirSync(live).filter((f) => f.endsWith('.json')); } catch { /* the account windows may still be available */ }
  const snaps = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(live, f), 'utf8'));
      if (!s || typeof s.updatedAt !== 'number' || now - s.updatedAt > maxAgeMs) continue;
      snaps.push(s);
    } catch { /* corrupt file */ }
  }
  const freshest = (list) => list.reduce((a, b) => (b.updatedAt > (a?.updatedAt ?? -Infinity) ? b : a), null);
  const want = cwd && normCwd(cwd);
  const pick = (want && freshest(snaps.filter((s) => s.cwd && normCwd(s.cwd) === want))) || freshest(snaps);
  const saved = readWindows(dir);
  const alive = (w) => (w && !(typeof w.resetsAt === 'number' && w.resetsAt * 1000 <= now) ? w : null);
  const accountWindow = (key) => {
    const snap = freshest(snaps.filter((s) => s[key]));
    const cached = saved[key];
    const fromHook = cached && (!snap || cached.seenAt >= snap.updatedAt) ? cached : snap && { ...snap[key], seenAt: snap.updatedAt };
    const fromShared = shared && shared[key];
    // Newest reading wins, whichever source it came from.
    return alive(fromShared && (!fromHook || fromShared.seenAt > (fromHook.seenAt || 0)) ? fromShared : fromHook);
  };
  const shared = sharedFile ? readSharedUsage({ file: sharedFile, now }) : null;
  const fiveHour = accountWindow('fiveHour');
  const sevenDay = accountWindow('sevenDay');
  if (!pick && !fiveHour && !sevenDay) return null;
  return {
    ...pick,
    updatedAt: pick?.updatedAt ?? Math.max(fiveHour?.seenAt || 0, sevenDay?.seenAt || 0),
    fiveHour,
    sevenDay,
    stale: !pick || now - pick.updatedAt > STALE_MS,
  };
}

module.exports = {
  homeDir, DEFAULT_DIR, SHARED_USAGE, SHARED_MAX_AGE_MS,
  writeLive, writeTmpRename, readLive, readHistory, readSharedUsage, ingestUsagePayload, windowFromUtilization,
};
