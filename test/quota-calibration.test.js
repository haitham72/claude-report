'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  modelWeight,
  effortMultiplier,
  weightedUnits,
  summarizeSamples,
  calibrateCodex,
  calibrateClaude,
  readMuseQuota,
  resolveCalibration
} = require('../src/quota-calibration');

function makeTempDir(t, prefix = 'qcal-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('modelWeight, effortMultiplier, and weightedUnits compute expected scales', () => {
  assert.equal(modelWeight('claude', 'claude-haiku-4-5'), 0.3);
  assert.equal(modelWeight('claude', 'claude-opus-4'), 3.5);
  assert.equal(modelWeight('claude', 'claude-sonnet-4'), 1.0);

  assert.equal(modelWeight('codex', 'gpt-5.4-mini'), 0.3);
  assert.equal(modelWeight('codex', 'gpt-5.4'), 1.0);

  assert.equal(modelWeight('muse', 'muse-spark-1.3'), 0.5);
  assert.equal(modelWeight('muse', 'muse-wonder-1.0'), 2.0);
  assert.equal(modelWeight('muse', 'muse-ember-1.0'), 1.0);

  assert.equal(modelWeight('antigravity', 'gemini-3.8-flash-medium'), 0.2);
  assert.equal(modelWeight('antigravity', 'argon-lite'), 0.2);
  assert.equal(modelWeight('antigravity', 'claude-opus'), 2.5);
  assert.equal(modelWeight('antigravity', 'gemini-4-neon-high'), 2.0);
  assert.equal(modelWeight('antigravity', 'gemini-4-carbon'), 1.0);
  assert.equal(modelWeight('unknown', 'anything'), 1.0);

  assert.equal(effortMultiplier('low'), 1.0);
  assert.equal(effortMultiplier('medium'), 1.4);
  assert.equal(effortMultiplier('high'), 2.0);
  assert.equal(effortMultiplier('xhigh'), 2.5);
  assert.equal(effortMultiplier('max'), 2.8);
  assert.equal(effortMultiplier('unknown'), 1.2);

  // 2 * (1000 + 0.1*500 + 0.25*200 + 5*2.0*100) = 2 * (1000 + 50 + 50 + 1000) = 4200
  assert.equal(
    weightedUnits({ input: 1000, output: 100, cacheRead: 500, cacheCreate: 200, modelWeight: 2, effortMultiplier: 2.0 }),
    4200
  );
  // Negative inputs are clamped to 0
  assert.equal(weightedUnits({ input: -50, output: -10, cacheRead: -5, cacheCreate: -5 }), 0);
});

test('summarizeSamples filters non-positive values and trims 10% outliers when count >= 6', () => {
  assert.equal(summarizeSamples([]), null);
  assert.equal(summarizeSamples([0, -5, NaN, Infinity]), null);

  // Fewer than 6 samples: no trimming
  assert.deepEqual(summarizeSamples([100, 200, 300, 400]), {
    median: 250,
    p25: 175,
    p75: 325,
    count: 4
  });

  // 10 samples with extreme low (1) and extreme high (999999) outliers -> trims 1 from each end
  const ten = [1, 100, 120, 140, 160, 180, 200, 220, 240, 999999];
  const res = summarizeSamples(ten);
  assert.equal(res.count, 8);
  assert.ok(res.p25 >= 120 && res.p25 <= 140);
  assert.ok(res.median >= 160 && res.median <= 180);
  assert.ok(res.p75 >= 200 && res.p75 <= 220);
});

test('calibrateCodex aggregates 5h and 7d resets_at buckets, ignores <3% tiny buckets and expired live windows', (t) => {
  const dir = makeTempDir(t, 'qcal-codex-');
  const now = Date.parse('2026-03-15T12:00:00.000Z');
  const nowSec = Math.floor(now / 1000);

  const rec = (tsIso, totals, last, pPct, pReset, sPct, sReset, plan = 'plus', id = 'codex') => ({
    timestamp: tsIso,
    payload: {
      type: 'token_count',
      model: 'gpt-5.4',
      rate_limits: {
        plan_type: plan,
        limit_id: id,
        primary: { used_percent: pPct, resets_at: pReset, window_minutes: 300 },
        secondary: { used_percent: sPct, resets_at: sReset, window_minutes: 10080 }
      },
      info: {
        total_token_usage: totals,
        last_token_usage: last
      }
    }
  });

  // Rollout 1: active 5h bucket (reset in future, 10% delta) & tiny 7d bucket (2% delta, ignored)
  // Also an expired 7d bucket earlier in history vs active 5h bucket at end.
  const active5Reset = nowSec + 3600;
  const expired7Reset = nowSec - 600;
  const expiredLive7Reset = nowSec - 300;
  const future7Reset = nowSec + 5 * 86400;

  fs.writeFileSync(
    path.join(dir, 'rollout-1.jsonl'),
    jl(
      // Bucket A (expired 5h, 10% delta, 10000 input => peu = 10000 => 1000/pct)
      rec('2026-03-10T10:00:00.000Z', { input_tokens: 10000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, { input_tokens: 10000, output_tokens: 0 }, 10, nowSec - 100000, 10, expired7Reset),
      rec('2026-03-10T11:00:00.000Z', { input_tokens: 20000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, { input_tokens: 10000, output_tokens: 0 }, 20, nowSec - 100000, 12, expired7Reset) // 7d delta = 2% < 3% -> ignored
    )
  );

  fs.writeFileSync(
    path.join(dir, 'rollout-2.jsonl'),
    jl(
      // Bucket B (active 5h, 5% delta; 7d active bucket, 4% delta)
      rec('2026-03-15T10:00:00.000Z', { input_tokens: 5000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, { input_tokens: 5000, output_tokens: 0 }, 25, active5Reset, 30, future7Reset),
      rec('2026-03-15T11:00:00.000Z', { input_tokens: 15000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, { input_tokens: 10000, output_tokens: 0 }, 30, active5Reset, 34, future7Reset),
      // Latest record has expired 7d window (resets_at in the past) and active 5h window
      rec('2026-03-15T11:50:00.000Z', { input_tokens: 25000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, { input_tokens: 10000, output_tokens: 0 }, 35, active5Reset, 40, expiredLive7Reset),
      rec('2026-03-15T11:55:00.000Z', { input_tokens: 40000 }, { input_tokens: 15000 }, 90, active5Reset, 90, future7Reset, 'pro', 'mini')
    )
  );

  const cal = calibrateCodex({ sessionsDir: dir, now });
  assert.equal(cal.planLabel, 'ChatGPT Plus');
  assert.equal(cal.fiveHour.count, 2);
  assert.equal(cal.fiveHour.median, 1500, 'initial token totals are outside the measured window');
  assert.equal(cal.sevenDay.count, 1); // tiny 2% bucket ignored; only future7Reset (4% delta) counted
  assert.equal(cal.live.fiveHour.pct, 35);
  assert.equal(cal.live.fiveHour.resetsAt, active5Reset);
  assert.equal(cal.live.sevenDay, null, 'expired live window must be ignored');
});

test('calibrateClaude computes rising spans across refill drops, dedupes streamed chunks, and ignores near-zero spans', (t) => {
  const dir = makeTempDir(t, 'qcal-claude-');
  const claudeDir = path.join(dir, 'claude');
  const historyDir = path.join(dir, 'history');
  const projectsDir = path.join(claudeDir, 'projects', 'proj-a');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  const now = Date.parse('2026-03-15T12:00:00.000Z');
  const t0 = now - 6 * 3600_000;

  // Usage history with:
  // Span 1 (5h): 10% -> 20% (delta 10), then refill drop to 5% (>= REFILL_DROP 8)
  // Span 2 (5h): 5% -> 15% (delta 10) with near-zero local tokens -> ignored
  // Span 3 (7d): 20% -> 25% (delta 5) over the whole range
  const history = [
    { t: t0, s: 10, w: 20, sr: t0 + 18000_000, wr: t0 + 7 * 86400_000 },
    { t: t0 + 1800_000, s: 20, w: 23, sr: t0 + 18000_000, wr: t0 + 7 * 86400_000 },
    { t: t0 + 3600_000, s: 5, w: 25, sr: t0 + 36000_000, wr: t0 + 7 * 86400_000 },
    { t: t0 + 5400_000, s: 15, w: 25, sr: t0 + 36000_000, wr: t0 + 7 * 86400_000 }
  ];
  fs.writeFileSync(path.join(historyDir, 'usage-history.json'), JSON.stringify(history));

  // Streamed assistant chunks with duplicate message.id ('msg-1') — max PEU wins, plus an ignored claude-report-work record
  fs.writeFileSync(
    path.join(projectsDir, 'sess.jsonl'),
    jl(
      {
        type: 'assistant',
        cwd: '/tmp/my-app',
        timestamp: new Date(t0 + 600_000).toISOString(),
        message: { id: 'msg-1', model: 'claude-sonnet-4', usage: { input_tokens: 1000, output_tokens: 10 } }
      },
      {
        type: 'assistant',
        cwd: '/tmp/my-app',
        timestamp: new Date(t0 + 601_000).toISOString(),
        // Same message.id: higher output -> 10000 + 5*1000 = 15000 weighted units.
        message: { id: 'msg-1', model: 'claude-sonnet-4', usage: { input_tokens: 10000, output_tokens: 1000 } }
      },
      {
        type: 'assistant',
        cwd: '/tmp/claude-report-work/scratch',
        timestamp: new Date(t0 + 700_000).toISOString(),
        message: { id: 'msg-ignored', model: 'claude-opus-4', usage: { input_tokens: 999999, output_tokens: 99999 } }
      },
      {
        // Span 2 has only 100 tokens -> PEU < 2000 -> ignored
        type: 'assistant',
        cwd: '/tmp/my-app',
        timestamp: new Date(t0 + 4200_000).toISOString(),
        message: { id: 'msg-2', model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 5 } }
      }
    )
  );

  const cal = calibrateClaude({ claudeDir, historyDir, controlFile: null, now });
  // Only span 1 had at least 2000 weighted units.
  assert.equal(cal.fiveHour.count, 1);
  assert.equal(cal.fiveHour.median, 1500);
  // Weekly: 20% → 25%. Both events contribute, including 125 units from the second span.
  assert.equal(cal.sevenDay.count, 1);
  assert.equal(cal.sevenDay.median, 3025);
});

test('readMuseQuota handles missing allowance and active allowance payloads', () => {
  const resolve = () => ({ command: '/bin/muse', prefix: [], path: '/bin/muse' });

  const noUsage = readMuseQuota({
    resolve,
    exec: () => JSON.stringify({ allowance: null, reason: 'server_sent_no_usage', subscriptionActive: true, tierName: 'Power' })
  });
  assert.deepEqual(noUsage, { available: false, reason: 'server_sent_no_usage', subscriptionActive: true, planLabel: 'Power' });

  const active = readMuseQuota({
    resolve,
    exec: () => JSON.stringify({
      allowance: {
        tier: 'power',
        window: { usedPercent: 42.5, resetsAtMs: 1_800_000_000_000, windowDurationMins: 300 },
        weekly: { usedPercent: 18, resetsAtMs: Date.parse('2026-04-01T00:00:00.000Z') },
        observedAtMs: Date.parse('2026-03-27T10:00:00.000Z')
      }
    })
  });
  assert.equal(active.available, true);
  assert.equal(active.planLabel, 'Power');
  assert.equal(active.subscriptionActive, true);
  assert.equal(active.fiveHour.pct, 42.5);
  assert.equal(active.fiveHour.resetsAt, 1_800_000_000);
  assert.equal(active.sevenDay.pct, 18);
  assert.equal(active.sevenDay.resetsAt, Date.parse('2026-04-01T00:00:00.000Z') / 1000);
  assert.equal(active.sevenDay.seenAt, Date.parse('2026-03-27T10:00:00.000Z'));

  const custom = readMuseQuota({ resolve, now: 1_790_000_000_000, exec: () => JSON.stringify({
    allowance: { window: { usedPercent: 25, resetsAtMs: 1_800_000_000_000, windowDurationMins: 480 } }
  }) });
  assert.equal(custom.fiveHour, null);
  assert.deepEqual(custom.windows, [{ label: '480 min', pct: 25, resetsAt: 1_800_000_000, seenAt: 1_790_000_000_000 }]);
});

test('resolveCalibration requires two observations per window and checks the Codex plan tier', () => {
  const stats = { median: 50000, p25: 40000, p75: 60000, count: 2 };
  const empirical = { planLabel: 'ChatGPT Pro', fiveHour: stats, sevenDay: { ...stats, count: 1 } };
  assert.deepEqual(resolveCalibration({ provider: 'codex', planLabel: 'Pro', empirical }), {
    source: 'calibrated', fiveHour: stats, sevenDay: null
  });
  const unavailable = { source: 'tokens-only', fiveHour: null, sevenDay: null };
  assert.deepEqual(resolveCalibration({ provider: 'codex', planLabel: 'ChatGPT Plus', empirical }), unavailable);
  assert.deepEqual(resolveCalibration({ provider: 'claude', planLabel: 'Max 5x' }), unavailable);
});
