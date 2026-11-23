'use strict';

// Live plan usage (same numbers as Claude Code /usage). Tries several routes before giving up:
// fresh memory → fresh shared cache → OAuth API → stale shared / last good.
// Adapted from Claude Control usage.js (MIT, lucasdonordeste).
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DEFAULT_DIR, SHARED_USAGE, ingestUsagePayload, windowFromUtilization, writeTmpRename } = require('./live');

const USAGE_TTL_MS = 60 * 1000;
const SHARED_FRESH_MS = 75 * 1000;
const SHARED_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKOFF_MS = 120 * 1000;
const AUTH_BACKOFF_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const KEYCHAIN_TIMEOUT_MS = 2000;
const KEYCHAIN_FAIL_COOLDOWN_MS = 5 * 60 * 1000;

function slimUsagePayload(j) {
  if (!j || typeof j !== 'object') return null;
  const five = windowFromUtilization(j.five_hour);
  const seven = windowFromUtilization(j.seven_day);
  if (!five && !seven) return null;
  const out = {};
  if (five) {
    out.five_hour = {
      utilization: five.pct,
      ...(Number.isFinite(five.resetsAt) ? { resets_at: new Date(five.resetsAt * 1000).toISOString() } : {}),
    };
  }
  if (seven) {
    out.seven_day = {
      utilization: seven.pct,
      ...(Number.isFinite(seven.resetsAt) ? { resets_at: new Date(seven.resetsAt * 1000).toISOString() } : {}),
    };
  }
  return out;
}

// Claude Code writes expiresAt in milliseconds; seconds are accepted too.
function credentialOf(oauth, now) {
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  const exp = oauth.expiresAt;
  if (Number.isFinite(exp) && (exp > 1e12 ? exp : exp * 1000) <= now) return { expired: true };
  return { token: oauth.accessToken };
}

function tokenFromCredentials(file, now = Date.now()) {
  try {
    return credentialOf(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth, now);
  } catch { return null; }
}

let keychainFailUntil = 0;

function tokenFromKeychain(run = execFileSync, now = Date.now()) {
  if (process.platform !== 'darwin') return null;
  if (now < keychainFailUntil) return null;
  try {
    const out = run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS,
    });
    return credentialOf(JSON.parse(out).claudeAiOauth, now);
  } catch {
    keychainFailUntil = now + KEYCHAIN_FAIL_COOLDOWN_MS;
    return null;
  }
}

// Try every known local token store. First hit wins; never logs the token.
// Returns { token } | { expired: true } | null.
function readOauthToken({ env = process.env, keychain = tokenFromKeychain, homedir = os.homedir, now = Date.now() } = {}) {
  const home = homedir();
  const routes = [];
  if (env.CLAUDE_CONFIG_DIR) {
    routes.push(() => tokenFromCredentials(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), now));
  }
  routes.push(() => tokenFromCredentials(path.join(home, '.claude', '.credentials.json'), now));
  routes.push(() => keychain(undefined, now));
  let sawExpired = false;
  for (const route of routes) {
    const hit = route();
    if (!hit) continue;
    if (typeof hit === 'string') return { token: hit };
    if (hit.expired) { sawExpired = true; continue; }
    if (hit.token) return hit;
  }
  return sawExpired ? { expired: true } : null;
}

function readSharedCache(file, maxAgeMs, now = Date.now()) {
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > maxAgeMs) return null;
    const slim = slimUsagePayload(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!slim) return null;
    return { payload: slim, mtimeMs: st.mtimeMs };
  } catch { /* missing or corrupt */ }
  return null;
}

function writeSharedCache(file, payload) {
  try {
    const slim = slimUsagePayload(payload);
    if (!slim) return;
    writeTmpRename(file, JSON.stringify(slim), { mode: 0o600 });
  } catch { /* sharing the cache is best effort */ }
}

function classifyUsageResponse(statusCode, body, headers, prevGood) {
  let j = null;
  try { j = JSON.parse(body); } catch { /* non-JSON */ }
  const slim = slimUsagePayload(j);
  if (statusCode === 200 && slim) return { value: slim, state: 'ok', cache: slim };
  if (statusCode === 429) {
    const ra = parseInt(headers && headers['retry-after'], 10);
    return {
      value: prevGood,
      state: prevGood ? 'stale' : 'ratelimited',
      backoffMs: ra > 0 ? ra * 1000 : DEFAULT_BACKOFF_MS,
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      value: prevGood,
      state: prevGood ? 'stale' : 'expired',
      backoffMs: AUTH_BACKOFF_MS,
    };
  }
  return {
    value: prevGood,
    state: prevGood ? 'stale' : 'error',
    backoffMs: DEFAULT_BACKOFF_MS,
  };
}

function requestUsage(token, { request = https.request, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (statusCode, body, headers) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode, body, headers });
    };
    try {
      const req = request({
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => finish(res.statusCode, body, res.headers));
      });
      req.on('error', () => finish(0, '', {}));
      req.on('timeout', () => { req.destroy(); finish(0, '', {}); });
      req.end();
    } catch {
      finish(0, '', {});
    }
  });
}

let cache = { at: 0, data: null };
let backoffUntil = 0;
let lastRoute = 'none';
let inflight = null;

function resetPlanUsageState() {
  cache = { at: 0, data: null };
  backoffUntil = 0;
  lastRoute = 'none';
  inflight = null;
  keychainFailUntil = 0;
}

// `at` is when the payload was observed (file mtime for shared, now for API). Do not use wall
// clock for shared piggybacks or memory will keep them "fresh" forever after a re-save.
function remember(payload, at, historyDir) {
  cache = { at, data: payload };
  backoffUntil = 0;
  try { ingestUsagePayload(historyDir, payload, at); } catch { /* history best effort */ }
}

function safeDone(cb, data, state, route) {
  lastRoute = route;
  try { cb(data, state, { route }); } catch { /* caller errors must not reject the poll */ }
}

// cb(data, state, meta) — state: ok|stale|notoken|ratelimited|error|expired|disabled
// meta.route names which path produced the value.
function getUsage(cb, opts = {}) {
  const {
    now = Date.now(),
    enabled = true,
    sharedFile = SHARED_USAGE,
    historyDir = DEFAULT_DIR,
    readToken = readOauthToken,
    fetchUsage = requestUsage,
  } = opts;

  const done = (data, state, route) => safeDone(cb, data, state, route);

  if (!enabled) {
    done(null, 'disabled', 'disabled');
    return;
  }

  if (cache.data && now - cache.at < USAGE_TTL_MS) {
    done(cache.data, 'ok', 'memory');
    return;
  }

  const freshShared = readSharedCache(sharedFile, SHARED_FRESH_MS, now);
  if (freshShared) {
    // Do not rewrite the file: that would bump mtime and freeze the poll (and Claude Control's).
    remember(freshShared.payload, freshShared.mtimeMs, historyDir);
    done(freshShared.payload, 'ok', 'shared-fresh');
    return;
  }

  const staleHit = cache.data
    ? { payload: cache.data, route: 'memory-stale' }
    : (() => {
      const hit = readSharedCache(sharedFile, SHARED_STALE_MS, now);
      return hit ? { payload: hit.payload, route: 'shared-stale' } : null;
    })();
  const staleShared = staleHit && staleHit.payload;

  if (now < backoffUntil) {
    done(staleShared, staleShared ? 'stale' : 'ratelimited', staleShared ? staleHit.route : 'backoff');
    return;
  }

  const raw = readToken({ now });
  const cred = typeof raw === 'string' ? { token: raw } : raw;
  if (!cred || cred.expired || !cred.token) {
    if (cred && cred.expired) {
      backoffUntil = now + AUTH_BACKOFF_MS;
      done(staleShared, staleShared ? 'stale' : 'expired', staleShared ? staleHit.route : 'expired');
      return;
    }
    done(staleShared, staleShared ? 'stale' : 'notoken', staleShared ? staleHit.route : 'notoken');
    return;
  }

  const runFetch = () => {
    if (!inflight) {
      inflight = fetchUsage(cred.token).finally(() => { inflight = null; });
    }
    return inflight;
  };

  runFetch().then(
    ({ statusCode, body, headers }) => {
      const result = classifyUsageResponse(statusCode, body, headers, staleShared);
      if (result.cache) {
        remember(result.cache, now, historyDir);
        writeSharedCache(sharedFile, result.cache);
        done(result.cache, 'ok', 'oauth-api');
        return;
      }
      if (result.backoffMs != null) backoffUntil = now + result.backoffMs;
      done(result.value, result.state, result.value ? (staleHit ? staleHit.route : 'shared-stale') : result.state);
    },
    () => {
      backoffUntil = now + DEFAULT_BACKOFF_MS;
      done(staleShared, staleShared ? 'stale' : 'error', staleShared ? staleHit.route : 'error');
    }
  );
}

function lastUsageRoute() {
  return lastRoute;
}

module.exports = {
  getUsage,
  readOauthToken,
  readSharedCache,
  writeSharedCache,
  classifyUsageResponse,
  slimUsagePayload,
  resetPlanUsageState,
  lastUsageRoute,
  requestUsage,
  USAGE_TTL_MS,
  SHARED_FRESH_MS,
  SHARED_STALE_MS,
  DEFAULT_BACKOFF_MS,
  AUTH_BACKOFF_MS,
};
