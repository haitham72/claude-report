'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getUsage, classifyUsageResponse, resetPlanUsageState, readOauthToken, lastUsageRoute,
} = require('../src/plan-usage');
const { readHistory, readLive } = require('../src/live');

const NOW = 1_700_000_000_000;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-report-plan-'));
}

function payload(s = 37, w = 8) {
  return {
    five_hour: { utilization: s, resets_at: new Date(NOW + 3600e3).toISOString() },
    seven_day: { utilization: w, resets_at: new Date(NOW + 86400e3).toISOString() },
  };
}

test('classify keeps last good on 429 and errors', () => {
  const good = payload();
  assert.equal(classifyUsageResponse(200, JSON.stringify(good), {}, null).state, 'ok');
  assert.equal(classifyUsageResponse(429, '', { 'retry-after': '30' }, good).state, 'stale');
  assert.equal(classifyUsageResponse(429, '', { 'retry-after': '30' }, good).backoffMs, 30000);
  assert.equal(classifyUsageResponse(429, '', {}, null).state, 'ratelimited');
  assert.equal(classifyUsageResponse(500, 'nope', {}, good).state, 'stale');
  assert.equal(classifyUsageResponse(500, 'nope', {}, null).state, 'error');
});

test('getUsage tries memory, then shared, then oauth, then stale — not a single path', async () => {
  resetPlanUsageState();
  const dir = tmp();
  const shared = path.join(dir, 'shared.json');
  const body = payload(12, 4);

  // Route 1: shared-fresh when memory empty.
  fs.writeFileSync(shared, JSON.stringify(body));
  fs.utimesSync(shared, NOW / 1000, NOW / 1000);
  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(state, 'ok');
      assert.equal(meta.route, 'shared-fresh');
      assert.equal(data.five_hour.utilization, 12);
      assert.equal(lastUsageRoute(), 'shared-fresh');
      resolve();
    }, { now: NOW, sharedFile: shared, historyDir: dir, readToken: () => null, fetchUsage: async () => assert.fail('should not call API') });
  });
  assert.equal(readLive({ dir, now: NOW + 1, sharedFile: shared }).fiveHour.pct, 12);
  assert.ok(readHistory({ dir }).some((p) => p.s === 12));

  // Route 2: memory TTL hits without re-reading disk or API.
  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(state, 'ok');
      assert.equal(meta.route, 'memory');
      assert.equal(data.five_hour.utilization, 12);
      resolve();
    }, { now: NOW + 1000, sharedFile: shared, historyDir: dir, readToken: () => 'tok', fetchUsage: async () => assert.fail('memory should win') });
  });

  // Route 3: oauth-api when memory expired and shared aged past fresh window.
  resetPlanUsageState();
  fs.utimesSync(shared, (NOW - 120000) / 1000, (NOW - 120000) / 1000);
  const apiBody = payload(37, 8);
  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(state, 'ok');
      assert.equal(meta.route, 'oauth-api');
      assert.equal(data.five_hour.utilization, 37);
      resolve();
    }, {
      now: NOW,
      sharedFile: shared,
      historyDir: dir,
      readToken: () => 'tok',
      fetchUsage: async () => ({ statusCode: 200, body: JSON.stringify(apiBody), headers: {} }),
    });
  });
  assert.equal(JSON.parse(fs.readFileSync(shared, 'utf8')).five_hour.utilization, 37);

  // Route 4: shared-stale / notoken when API unavailable.
  resetPlanUsageState();
  fs.writeFileSync(shared, JSON.stringify(payload(9, 1)));
  fs.utimesSync(shared, (NOW - 120000) / 1000, (NOW - 120000) / 1000);
  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(state, 'stale');
      assert.equal(meta.route, 'shared-stale');
      assert.equal(data.five_hour.utilization, 9);
      resolve();
    }, { now: NOW, sharedFile: shared, historyDir: dir, readToken: () => null, fetchUsage: async () => assert.fail('no token') });
  });

  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(data, null);
      assert.equal(state, 'notoken');
      assert.equal(meta.route, 'notoken');
      resolve();
    }, { now: NOW, sharedFile: path.join(dir, 'missing.json'), historyDir: dir, readToken: () => null });
  });

  await new Promise((resolve) => {
    getUsage((data, state, meta) => {
      assert.equal(state, 'disabled');
      assert.equal(meta.route, 'disabled');
      resolve();
    }, { enabled: false, now: NOW });
  });
});

test('readOauthToken tries credentials routes before keychain', () => {
  const dir = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'from-config-dir' } }));
  assert.equal(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: dir },
    homedir: () => home,
    keychain: () => assert.fail('file should win'),
  }), 'from-config-dir');

  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'from-home' } }));
  assert.equal(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: path.join(dir, 'empty') },
    homedir: () => home,
    keychain: () => assert.fail('home credentials should win'),
  }), 'from-home');

  fs.unlinkSync(path.join(home, '.claude', '.credentials.json'));
  assert.equal(readOauthToken({
    env: { CLAUDE_CONFIG_DIR: path.join(dir, 'empty') },
    homedir: () => home,
    keychain: () => 'from-keychain',
  }), 'from-keychain');
  assert.equal(readOauthToken({
    env: {},
    homedir: () => home,
    keychain: () => null,
  }), null);
});
