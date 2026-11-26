'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const win = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'template', 'panel', 'metrics.js'), 'utf8'))(win);
const M = win.ClaudeReportMetrics;

const days = [];
for (let i = 1; i <= 30; i++) days.push('2026-11-' + String(i).padStart(2, '0'));
function proj(name, k) {
  const hours = new Array(24).fill(0); hours[10] = 5 * k;
  return {
    name, tokens: 1000 * k, sessions: 2, prompts: 9,
    t: { input: 100 * k, output: 777 * k, cacheRead: 5000 * k, cacheCreate: 300 * k, turns: 40 * k },
    daily: { '2026-11-02': 1234 * k }, dailyTurns: { '2026-11-02': 3 * k },
    tools: { Bash: { calls: 50 * k, fails: 10 * k }, mcp__srv__search: { calls: 7 * k, fails: 0 } },
    models: { 'claude-opus-x': 4000 * k }, hours,
    cache: { cold: 2 * k, rebuilt: 900 * k, afterIdle: k, starts: 3 },
  };
}
const hist = [];
for (let i = 0; i < 10; i++) hist.push({ t: 1e12 + i * 600000, s: 10 + i, w: 20 + i / 2 });
const D = { openProject: 'alpha', days, windowDays: 30, live: null, history: hist, now: hist.at(-1).t, projects: [proj('alpha', 1), proj('beta', 2)] };

test('renders every section label and the footnote', () => {
  const html = M.render(D, { openOnly: false });
  ['Plan usage', 'Burn rate', 'Trend', '5-hour limit', 'Tokens', 'Only the open project', 'Cache efficiency', 'Tools',
    'When you work', 'By model', 'By project', 'Counted locally'].forEach((s) =>
    assert.ok(html.includes(s), s));
  assert.ok(html.includes('busiest at 10h'));
  assert.ok(html.includes('var(--c'));
  assert.ok(html.includes('>search<') && !html.includes('mcp__'));
});

test('renderPlan draws the plan section alone, the same as at the top of the full page', () => {
  const plan = M.renderPlan({ live: null, history: hist, now: hist.at(-1).t });
  ['Plan usage', 'Burn rate', 'Trend', '5-hour limit'].forEach((s) => assert.ok(plan.includes(s), s));
  assert.ok(!plan.includes('Tokens'));
  assert.ok(M.render(D, { openOnly: false }).startsWith(plan));
  assert.ok(!M.render({ ...D, showUsageTrend: false }).includes('Plan usage'));
});

test('openOnly drops the other project', () => {
  const all = M.render(D, { openOnly: false });
  const one = M.render(D, { openOnly: true });
  assert.ok(all.includes('>beta<'));
  assert.ok(!one.includes('>beta<'));
  assert.ok(one.includes('>alpha<'));
  assert.ok(all.includes('>18.5k<') && !one.includes('>18.5k<'));
  assert.ok(one.includes('>ON<'));
  const none = M.render(Object.assign({}, D, { openProject: null }), { openOnly: true });
  assert.ok(none.includes('>beta<') && none.includes('data-off') && none.includes('>OFF<'));
  assert.match(one, /1 other project hidden/);
});

test('plan usage shows the current percentage and reset countdown without extrapolating from seconds of data', () => {
  const hour = 3600000, now = 1e12, reset = (now + 2 * hour) / 1000;
  const live = { fiveHour: { pct: 1, resetsAt: reset, seenAt: now } };
  const short = [{ t: now - 5315, s: 0, sr: reset }];
  const html = M.render({ now, live, history: short });
  assert.match(html, />1%<.*Resets in 2h 0m · /);
  assert.match(html, /Available after a short period of activity/);
  assert.doesNotMatch(html, /%\/h|Full in/);
  const enough = [{ t: now - hour / 2, s: 0, sSource: 'control' }, ...short];
  const forecast = M.render({ now, live, history: enough });
  assert.match(forecast, /\+2\.0%\/h/);
  assert.match(forecast, /Resets before full/);
  assert.match(forecast, /Includes Claude Control/);
});

test('gauges and bar rows stack: label and figure on one line, the bar below, details last', () => {
  const now = new Date(2026, 10, 24, 9, 0).getTime();
  const live = {
    fiveHour: { pct: 68, resetsAt: (now + 90 * 60000) / 1000, seenAt: now },
    sevenDay: { pct: 12, resetsAt: (now + 3 * 86400e3) / 1000, seenAt: now },
  };
  const html = M.render({ ...D, now, live, history: [] });
  assert.match(html, /<div class="plan-head"><span>5-hour session<\/span><strong[^>]*>68%<\/strong><\/div><span class="plan-track"/);
  assert.match(html, /Resets in 1h 30m · \d/, 'a reset later today shows only the time');
  const weekday = new Date(now + 3 * 86400e3).toLocaleDateString([], { weekday: 'short' });
  assert.ok(html.includes('Resets in 3d 0h · ' + weekday + ' '), 'a later reset names the day, kept on one line with its time');
  assert.match(html, /<span class="hlbl" title="Bash">Bash<\/span><span class="hval">\d+<\/span><span class="herr bad">20% failed<\/span><\/div><span class="hbar">/);
  assert.match(M.render({ ...D, now, live: {}, history: [] }), /<span>Weekly<\/span><\/div><div class="plan-sub">Waiting for reading/);
});

test('project names are escaped', () => {
  const html = M.render({ projects: [proj('<script>alert(1)</script>', 1)] }, {});
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('does not throw on empty or sparse data', () => {
  assert.strictEqual(typeof M.render({}, {}), 'string');
  assert.strictEqual(typeof M.render(undefined, undefined), 'string');
  assert.strictEqual(typeof M.render({ days, projects: [{ name: 'x' }, {}, null] }, { openOnly: true }), 'string');
});

test('plan trends use wall-clock ranges and break at provider resets', () => {
  const hour = 3600000, now = 1e12;
  const history = [
    { t: now - 30 * hour, s: 99, w: 23 },
    { t: now - 5 * hour, s: 61, sr: (now - 4 * hour) / 1000 },
    { t: now - 3 * hour, s: 14, sr: (now + hour) / 1000 }
  ];
  const html = M.render({ now, history });
  assert.match(html, /5-hour limit · last 24 hours/);
  assert.match(html, /Weekly limit · last 7 days/);
  assert.match(html, /class="spark-reset"/);
  assert.match(html, /d="M197\.2 17\.3M217\.5 33\.2"/);
  assert.match(html, />14%<.*>23%<.*7 days ago/);
  assert.doesNotMatch(M.render({ now, history, showUsageTrend: false }), /Claude plan/);
});

test('bind reports the toggled value', () => {
  const clicks = [];
  const root = { addEventListener: (t, f) => { if (t === 'click') clicks.push(f); } };
  let got; M.bind(root, { openOnly: false }, (s) => { got = s; });
  clicks[0]({ target: { closest: () => ({ disabled: false }) } });
  assert.deepStrictEqual(got, { openOnly: true });
});

test('the item lists cap and fold the rest behind a tiny arrow in a scrollable body', () => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push(proj('big' + i, i + 1));
  const html = M.render({ ...D, projects: many, days: [] }, { openOnly: false });
  assert.match(html, /class="hmore-t"/);
  assert.ok(html.includes('hmore-body'));
  assert.ok((html.match(/class="hrow"/g) || []).length >= 5);
});

test('the more arrow toggles the section class and the arrow direction', () => {
  const toggles = [];
  const clicks = [];
  const root = { addEventListener: (t, f) => { if (t === 'click') clicks.push(f); } };
  M.bind(root, { openOnly: false });
  const arrow = { textContent: '▾' }, label = { textContent: '51 more' };
  const section = { classList: { toggle: (c) => { toggles.push(c); }, contains: () => false } };
  const button = {
    closest: (sel) => (sel === '[data-hmore]' ? button : sel === '.hrows' ? section : null),
    querySelector: (sel) => (sel === '.hmore-arrow' ? arrow : sel === '.hmore-n' ? label : null),
    getAttribute: (name) => (name === 'data-hmore' ? '51 more' : null),
  };
  clicks[clicks.length - 1]({ target: button });
  assert.deepStrictEqual(toggles, ['hrows-expanded']);
  assert.strictEqual(arrow.textContent, '▾');
  assert.strictEqual(label.textContent, '51 more');
  section.classList.contains = () => true;
  clicks[clicks.length - 1]({ target: button });
  assert.strictEqual(arrow.textContent, '▴');
  assert.strictEqual(label.textContent, 'Show less');
});

test('each folded list sits in its own .hrows wrapper with the arrow and the body inside it', () => {
  const html = M.render({ ...D, projects: Array.from({ length: 8 }, (_, i) => proj('p' + i, i + 1)), days: [] }, {});
  const folded = (html.match(/<div class="hrows" data-list="m-[a-z]+"><div class="hrows-list">(?:(?!<div class="scope)[\s\S])*?class="hmore-body"(?:(?!<div class="scope)[\s\S])*?data-hmore/g) || []);
  assert.ok(folded.length >= 1, 'the arrow and its body share one .hrows wrapper');
  assert.doesNotMatch(html, /class="scope hrows"/);
  const open = M.render({ ...D, projects: Array.from({ length: 8 }, (_, i) => proj('p' + i, i + 1)), days: [] }, { more: { 'm-projects': true } });
  assert.match(open, /<div class="hrows hrows-expanded" data-list="m-projects">/, 'a remembered open list is drawn open');
  assert.match(open, /data-key="m-projects" aria-expanded="true"><span class="hmore-arrow">▴<\/span> <span class="hmore-n">Show less/);
  assert.match(html, /<div class="hmore-body">(?:(?!hmore-t)[\s\S])*?title="p0"[\s\S]*?<span class="hmore-n">3 more<\/span>/, 'By project keeps every project, folding past five');
});

test('the trend line is colored by height, and the latest dot is valid SVG', () => {
  const html = M.renderPlan({ history: hist, now: hist.at(-1).t });
  assert.match(html, /<linearGradient id="spark-g-s" gradientUnits="userSpaceOnUse" x1="0" y1="38\.0" x2="0" y2="4\.0">/);
  assert.match(html, /<circle cx="[\d.]+" cy="[\d.]+" r="2\.3"/);
});

test('an early refill is marked like a reset, and both windows refilling adds the refresh note', () => {
  const hour = 3600000, now = 1e12, later = (now + 3 * hour) / 1000;
  const history = [
    { t: now - 3 * hour, s: 100, sr: later, w: 60, wr: later + 86400 },
    { t: now - 2 * hour, s: 0, sr: later, w: 10, wr: later + 86400 },
    { t: now - hour, s: 90, sr: later, w: 14, wr: later + 86400 },
  ];
  const html = M.renderPlan({ now, history });
  assert.strictEqual((html.match(/class="spark-reset spark-refill"/g) || []).length, 2);
  assert.match(html, /Refilled without a scheduled reset/);
  assert.match(html, /the weekly was probably refreshed/);
  const onlySession = history.map((p) => ({ ...p, w: 20 }));
  assert.doesNotMatch(M.renderPlan({ now, history: onlySession }), /probably refreshed/);
  const scheduled = [{ t: now - 3 * hour, s: 95, sr: (now - 2.5 * hour) / 1000 }, { t: now - 2 * hour, s: 3, sr: later }];
  assert.doesNotMatch(M.renderPlan({ now, history: scheduled }), /spark-refill/, 'a drop after the scheduled reset is a normal reset');
});

test('a source with turns but no tokens shows turns, not zero token views', () => {
  const p = { ...proj('cursor', 1), t: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 12 }, daily: {}, models: {}, cache: {} };
  const html = M.render({ ...D, projects: [p] }, { openOnly: false });
  assert.ok(!html.includes('Cache efficiency') && !html.includes('generated') && !html.includes('By model'));
  assert.ok(html.includes('· turns') && html.includes('By project') && html.includes('>12<'));
});

test('cache ratio ignores projects without cache data', () => {
  const noCache = { ...proj('cur', 1), t: { input: 100000, output: 0, cacheRead: 0, cacheCreate: 0, turns: 5 } };
  const withCache = { ...proj('cc', 1), t: { input: 0, output: 0, cacheRead: 900, cacheCreate: 100, turns: 5 } };
  assert.ok(M.render({ ...D, projects: [noCache, withCache] }, {}).includes('90%'));
});

test('the open-project switch works from the keyboard', () => {
  const l = {}; let got = null, prevented = false;
  M.bind({ addEventListener: (t, f) => { l[t] = f; } }, { openOnly: false }, (s) => { got = s; });
  const target = { closest: () => ({ getAttribute: () => null }) };
  l.keydown({ key: ' ', target, preventDefault: () => { prevented = true; } });
  assert.deepStrictEqual(got, { openOnly: true });
  assert.ok(prevented);
});
