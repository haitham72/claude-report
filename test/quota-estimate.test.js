'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateQuickWorkload,
  estimateDeepWorkload,
  estimateSubscriptionImpact,
  activeQuotaWindows
} = require('../src/quota-estimate');

const assertNoCurrency = (res) => {
  const text = `${res.summaryLine} ${res.detailLines.join(' ')}`;
  assert.doesNotMatch(text, /\$|USD/i, `unexpected currency string in: ${text}`);
};

test('estimateQuickWorkload handles empty input, full prompt slices, lightweight summaries, and effort/model scaling', () => {
  assert.deepEqual(estimateQuickWorkload([]), {
    requests: 0,
    tokensIn: 0,
    tokensOutLow: 0,
    tokensOutHigh: 0,
    peuLow: 0,
    peuHigh: 0
  });

  const fullProjects = [
    {
      name: 'alpha',
      totalTokens: 50000,
      sessions: 4,
      prompts: Array.from({ length: 16 }, (_, i) => ({
        at: `2026-03-10T10:${String(i).padStart(2, '0')}:00.000Z`,
        text: `Implement feature step ${i} with full verification`,
        source: 'claude'
      }))
    }
  ];
  const liteProjects = [{ name: 'alpha', prompts: 20 }];

  const fullHaikuLow = estimateQuickWorkload(fullProjects, {
    provider: 'claude',
    projectModel: 'haiku',
    overviewModel: 'sonnet',
    projectEffort: 'low',
    overviewEffort: 'medium'
  });
  const fullOpusMax = estimateQuickWorkload(fullProjects, {
    provider: 'claude',
    projectModel: 'opus',
    overviewModel: 'opus',
    projectEffort: 'max',
    overviewEffort: 'max'
  });
  const lite = estimateQuickWorkload(liteProjects, { provider: 'claude' });

  assert.equal(fullHaikuLow.requests, 2);
  assert.equal(fullOpusMax.requests, 2);
  assert.equal(fullHaikuLow.tokensIn, fullOpusMax.tokensIn);
  assert.ok(fullOpusMax.peuLow > fullHaikuLow.peuLow * 5, 'opus+max should scale PEU substantially above haiku+low');
  assert.ok(fullOpusMax.peuHigh > fullHaikuLow.peuHigh * 5);

  assert.equal(lite.requests, 2);
  assert.equal(lite.requestsMax, 3);
  assert.ok(lite.tokensIn > 0 && lite.peuLow > 0 && lite.peuHigh > lite.peuLow);
});

test('a long prompt can trigger another project request even when there are few prompts', () => {
  const [project] = [{ name: 'alpha', prompts: [{ text: 'Evidence word. '.repeat(205), at: '2026-03-10T10:00:00Z' }] }];
  const drafts = estimateQuickWorkload([project], { overview: false });
  const complete = estimateQuickWorkload([project]);
  assert.equal(drafts.requests, 1);
  assert.equal(drafts.requestsMax, 2);
  assert.ok(drafts.tokensInHigh > drafts.tokensIn);
  assert.equal(complete.requests, 2);
  assert.equal(complete.requestsMax, 3);
  assert.ok(complete.tokensIn > drafts.tokensIn);
});

test('estimateDeepWorkload excludes reused cached items from requests and tokens', () => {
  const allCached = estimateDeepWorkload(
    [{ id: 'p1', reused: true, tokens: 12000, chunks: 2 }],
    { finalizer: false }
  );
  assert.deepEqual(allCached, {
    requests: 0,
    tokensIn: 0,
    tokensOutLow: 0,
    tokensOutHigh: 0,
    peuLow: 0,
    peuHigh: 0
  });

  const mixed = estimateDeepWorkload([
    { id: 'p1', reused: true, tokens: 50000, chunks: 3 },
    { id: 'p2', reused: false, tokens: 10000, chunks: 2 }
  ]);
  const liveOnly = estimateDeepWorkload([
    { id: 'p2', reused: false, tokens: 10000, chunks: 2 }
  ]);
  // Cached p1 contributes 0 review chunks and 0 review tokens (only overviewIn includes items.length * 650)
  assert.equal(mixed.requests, 3); // 2 chunks + 1 finalizer
  assert.equal(mixed.requestsMax, 4); // one extra split batch for the uncached project
  assert.equal(mixed.tokensOutLow, liveOnly.tokensOutLow);
  assert.equal(mixed.tokensOutHigh, liveOnly.tokensOutHigh);
  assert.equal(mixed.tokensIn - liveOnly.tokensIn, 650);

  const overview = estimateDeepWorkload([], { finalizer: true, overviewProjects: 2 });
  assert.equal(overview.requests, 1);
  assert.equal(overview.tokensIn, 3500);
});

test('estimateSubscriptionImpact covers calibrated, tokens-only, cached, and tight headroom cases without currency', () => {
  const workload = { requests: 4, tokensIn: 18000, tokensOutLow: 1200, tokensOutHigh: 2400, peuLow: 12000, peuHigh: 18000 };
  const seenAt = Date.now();

  // 0 requests (all cached)
  const cachedRes = estimateSubscriptionImpact({
    provider: 'claude',
    providerLabel: 'Claude Code',
    planLabel: 'Max 5x',
    workload: { requests: 0, tokensIn: 0, tokensOutLow: 0, tokensOutHigh: 0, peuLow: 0, peuHigh: 0 }
  });
  assert.equal(cachedRes.requests, 0);
  assert.equal(cachedRes.tight, false);
  assertNoCurrency(cachedRes);

  // Calibrated Claude
  const calRes = estimateSubscriptionImpact({
    provider: 'claude',
    providerLabel: 'Claude Code',
    planLabel: 'Pro',
    workload,
    calibration: {
      source: 'calibrated',
      fiveHour: { median: 2000, p25: 1500, p75: 2500, count: 4 },
      sevenDay: { median: 20000, p25: 15000, p75: 25000, count: 4 }
    },
    liveQuota: { fiveHour: { pct: 20, seenAt }, sevenDay: { pct: 10, seenAt } }
  });
  assert.equal(calRes.confidence, 'calibrated');
  assert.deepEqual(calRes.pct5h, [3.84, 15]);
  assert.deepEqual(calRes.pct7d, [0.384, 1.5]);
  assert.deepEqual(calRes.projected5h, [23.84, 35]);
  assert.deepEqual(calRes.projected7d, [10.384, 11.5]);
  assert.equal(calRes.tight, false);
  assert.match(calRes.summaryLine, /rough local estimate/);
  assertNoCurrency(calRes);

  const noSnapshot = estimateSubscriptionImpact({
    provider: 'codex',
    providerLabel: 'Codex',
    planLabel: 'ChatGPT Plus',
    workload,
    calibration: {
      source: 'calibrated',
      fiveHour: { median: 70000, p25: 40000, p75: 105000, count: 3 }
    },
    liveQuota: null
  });
  assert.equal(noSnapshot.confidence, 'calibrated');
  assert.ok(noSnapshot.pct5h);
  assert.equal(noSnapshot.pct7d, null);
  assert.equal(noSnapshot.projected5h, null);
  assertNoCurrency(noSnapshot);

  // Tokens-only fallback (Antigravity / Muse without quota)
  const tokensOnlyRes = estimateSubscriptionImpact({
    provider: 'antigravity',
    providerLabel: 'Antigravity',
    planLabel: 'Antigravity',
    workload,
    calibration: { source: 'tokens-only', fiveHour: null, sevenDay: null },
    liveQuota: null
  });
  assert.equal(tokensOnlyRes.confidence, 'tokens-only');
  assert.equal(tokensOnlyRes.pct5h, null);
  assert.equal(tokensOnlyRes.pct7d, null);
  assert.match(tokensOnlyRes.summaryLine, /tokens/);
  assert.match(tokensOnlyRes.summaryLine, /4 requests/);
  assert.match(tokensOnlyRes.summaryLine, /quota impact unavailable/);
  assertNoCurrency(tokensOnlyRes);

  // Tight headroom (>= 85%) selects lowest-utilization connected alternative
  const tightAlt = estimateSubscriptionImpact({
    provider: 'claude',
    providerLabel: 'Claude Code',
    planLabel: 'Pro',
    workload,
    calibration: {
      source: 'calibrated',
      fiveHour: { median: 2000, p25: 1500, p75: 2500, count: 4 },
      sevenDay: null
    },
    liveQuota: { fiveHour: { pct: 76, seenAt } },
    alternatives: [
      { id: 'claude', label: 'Claude Code', connected: true, maxPct: 76 },
      { id: 'codex', label: 'Codex', planLabel: 'ChatGPT Plus', connected: true, maxPct: 55 },
      { id: 'muse', label: 'Muse', planLabel: 'Pro', connected: true, maxPct: 12 },
      { id: 'gemini', label: 'Gemini CLI', connected: false, maxPct: 0 }
    ]
  });
  assert.equal(tightAlt.tight, true);
  assert.equal(tightAlt.suggestedAlternative.id, 'muse');
  assert.equal(tightAlt.suggestedAlternative.maxPct, 12);
  assertNoCurrency(tightAlt);

  // Tight headroom with all alternatives >= 70% falls back to local model
  const tightLocal = estimateSubscriptionImpact({
    provider: 'claude',
    providerLabel: 'Claude Code',
    planLabel: 'Pro',
    workload,
    calibration: {
      source: 'calibrated',
      fiveHour: { median: 2000, p25: 1500, p75: 2500, count: 4 },
      sevenDay: null
    },
    liveQuota: { fiveHour: { pct: 80, seenAt } },
    alternatives: [
      { id: 'codex', label: 'Codex', connected: true, maxPct: 75 },
      { id: 'muse', label: 'Muse', connected: true, maxPct: null }
    ]
  });
  assert.equal(tightLocal.tight, true);
  assert.equal(tightLocal.suggestedAlternative.id, 'local');
  assertNoCurrency(tightLocal);
});

test('snapshots respect reset times, and current usage alone does not establish report impact', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const liveQuota = {
    fiveHour: { pct: 25, resetsAt: (now - 1000) / 1000 },
    sevenDay: { pct: 37, resetsAt: (now + 86400000) / 1000 },
    windows: [{ label: '30 min', pct: 105, resetsAt: (now + 1000) / 1000 }]
  };
  assert.deepEqual(activeQuotaWindows(liveQuota, now).map(({ label, pct }) => [label, pct]), [['Weekly', 37], ['30 min', 105]]);
  const res = estimateSubscriptionImpact({
    provider: 'muse', providerLabel: 'Muse', now, liveQuota,
    workload: { requests: 2, requestsMax: 4, tokensIn: 100, tokensInHigh: 250, tokensOutLow: 100, tokensOutHigh: 250, peuLow: 200, peuHigh: 500 }
  });
  assert.equal(res.current5h, null);
  assert.equal(res.current7d, 37);
  assert.equal(res.pct7d, null);
  assert.equal(res.projected7d, null);
  assert.equal(res.tight, true);
  assert.match(res.summaryLine, /200–500 report tokens · 2–4 requests · quota impact unavailable/);
  assert.ok(res.detailLines.includes('30 min last seen 105% used'));
});

test('a stale observation is displayed without an after-run projection', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const res = estimateSubscriptionImpact({
    provider: 'codex', providerLabel: 'Codex', now,
    liveQuota: { fiveHour: { pct: 20, seenAt: now - 3600000, resetsAt: (now + 3600000) / 1000 } },
    calibration: { fiveHour: { p25: 1000, p75: 1500, count: 3 } },
    workload: { requests: 1, tokensIn: 900, tokensOutLow: 100, tokensOutHigh: 150, peuLow: 1000, peuHigh: 1050 }
  });
  assert.ok(res.pct5h);
  assert.equal(res.current5h, 20);
  assert.equal(res.projected5h, null);
  assert.match(res.summaryLine, /last seen 20% used/);
});
