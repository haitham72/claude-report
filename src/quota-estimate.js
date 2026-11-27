'use strict';

// Forecasts token workload for Quick/Deep reports and converts it into estimated
// subscription quota percentages and before -> after headroom projections.
const { sliceProject, buildProjectPrompt, detailTarget } = require('./generate');
const { modelWeight, effortMultiplier, weightedUnits, quotaResetSeconds } = require('./quota-calibration');
const { plannedRequests } = require('./request-budget');

const approxTokens = (chars) => Math.max(1, Math.ceil(chars / 3.6));

function estimateQuickWorkload(projects, { estimateTime = false, overview = true, provider = 'claude', projectModel = 'haiku', overviewModel = 'sonnet', projectEffort = 'medium', overviewEffort = 'high' } = {}) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return { requests: 0, tokensIn: 0, tokensOutLow: 0, tokensOutHigh: 0, peuLow: 0, peuHigh: 0 };

  let projectIn = 0;
  let projectOutLow = 0;
  let projectOutHigh = 0;
  let expandCalls = 0;
  let expandIn = 0;
  let expandOut = 0;

  for (const p of list) {
    let input, outputLow, outputHigh, mayExpand;
    if (Array.isArray(p.prompts)) {
      const slice = sliceProject(p, { maxPrompts: 60, maxChars: 36000 });
      const prompt = buildProjectPrompt(slice, { estimateTime, previousWords: p.previousExpandedWords });
      input = approxTokens(Buffer.byteLength(prompt, 'utf8'));
      const count = slice.prompts.length;
      const target = detailTarget(slice, p.previousExpandedWords);
      outputLow = target ? 500 : count >= 15 ? 650 : 420;
      outputHigh = target ? 1550 : count >= 15 ? 1150 : 750;
      mayExpand = target > 0;
    } else {
      // Lightweight estimate from sidebar summary ({ prompts }) before full prompt text is loaded.
      const count = Math.min(60, Math.max(1, Number(p.prompts) || 1));
      input = approxTokens(3200 + Math.min(36000, count * 360));
      outputLow = count >= 15 ? 650 : 420;
      outputHigh = count >= 15 ? 1150 : 750;
      mayExpand = true;
    }
    projectIn += input;
    projectOutLow += outputLow;
    projectOutHigh += outputHigh;
    if (mayExpand) {
      expandCalls++;
      // A revision sends the evidence again, followed by the first draft and revision instructions.
      expandIn += input + outputHigh + 150;
      expandOut += outputHigh;
    }
  }

  const overviewIn = overview ? 1800 + projectOutLow : 0;
  const overviewInHigh = overview ? 1800 + projectOutHigh : 0;
  const overviewOutLow = overview ? 280 : 0;
  const overviewOutHigh = overview ? 480 : 0;

  const pmw = modelWeight(provider, projectModel);
  const omw = modelWeight(provider, overviewModel);
  const pem = effortMultiplier(projectEffort);
  const oem = effortMultiplier(overviewEffort);

  const peuLow = weightedUnits({ input: projectIn, output: projectOutLow, modelWeight: pmw, effortMultiplier: pem })
    + weightedUnits({ input: overviewIn, output: overviewOutLow, modelWeight: omw, effortMultiplier: oem });
  const peuHigh = weightedUnits({ input: projectIn + expandIn, output: projectOutHigh + expandOut, modelWeight: pmw, effortMultiplier: pem })
    + weightedUnits({ input: overviewInHigh, output: overviewOutHigh, modelWeight: omw, effortMultiplier: oem });

  const requests = list.length + Number(overview);
  return {
    requests,
    ...(expandCalls ? { requestsMax: requests + expandCalls } : {}),
    tokensIn: projectIn + overviewIn,
    tokensInHigh: projectIn + expandIn + overviewInHigh,
    tokensOutLow: projectOutLow + overviewOutLow,
    tokensOutHigh: projectOutHigh + expandOut + overviewOutHigh,
    peuLow: Math.round(peuLow),
    peuHigh: Math.round(peuHigh)
  };
}

function estimateDeepWorkload(planItems, { provider = 'claude', projectModel = 'haiku', overviewModel = 'sonnet', projectEffort = 'medium', overviewEffort = 'high', finalizer, overviewProjects } = {}) {
  const items = Array.isArray(planItems) ? planItems : [];
  const live = items.filter((item) => !item.reused);
  const batches = plannedRequests(items);
  const needsFinalizer = finalizer ?? (items.length > 0);
  const requests = batches.review + Number(needsFinalizer);
  if (!requests) return { requests: 0, tokensIn: 0, tokensOutLow: 0, tokensOutHigh: 0, peuLow: 0, peuHigh: 0 };

  const reviewIn = live.reduce((sum, item) => sum + (item.tokens || 0), 0) + batches.review * 400;
  const reviewInHigh = reviewIn + (batches.limit - batches.review) * 600;
  const reviewOutLow = batches.review * 450;
  const reviewOutHigh = batches.limit * 900;
  const overviewIn = needsFinalizer ? 2200 + (overviewProjects ?? items.length) * 650 : 0;
  const overviewOutLow = needsFinalizer ? 350 : 0;
  const overviewOutHigh = needsFinalizer ? 650 : 0;

  const pmw = modelWeight(provider, projectModel);
  const omw = modelWeight(provider, overviewModel);
  const pem = effortMultiplier(projectEffort);
  const oem = effortMultiplier(overviewEffort);

  const peuLow = weightedUnits({ input: reviewIn, output: reviewOutLow, modelWeight: pmw, effortMultiplier: pem })
    + weightedUnits({ input: overviewIn, output: overviewOutLow, modelWeight: omw, effortMultiplier: oem });
  const peuHigh = weightedUnits({ input: reviewInHigh, output: reviewOutHigh, modelWeight: pmw, effortMultiplier: pem })
    + weightedUnits({ input: overviewIn, output: overviewOutHigh, modelWeight: omw, effortMultiplier: oem });

  return {
    requests,
    ...(batches.limit > batches.review ? { requestsMax: batches.limit + Number(needsFinalizer) } : {}),
    tokensIn: reviewIn + overviewIn,
    tokensInHigh: reviewInHigh + overviewIn,
    tokensOutLow: reviewOutLow + overviewOutLow,
    tokensOutHigh: reviewOutHigh + overviewOutHigh,
    peuLow: Math.round(peuLow),
    peuHigh: Math.round(peuHigh)
  };
}

function formatPctRange(pair) {
  if (!pair) return '';
  const [lo, hi] = pair;
  if (hi < 0.1) return '<0.1%';
  const step = hi < 10 ? 10 : 1;
  const a = Math.floor(lo * step) / step;
  const b = Math.ceil(hi * step) / step;
  if (a === 0) return `up to ~${b}%`;
  return a === b ? `~${a}%` : `~${a}–${b}%`;
}

function kfmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function pctBounds(workload, stats) {
  if (!(stats?.p25 > 0 && stats.p75 > 0)) return null;
  // Local transcripts cover only part of shared account usage. Allow for forecast
  // error and snapshot granularity, especially when few windows were observed.
  const uncertainty = stats.count >= 4 ? 1.25 : 1.5;
  return [workload.peuLow / (stats.p75 * uncertainty), workload.peuHigh * uncertainty / stats.p25];
}

const STANDARD_WINDOWS = [
  { id: 'fiveHour', label: '5-hour' },
  { id: 'sevenDay', label: 'Weekly' }
];
const MAX_PROJECTION_AGE_MS = 30 * 60 * 1000;

function freshQuotaReading(window, now = Date.now()) {
  return Number.isFinite(window?.seenAt) && window.seenAt <= now && now - window.seenAt < MAX_PROJECTION_AGE_MS;
}

function activeQuotaWindows(liveQuota, now = Date.now()) {
  const active = (win) => {
    const reset = quotaResetSeconds(win?.resetsAt);
    return Number.isFinite(win?.pct) && win.pct >= 0 && (!reset || reset * 1000 > now);
  };
  const standard = STANDARD_WINDOWS.map(({ id, label }) => ({ ...liveQuota?.[id], id, label }));
  const extra = (Array.isArray(liveQuota?.windows) ? liveQuota.windows : [])
    .map((win, i) => ({ ...win, id: `window-${i}`, label: win?.label || 'Usage window' }));
  return [...standard, ...extra].filter(active);
}

function estimateSubscriptionImpact({ provider, providerLabel, planLabel = '', workload, calibration, liveQuota, alternatives = [], now = Date.now() }) {
  const wl = workload || { requests: 0, tokensIn: 0, tokensOutLow: 0, tokensOutHigh: 0, peuLow: 0, peuHigh: 0 };
  const tokensLow = wl.tokensIn + wl.tokensOutLow;
  const tokensHigh = (wl.tokensInHigh ?? wl.tokensIn) + wl.tokensOutHigh;
  const requestsMax = wl.requestsMax ?? wl.requests;
  const allCurrent = activeQuotaWindows(liveQuota, now);
  if (!wl.requests) {
    return {
      provider,
      providerLabel,
      planLabel,
      requests: 0,
      tokens: 0,
      windows: [],
      confidence: 'tokens-only',
      pct5h: null,
      pct7d: null,
      current5h: null,
      projected5h: null,
      current7d: null,
      projected7d: null,
      tight: false,
      suggestedAlternative: null,
      summaryLine: '0 model requests',
      detailLines: []
    };
  }

  const standard = STANDARD_WINDOWS.map(({ id, label }) => {
    const snapshot = allCurrent.find((win) => win.id === id);
    const pct = pctBounds(wl, calibration?.[id]);
    const current = snapshot?.pct ?? null;
    const projected = freshQuotaReading(snapshot, now) && pct ? pct.map((delta) => Math.min(100, current + delta)) : null;
    return { id, label, pct, current, projected, seenAt: snapshot?.seenAt };
  });
  const [five, weekly] = standard;
  const windows = [
    ...standard.filter((win) => win.pct || win.current != null),
    ...allCurrent.filter((win) => win.id.startsWith('window-')).map(({ id, label, pct, seenAt }) => ({ id, label, current: pct, pct: null, projected: null, seenAt }))
  ];
  const tight = windows.some((win) => (win.projected?.[1] ?? win.current) >= 85);

  let suggestedAlternative = null;
  if (tight) {
    const better = alternatives
      .filter((a) => a.id !== provider && a.connected && Number.isFinite(a.maxPct) && a.maxPct < 70)
      .sort((a, b) => a.maxPct - b.maxPct)[0];
    suggestedAlternative = better
      ? { id: better.id, label: better.label, planLabel: better.planLabel, maxPct: better.maxPct }
      : { id: 'local', label: 'Local model', planLabel: 'on this computer', maxPct: 0 };
  }

  const hasEstimate = Boolean(five.pct || weekly.pct);
  const confidence = hasEstimate ? 'calibrated' : 'tokens-only';
  const planTag = planLabel ? `${providerLabel} ${planLabel}` : providerLabel;
  const requests = requestsMax === wl.requests ? `${wl.requests}` : `${wl.requests}–${requestsMax}`;
  const tokens = kfmt(tokensLow) === kfmt(tokensHigh) ? kfmt(tokensLow) : `${kfmt(tokensLow)}–${kfmt(tokensHigh)}`;
  const workloadLine = `~${tokens} report tokens · ${requests} ${requestsMax === 1 ? 'request' : 'requests'}`;
  const parts = windows.map(({ label, pct, current, projected }) => {
    if (!pct) return `${label} last seen ${Math.round(current)}% used`;
    const projection = projected ? ` (${Math.round(current)}% → ${formatPctRange(projected)} used)`
      : current != null ? ` (last seen ${Math.round(current)}% used)` : '';
    return `${formatPctRange(pct)} of ${label.toLowerCase()} limit${projection}`;
  });
  const summaryLine = hasEstimate ? `${parts.join(' · ')} · rough local estimate`
    : `${workloadLine} · quota impact unavailable`;
  const detailLines = [...parts, workloadLine, hasEstimate
    ? `Approximate estimate from local usage history for ${planTag}. Account activity and model usage can vary.`
    : `There is insufficient quota history for an impact percentage for ${planTag}.`];

  if (tight && suggestedAlternative) {
    detailLines.push(`Your ${planTag} window may be near its limit. ${suggestedAlternative.label} is also available.`);
  }

  return {
    provider,
    providerLabel,
    planLabel,
    requests: wl.requests,
    requestsMax,
    tokens: Math.round((tokensLow + tokensHigh) / 2),
    windows,
    confidence,
    pct5h: five.pct,
    pct7d: weekly.pct,
    current5h: five.current,
    projected5h: five.projected,
    current7d: weekly.current,
    projected7d: weekly.projected,
    tight,
    suggestedAlternative,
    summaryLine,
    detailLines
  };
}

module.exports = {
  approxTokens,
  estimateQuickWorkload,
  estimateDeepWorkload,
  estimateSubscriptionImpact,
  activeQuotaWindows,
  freshQuotaReading,
  formatPctRange
};
