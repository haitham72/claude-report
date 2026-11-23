'use strict';

// Live plan usage (same numbers as Claude Code /usage). Tries several routes before giving up:
// fresh memory → fresh shared cache → OAuth API → stale shared / last good.
// Adapted from Claude Control usage.js (MIT, lucasdonordeste).
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DEFAULT_DIR, SHARED_USAGE, ingestUsagePayload } = require('./live');

const USAGE_TTL_MS = 60 * 1000;
const SHARED_FRESH_MS = 75 * 1000;
const SHARED_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKOFF_MS = 120 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

function tokenFromCredentials(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}

function tokenFromKeychain(run = execFileSync) {
  if (process.platform !== 'darwin') return null;
  try {
    const out = run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = JSON.parse(out).claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}

// Try every known local token store. First hit wins; never logs the token.
function readOauthToken({ env = process.env, keychain = tokenFromKeychain, homedir = os.homedir } = {}) {
  const home = homedir();
  const routes = [];
  if (env.CLAUDE_CONFIG_DIR) {
    routes.push(() => tokenFromCredentials(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')));
  }
  routes.push(() => tokenFromCredentials(path.join(home, '.claude', '.credentials.json')));
  routes.push(() => keychain());
  for (const route of routes) {
    const token = route();
    if (token) return token;
  }
  return null;
}

function readSharedCache(file, maxAgeMs, now = Date.now()) {
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > maxAgeMs) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && (j.five_hour || j.seven_day)) return j;
  } catch { /* missing or corrupt */ }
  return null;
}

function writeSharedCache(file, payload) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch { /* sharing the cache is best effort */ }
}

function classifyUsageResponse(statusCode, body, headers, prevGood) {
  let j = null;
  try { j = JSON.parse(body); } catch { /* non-JSON */ }
  const valid = statusCode === 200 && j && (j.five_hour || j.seven_day);
  if (valid) return { value: j, state: 'ok', cache: j };
  if (statusCode === 429) {
    const ra = parseInt(headers && headers['retry-after'], 10);
    return {
      value: prevGood,
      state: prevGood ? 'stale' : 'ratelimited',
      backoffMs: ra > 0 ? ra * 1000 : DEFAULT_BACKOFF_MS,
    };
  }
  return { value: prevGood, state: prevGood ? 'stale' : 'error' };
}

function requestUsage(token, { request = https.request, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (statusCode, body, headers) => {
      if (done) return;
      done = true;
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

function resetPlanUsageState() {
  cache = { at: 0, data: null };
  backoffUntil = 0;
  lastRoute = 'none';
}

function remember(payload, now, historyDir) {
  cache = { at: now, data: payload };
  backoffUntil = 0;
  try { ingestUsagePayload(historyDir, payload, now); } catch { /* history best effort */ }
}

// cb(data, state, meta) — state: ok|stale|notoken|ratelimited|error|disabled
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

  const done = (data, state, route) => {
    lastRoute = route;
    cb(data, state, { route });
  };

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
    remember(freshShared, now, historyDir);
    writeSharedCache(sharedFile, freshShared);
    done(freshShared, 'ok', 'shared-fresh');
    return;
  }

  const staleShared = cache.data || readSharedCache(sharedFile, SHARED_STALE_MS, now);

  if (now < backoffUntil) {
    done(staleShared, staleShared ? 'stale' : 'ratelimited', staleShared ? 'shared-stale' : 'backoff');
    return;
  }

  const token = readToken();
  if (!token) {
    done(staleShared, staleShared ? 'stale' : 'notoken', staleShared ? 'shared-stale' : 'notoken');
    return;
  }

  fetchUsage(token).then(({ statusCode, body, headers }) => {
    const result = classifyUsageResponse(statusCode, body, headers, staleShared);
    if (result.cache) {
      remember(result.cache, now, historyDir);
      writeSharedCache(sharedFile, result.cache);
      done(result.cache, 'ok', 'oauth-api');
      return;
    }
    if (result.backoffMs != null) backoffUntil = now + result.backoffMs;
    done(result.value, result.state, result.value ? 'shared-stale' : result.state);
  }).catch(() => {
    done(staleShared, staleShared ? 'stale' : 'error', staleShared ? 'shared-stale' : 'error');
  });
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
  resetPlanUsageState,
  lastUsageRoute,
  USAGE_TTL_MS,
  SHARED_FRESH_MS,
  SHARED_STALE_MS,
};
