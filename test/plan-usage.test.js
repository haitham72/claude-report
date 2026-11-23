'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getUsage, classifyUsageResponse, resetPlanUsageState, readOauthToken, lastUsageRoute,
  readSharedCache, writeSharedCache, slimUsagePayload, SHARED_FRESH_MS, AUTH_BACKOFF_MS,
} = require('../src/plan-usage');
const { readHistory, readLive, writeLive } = require('../src/live');

const NOW = 1_700_000_000_000;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-report-plan-'));
}

function payload(s = 37, w = 8, base = NOW) {
  return {
    five_hour: { utilization: s, resets_at: new Date(base + 3600e3).toISOString() },
    seven_day: { utilization: w, resets_at: new Date(base + 86400e3).toISOString() },
  };
}

function once(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((data, state, meta) => {
        try { resolve({ data, state, meta }); } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
}

test('classify keeps last good on 429 and backs off other failures', () => {
  const good = payload();
  assert.equal(classifyUsageResponse(200, JSON.stringify(good), {}, null).state, 'ok');
  assert.equal(classifyUsageResponse(429, '', { 'retry-after': '30' }, good).state, 'stale');
  assert.equal(classifyUsageResponse(429, '', { 'retry-after': '30' }, good).backoffMs, 30000);
  assert.equal(classifyUsageResponse(429, '', {}, null).state, 'ratelimited');
  const auth = classifyUsageResponse(401, 'nope', {}, null);
  assert.equal(auth.state, 'expired');
  assert.equal(auth.backoffMs, AUTH_BACKOFF_MS);
  const err = classifyUsageResponse(500, 'nope', {}, null);
  assert.equal(err.state, 'error');
  assert.ok(err.backoffMs > 0);
  assert.equal(classifyUsageResponse(500, 'nope', {}, good).state, 'stale');
  assert.equal(slimUsagePayload({ five_hour: 1 }), null);
});

test('getUsage tries memory, then shared, then oauth, then stale — not a single path', async () => {
  resetPlanUsageState();
  const dir = tmp();
  const shared = path.join(dir, 'shared.json');
  const body = payload(12, 4);

  fs.writeFileSync(shared, JSON.stringify(body));
  fs.utimesSync(shared, NOW / 1000, NOW / 1000);
  const r1 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => null,
    fetchUsage: async () => assert.fail('should not call API'),
  }));
  assert.equal(r1.state, 'ok');
  assert.equal(r1.meta.route, 'shared-fresh');
  assert.equal(r1.data.five_hour.utilization, 12);
  assert.equal(lastUsageRoute(), 'shared-fresh');
  assert.equal(readLive({ dir, now: NOW + 1, sharedFile: shared }).fiveHour.pct, 12);
  assert.ok(readHistory({ dir }).some((p) => p.s === 12));

  const r2 = await once((cb) => getUsage(cb, {
    now: NOW + 1000, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => assert.fail('memory should win'),
  }));
  assert.equal(r2.state, 'ok');
  assert.equal(r2.meta.route, 'memory');

  resetPlanUsageState();
  fs.utimesSync(shared, (NOW - 120000) / 1000, (NOW - 120000) / 1000);
  const apiBody = payload(37, 8);
  const r3 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => ({ statusCode: 200, body: JSON.stringify(apiBody), headers: {} }),
  }));
  assert.equal(r3.state, 'ok');
  assert.equal(r3.meta.route, 'oauth-api');
  assert.equal(r3.data.five_hour.utilization, 37);
  assert.equal(JSON.parse(fs.readFileSync(shared, 'utf8')).five_hour.utilization, 37);

  resetPlanUsageState();
  fs.writeFileSync(shared, JSON.stringify(payload(9, 1)));
  fs.utimesSync(shared, (NOW - 120000) / 1000, (NOW - 120000) / 1000);
  const r4 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => null,
    fetchUsage: async () => assert.fail('no token'),
  }));
  assert.equal(r4.state, 'stale');
  assert.equal(r4.meta.route, 'shared-stale');

  const r5 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: path.join(dir, 'missing.json'), historyDir: dir, readToken: () => null,
  }));
  assert.equal(r5.data, null);
  assert.equal(r5.state, 'notoken');

  const r6 = await once((cb) => getUsage(cb, { enabled: false, now: NOW }));
  assert.equal(r6.state, 'disabled');
});

test('shared-fresh does not bump mtime; aged shared triggers a second API call', async () => {
  resetPlanUsageState();
  const dir = tmp();
  const shared = path.join(dir, 'shared.json');
  fs.writeFileSync(shared, JSON.stringify(payload(11, 3)));
  fs.utimesSync(shared, NOW / 1000, NOW / 1000);
  const mtimeBefore = fs.statSync(shared).mtimeMs;

  await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => null,
    fetchUsage: async () => assert.fail('fresh shared'),
  }));
  assert.equal(fs.statSync(shared).mtimeMs, mtimeBefore);

  // Memory TTL uses the file mtime as `at`, so after >75s both memory and shared are stale.
  let calls = 0;
  const r = await once((cb) => getUsage(cb, {
    now: NOW + SHARED_FRESH_MS + 1,
    sharedFile: shared,
    historyDir: dir,
    readToken: () => 'tok',
    fetchUsage: async () => {
      calls += 1;
      return { statusCode: 200, body: JSON.stringify(payload(22, 5, NOW + SHARED_FRESH_MS + 1)), headers: {} };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(r.meta.route, 'oauth-api');
  assert.equal(r.data.five_hour.utilization, 22);

  // A second call more than a fresh window later hits the API again.
  fs.utimesSync(shared, (NOW + SHARED_FRESH_MS + 1 - 120000) / 1000, (NOW + SHARED_FRESH_MS + 1 - 120000) / 1000);
  resetPlanUsageState();
  const r2 = await once((cb) => getUsage(cb, {
    now: NOW + SHARED_FRESH_MS + 1 + 120000,
    sharedFile: shared,
    historyDir: dir,
    readToken: () => 'tok',
    fetchUsage: async () => {
      calls += 1;
      return { statusCode: 200, body: JSON.stringify(payload(33, 6, NOW + SHARED_FRESH_MS + 1 + 120000)), headers: {} };
    },
  }));
  assert.equal(calls, 2);
  assert.equal(r2.data.five_hour.utilization, 33);
});

test('malformed shared payload is not treated as fresh', () => {
  const dir = tmp();
  const shared = path.join(dir, 'shared.json');
  fs.writeFileSync(shared, JSON.stringify({ five_hour: 1 }));
  fs.utimesSync(shared, NOW / 1000, NOW / 1000);
  assert.equal(readSharedCache(shared, SHARED_FRESH_MS, NOW), null);
});

test('newer hook reading beats an older shared OAuth cache in readLive', () => {
  const dir = tmp();
  const shared = path.join(dir, 'shared.json');
  writeSharedCache(shared, payload(11, 3));
  const mtime = NOW / 1000;
  fs.utimesSync(shared, mtime, mtime);
  writeLive({
    session_id: 's1',
    cwd: '/a',
    model: { display_name: 'Sonnet' },
    context_window: { used_percentage: 10 },
    rate_limits: {
      five_hour: { used_percentage: 50, resets_at: NOW / 1000 + 3600 },
      seven_day: { used_percentage: 8, resets_at: NOW / 1000 + 86400 },
    },
  }, { dir, now: NOW + 60_000 });
  const live = readLive({ dir, now: NOW + 61_000, sharedFile: shared });
  assert.equal(live.fiveHour.pct, 50);
});

test('429 and 401 back off through getUsage', async () => {
  resetPlanUsageState();
  const dir = tmp();
  const shared = path.join(dir, 'missing.json');
  let calls = 0;
  const r1 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => { calls += 1; return { statusCode: 429, body: '', headers: {} }; },
  }));
  assert.equal(r1.state, 'ratelimited');
  assert.equal(r1.meta.route, 'ratelimited');

  const r2 = await once((cb) => getUsage(cb, {
    now: NOW + 1000, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => { calls += 1; assert.fail('backoff'); },
  }));
  assert.equal(r2.meta.route, 'backoff');
  assert.equal(calls, 1);

  resetPlanUsageState();
  const r3 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => ({ statusCode: 401, body: '', headers: {} }),
  }));
  assert.equal(r3.state, 'expired');
  const r3b = await once((cb) => getUsage(cb, {
    now: NOW + 1000, sharedFile: shared, historyDir: dir, readToken: () => 'tok',
    fetchUsage: async () => assert.fail('auth backoff'),
  }));
  assert.equal(r3b.meta.route, 'backoff');

  resetPlanUsageState();
  const r4 = await once((cb) => getUsage(cb, {
    now: NOW, sharedFile: shared, historyDir: dir,
    readToken: () => ({ expired: true }),
    fetchUsage: async () => assert.fail('expired token'),
  }));
  assert.equal(r4.state, 'expired');
  assert.equal(r4.meta.route, 'expired');
});

test('readOauthToken tries credentials routes before keychain and respects expiresAt', () => {
  const dir = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'from-config-dir' } }));
  assert.deepEqual(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: dir },
    homedir: () => home,
    keychain: () => assert.fail('file should win'),
    now: NOW,
  }), { token: 'from-config-dir' });

  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'old', expiresAt: Math.floor(NOW / 1000) - 10 },
  }));
  assert.deepEqual(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: path.join(dir, 'empty') },
    homedir: () => home,
    keychain: () => null,
    now: NOW,
  }), { expired: true });

  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'from-home' } }));
  assert.deepEqual(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: path.join(dir, 'empty') },
    homedir: () => home,
    keychain: () => assert.fail('home credentials should win'),
    now: NOW,
  }), { token: 'from-home' });

  fs.unlinkSync(path.join(home, '.claude', '.credentials.json'));
  assert.deepEqual(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: path.join(dir, 'empty') },
    homedir: () => home,
    keychain: () => 'from-keychain',
    now: NOW,
  }), { token: 'from-keychain' });
});
