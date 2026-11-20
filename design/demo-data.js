'use strict';

// Invented data for the screenshots in the README and the Marketplace page. No real project, session,
// person or prompt appears here, so the pictures can be published. A seeded generator keeps them stable.
const { dayList, dayKey } = require('../src/scan');

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = [
  { name: 'web-storefront', total: 182e6, prompts: 48, share: 0.3 },
  { name: 'payments-api', total: 121e6, prompts: 36, share: 0.22 },
  { name: 'mobile-app', total: 71e6, prompts: 22, share: 0.18 },
  { name: 'docs-site', total: 31e6, prompts: 12, share: 0.1 },
  { name: 'data-pipeline', total: 22e6, prompts: 9, share: 0.08 },
  { name: 'design-system', total: 9e6, prompts: 6, share: 0.05 }
];

const TOOLS = [['Bash', 0.34, 0.03], ['Read', 0.26, 0.01], ['Edit', 0.17, 0.05], ['Grep', 0.1, 0.01], ['Write', 0.06, 0.02], ['Agent', 0.04, 0.0], ['WebSearch', 0.03, 0.0]];
const MODELS = [['sonnet-5-5', 0.62], ['opus-5-5', 0.28], ['haiku-5-5', 0.1]];
const HOURS = [0, 0, 0, 0, 0, 0, 1, 3, 8, 14, 18, 15, 9, 11, 16, 17, 13, 8, 4, 3, 2, 1, 0, 0];

function projectsAndDays(now) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 30);
  const days = dayList(from, to);
  const rand = rng(7);
  const weights = days.map((k, i) => {
    const d = new Date(k + 'T12:00:00');
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return (weekend ? 0.25 : 1) * (0.4 + rand() * 1.2) * (i > 24 ? 1.3 : 1);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const projects = PROJECTS.map((p, pi) => {
    const r = rng(100 + pi);
    const daily = {};
    const dailyTurns = {};
    days.forEach((k, i) => {
      const v = Math.round(p.total * (weights[i] / sum) * (0.5 + r()));
      if (v > 0 && (r() > 0.2 || i > 22)) { daily[k] = v; dailyTurns[k] = Math.max(1, Math.round(v / 90000)); }
    });
    const totalTokens = Object.values(daily).reduce((a, b) => a + b, 0);
    const cacheRead = Math.round(totalTokens * 0.935);
    const cacheCreate = Math.round(totalTokens * 0.052);
    const output = Math.round(totalTokens * 0.011);
    const input = totalTokens - cacheRead - cacheCreate - output;
    const turns = Object.values(dailyTurns).reduce((a, b) => a + b, 0);
    const tools = {};
    TOOLS.forEach(([n, share, fail]) => { const calls = Math.round(turns * 1.4 * share); tools[n] = { calls, fails: Math.round(calls * fail) }; });
    const models = {};
    MODELS.forEach(([n, share]) => { models[n] = Math.round(totalTokens * share); });
    return {
      name: p.name,
      totalTokens,
      tokens: { input, output, cacheRead, cacheCreate, turns },
      sessions: Math.max(2, Math.round(p.prompts / 4)),
      promptCount: p.prompts,
      daily,
      dailyTurns,
      tools,
      models,
      hours: HOURS.map((h) => Math.round(h * p.prompts / 20)),
      cache: { cold: Math.round(turns / 300), rebuilt: Math.round(totalTokens * 0.004), afterIdle: Math.round(turns / 330), starts: Math.round(p.prompts / 5) },
      prompts: []
    };
  });
  return { projects, days };
}

const SESSIONS = [
  ['Fix checkout total rounding', 'web-storefront', 'Active', 'now', true, 'busy'],
  ['Add retry to payments webhook', 'payments-api', 'Today', '2h', false, ''],
  ['Dark mode for the settings screen', 'mobile-app', 'Today', '3h', false, ''],
  ['Write the migration guide', 'docs-site', 'Today', '5h', false, ''],
  ['Speed up the nightly import', 'data-pipeline', 'Yesterday', '26h', false, ''],
  ['Token naming cleanup', 'design-system', 'Yesterday', '28h', false, ''],
  ['Why do refunds double count?', 'payments-api', 'Yesterday', '31h', false, ''],
  ['Product page image gallery', 'web-storefront', 'Earlier', '3d', false, ''],
  ['Push notification permissions', 'mobile-app', 'Earlier', '4d', false, ''],
  ['Search results ranking', 'web-storefront', 'Earlier', '5d', false, ''],
  ['Add a changelog page', 'docs-site', 'Earlier', '6d', false, '']
];

function sessions() {
  return SESSIONS.map(([title, project, group, age, active, status], i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title, cwd: `C:/work/${project}`, project, active, status, age, group
  }));
}

function local() {
  const m = (id, quantization, sizeBytes, state, maxOnGpuLabel) => ({ id, quantization, sizeBytes, state, maxContextLabel: '262k', maxOnGpuLabel, estimated: true });
  return {
    engine: 'lmstudio', model: '', enabled: false,
    gpu: { name: 'NVIDIA GeForce RTX 4080', totalMiB: 16376, usedMiB: 4900, freeMiB: 11476 },
    engines: [{ engine: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', running: true }, { engine: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', running: false }],
    models: [
      m('qwen/qwen3-4b-2507', 'Q4_K_M', 2.5e9, 'loaded', '90k'),
      m('qwen/qwen3.5-9b', 'Q8_0', 10.4e9, 'idle', '41k'),
      m('google/gemma-4-12b-qat', 'Q4_0', 7.2e9, 'idle', '10k'),
      m('meta/llama-3.3-70b', 'Q4_K_M', 42e9, 'idle', 'too big')
    ]
  };
}

const { parseAdvice } = require('../src/advice');
const ex = (task, a, b, basis) => ({ task, withoutAI: a, withAI: b, basis });
const REPORTS = {
  'web-storefront': {
    summary: 'Checkout and product pages: fixed rounding in order totals, rebuilt the image gallery and tuned search ranking.',
    usedFor: ['bug fixes', 'features'],
    examples: [ex('Find and fix the rounding bug in order totals', '~3 h', '~25 min', 'Traced through three services.'), ex('Rebuild the product image gallery', '~1 day', '~2 h', 'New component with lazy loading.'), ex('Tune search result ranking', '~4 h', '~50 min', 'Compared old and new orderings.')],
    didntWork: ['The first gallery attempt broke on small screens and was redone.'],
    nextMonth: ['Add tests around totals', 'Try Claude for the accessibility pass'],
    promptNote: 'Clear goals, with the failing order number and expected total given up front.'
  },
  'payments-api': {
    summary: 'Hardened the webhook handler with retries and explained a refund double count that turned out to be a reporting bug.',
    usedFor: ['bug fixes', 'code review'],
    examples: [ex('Add retries with backoff to the webhook handler', '~5 h', '~1 h', 'Wrote the handler and its tests.'), ex('Explain why refunds were counted twice', '~2 h', '~20 min', 'Read the ledger code.'), ex('Review the idempotency key change', '~90 min', '~15 min', 'Checked edge cases.')],
    didntWork: [],
    nextMonth: ['Load test the retry path', 'Document the webhook contract'],
    promptNote: 'Short follow-ups; the same refund question was asked three times with new wording.'
  },
  'mobile-app': {
    summary: 'Dark mode for settings and a fix for the notification permission prompt on first launch.',
    usedFor: ['features'],
    examples: [ex('Dark mode for the settings screen', '~1 day', '~3 h', 'Tokens plus screen audit.'), ex('Fix the permission prompt timing', '~2 h', '~30 min', 'Moved the request after onboarding.'), ex('Write release notes', '~45 min', '~8 min', 'From the merged pull requests.')],
    didntWork: ['Snapshot tests needed manual updates.'],
    nextMonth: ['Dark mode for the remaining screens', 'Automate release notes']
  },
  'docs-site': {
    summary: 'Wrote the migration guide and added a changelog page.',
    usedFor: ['documentation'],
    examples: [ex('Draft the migration guide', '~1 day', '~2 h', 'From the code diff.'), ex('Add a changelog page', '~2 h', '~25 min', 'Generated from tags.'), ex('Fix broken links', '~1 h', '~10 min', 'Link checker output.')],
    didntWork: [],
    nextMonth: ['Add a search box', 'Review the guide with users']
  },
  'data-pipeline': {
    summary: 'Cut the nightly import time by batching writes and fixed two failing jobs.',
    usedFor: ['bug fixes', 'research'],
    examples: [ex('Batch the nightly import writes', '~1 day', '~3 h', 'Profiled first.'), ex('Fix the failing schema job', '~2 h', '~20 min', 'Found a renamed column.'), ex('Compare queue options', '~3 h', '~40 min', 'Summarised trade-offs.')],
    didntWork: ['The first batching size was too large for the database.'],
    nextMonth: ['Add an alert for slow imports']
  },
  'design-system': {
    summary: 'Renamed design tokens and updated the components that used the old names.',
    usedFor: ['features'],
    examples: [ex('Rename tokens across the library', '~6 h', '~1 h', 'Codemod plus review.'), ex('Update component docs', '~2 h', '~30 min', 'Regenerated examples.'), ex('Check contrast of new colours', '~1 h', '~10 min', 'Scripted the check.')],
    didntWork: [],
    nextMonth: ['Publish the token package']
  }
};

const OVERVIEW = {
  summary: 'Most effort went to the storefront and payments API: checkout fixes, webhook retries and a faster nightly import.',
  goal: 'Make checkout and payments reliable while moving the mobile app and docs forward.',
  achievement: 'Shipped the rounding fix, webhook retries, dark mode and the migration guide, saving about 50 h (estimate).',
  advice: parseAdvice({
    strength: { text: 'You state the goal and the failing case first, so the first answer is usually usable.', evidence: 'web-storefront: the order number and expected total came before the request.' },
    watch: { text: 'Some requests are very short and get repeated with new wording until the answer fits.', evidence: 'payments-api: the same refund question was asked three times.', topic: 'context' },
    habit: { text: 'Add one line on what you already tried and what the answer is for before the question.', topic: 'context' }
  }, { prompts: 133 })
};

// A week of invented plan readings for the Metrics trend: weekday work blocks, each inside its own five-hour
// window, and a weekly window that resets 3 d 11 h from `t`. The last reading matches the live gauges in
// build-preview.js (16% and 28%), so the burn rate and the trend agree with them.
function planHistory(t) {
  const H = 3600e3, STEP = 5 * 60e3, rand = rng(11);
  const weekReset = Math.floor(t / 1000) + 300000;
  const weekStart = weekReset - 168 * 3600;
  // [hours ago the block began, hours worked, five-hour peak in %]
  const blocks = [[156, 3.5, 48], [147, 3.5, 36], [132, 3.5, 62], [123, 3.5, 41], [60, 3.5, 55], [51, 3, 38], [36, 3.5, 66], [27, 3, 44], [12, 3.5, 58], [3, 3, 16]];
  const out = [];
  for (const [ago, hours, peak] of blocks) {
    const start = t - ago * H;
    const end = Math.min(start + hours * H, t - 90000);
    const sr = Math.floor((start + 5 * H) / 1000);
    let s = 0, ts = start;
    for (; ts < end; ts += STEP) {
      const p = (ts - start) / (end - start);
      s = Math.max(s, Math.round(peak * (1 - Math.pow(1 - p, 1.7)) + (rand() - 0.5) * 2));
      out.push({ t: Math.round(ts), s: Math.min(peak, s), sr });
    }
    out.push({ t: Math.round(end), s: peak, sr });
  }
  // The weekly gauge only grows inside its window: sum the five-hour gains, then scale each window to its end value.
  const windows = new Map();
  let prevS = 0, prevWindow = null, acc = 0;
  for (const pt of out) {
    pt.wr = pt.t / 1000 < weekStart ? weekStart : weekReset;
    if (pt.wr !== prevWindow) { prevWindow = pt.wr; acc = 0; prevS = 0; }
    acc += pt.s >= prevS ? pt.s - prevS : pt.s;
    prevS = pt.s;
    pt.raw = acc;
    windows.set(pt.wr, Math.max(windows.get(pt.wr) || 0, acc));
  }
  const ends = new Map([[weekStart, { base: 22, end: 58 }], [weekReset, { base: 0, end: 28 }]]);
  for (const pt of out) {
    const { base, end } = ends.get(pt.wr);
    pt.w = Math.round(base + pt.raw * (end - base) / windows.get(pt.wr));
    delete pt.raw;
  }
  return out;
}

function demo(now = new Date()) {
  const { projects, days } = projectsAndDays(now);
  return { projects, days, sessions: sessions(), local: local(), reports: REPORTS, overview: OVERVIEW, user: 'alex.m', dayKey };
}

module.exports = { demo, planHistory };
