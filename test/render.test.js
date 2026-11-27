'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { buildData, renderHtml, renderDocument, hours } = require('../src/render');
const { toDocument, toFragment } = require('../src/report-document');
const { wrapForWebview } = require('../src/webview');
const { localDay, readDateRange, reportBounds } = require('../src/report-window');

const tokens = { input: 10, output: 5, cacheRead: 80, cacheCreate: 10, turns: 3 };
const scan = { projects: [{ name: 'a</script>b', totalTokens: 105, sessions: 1, promptCount: 5, daily: { '03': 105 }, cache: { cold: 0, rebuilt: 0, afterIdle: 0, starts: 1 }, tokens }] };

// A small stand-in for the page: just the elements the report script looks up.
function mount(data, { hash = '', details = [] } = {}) {
  const [dataScript, script] = [...renderHtml(data).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const svg = { clientWidth: 380, parentNode: {}, setAttribute() {}, addEventListener() {} };
  const legend = { innerHTML: '', children: [], addEventListener() {} };
  const table = { innerHTML: '' };
  const picker = { value: '', addEventListener(_event, listener) { this.change = listener; } };
  const app = { innerHTML: '', addEventListener() {}, querySelectorAll: (selector) => selector === 'details' ? details : [] };
  const elements = { 'report-data': { textContent: dataScript }, 'chart-project': picker, chart: svg, legend, 'chart-table': table, app };
  const sandbox = { document: { getElementById: (id) => elements[id] }, window: { addEventListener() {} }, location: { hash } };
  runInNewContext(script, sandbox);
  return { app, svg, legend, table, picker, elements, sandbox, script };
}

const example = (overrides) => ({ task: 'Task', basis: 'Prompt 2026-11-05 09:12Z', withoutAI: '4 h', withAI: '1 h', a: 4, b: 1, ...overrides });
const report = (examples, extra) => ({ summary: 'Did the work.', usedFor: [], examples, didntWork: [], nextMonth: [], ...extra });

test('hours reads minutes, hours, days and ranges', () => {
  assert.strictEqual(hours('~45 min'), 0.75);
  assert.strictEqual(hours('~2-4 h'), 3);
  assert.strictEqual(hours('~1 day'), 8);
  assert.strictEqual(hours('soon'), null);
});

test('buildData limits the range to today and keeps the token breakdown', () => {
  const d = buildData({ month: '2026-11', scan, user: 'sam', now: new Date(2026, 10, 18) });
  assert.strictEqual(d.through, 18);
  assert.strictEqual(d.days.length, 18);
  assert.strictEqual(d.projects[0].report, undefined);
  assert.deepEqual(d.projects[0].tokenParts, { input: 10, output: 5, cacheRead: 80, cacheCreate: 10 });
});

test('custom dates are inclusive and may cross month boundaries', () => {
  const dateRange = { from: '2026-10-31', to: '2026-11-02' };
  const now = new Date(2026, 10, 18);
  const result = buildData({ month: '2026-11', scan, now, dateRange });
  assert.deepEqual(result.days, ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(result.dateRange, dateRange);
  assert.equal(reportBounds(result.month, dateRange, now).to.getDate(), 3);
  assert.equal(localDay('2026-11-31'), null);
  assert.equal(readDateRange({ from: dateRange.to, to: dateRange.from }), null);
});

test('a project name cannot close the data script', () => {
  const html = renderHtml(buildData({ month: '2026-11', scan, now: new Date(2026, 10, 18) }));
  const data = html.split('id="report-data">')[1].split('</script>')[0];
  assert.ok(!data.includes('</script'));
  assert.strictEqual(JSON.parse(data).projects[0].name, 'a</script>b');
});

test('the webview wrapper puts a nonce on executable scripts only', () => {
  const out = wrapForWebview('<script type="application/json" id="x">{}</script><script>1</script>', 'N0NCE');
  assert.ok(out.includes('<script nonce="N0NCE">1</script>'));
  assert.ok(out.includes('<script type="application/json" id="x">'));
  assert.ok(out.includes("script-src 'nonce-N0NCE'"));
});

test('saved and exported files are complete documents, and the editor panel still wraps one document', () => {
  const data = buildData({ month: '2026-11', scan, now: new Date(2026, 10, 18) });
  const doc = renderDocument(data);
  assert.match(doc, /^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport"/);
  assert.equal(toDocument(doc), doc);
  assert.equal(toFragment(doc), renderHtml(data));
  assert.equal(toFragment('<title>old</title>'), '<title>old</title>');
  const wrapped = wrapForWebview(doc, 'N');
  assert.equal(wrapped.match(/<!doctype/gi).length, 1);
  assert.equal(wrapped.match(/<html/gi).length, 1);
});

test('daily token chart groups small projects, scales to the stacked peak and refits to one project', () => {
  const days = ['2026-11-01', '2026-11-02'];
  const many = Array.from({ length: 10 }, (_, i) => ({ name: 'Proj ' + i, tokens: 1_000_000 - i, daily: { [days[0]]: 1_000_000 - i } }));
  const big = mount({ days, projects: many });
  assert.match(big.legend.innerHTML, /Other \(2 projects\)/);
  assert.doesNotMatch(big.legend.innerHTML, /Proj 9/);
  assert.match(big.table.innerHTML, /<th scope="col">Other \(2 projects\)<\/th>/);

  const data = {
    days,
    overviewStale: true,
    projects: [
      { name: 'Larger', tokens: 249_000_000, daily: { [days[0]]: 249_000_000 } },
      { name: 'Smaller', tokens: 13_020_000, daily: { [days[0]]: 13_000_000, [days[1]]: 20_000 }, report: report([
        example({ task: 'Checked slow jobs', detail: 'Compared two <benchmarks>', basis: 'Profile comparison', withoutAI: '2 h', withAI: '1 h', a: 2, b: 1 }),
        { task: 'Compared job timings', withAI: '10 min', b: 1 / 6, timeSource: 'reported' },
        example({ task: 'Documented animations', withoutAI: '~2 days', withAI: '~2 h', a: 16, b: 2, timeSource: 'estimated' })
      ], { usedFor: ['Measured <latency>'] }) },
      { name: 'Inactive', tokens: 0, daily: {} }
    ]
  };
  const page = mount(data);
  const { app, svg, legend, picker } = page;
  assert.match(app.innerHTML, /<option value="">All projects<\/option>/);
  assert.match(app.innerHTML, /Overview needs review after project changes/);
  assert.match(app.innerHTML, /<li>Measured &lt;latency&gt;<\/li>/);
  assert.match(app.innerHTML, /Compared two &lt;benchmarks&gt;/);
  assert.match(app.innerHTML, /Without AI · 2 h \(estimate\)/);
  assert.match(app.innerHTML, /Time spent · 10 min \(self-reported\)/);
  assert.match(app.innerHTML, /Without AI · ~2 days \(AI estimate\)/);
  assert.match(app.innerHTML, /saves 14 h/);
  assert.match(svg.innerHTML, />300M<\/text>/);
  assert.doesNotMatch(svg.innerHTML, />500M<\/text>/);
  assert.match(svg.innerHTML, /data-v="20000"/);

  picker.value = '1';
  picker.change();
  assert.match(svg.innerHTML, />15M<\/text>/);
  assert.match(legend.innerHTML, /Smaller/);
  assert.doesNotMatch(legend.innerHTML, /Larger/);

  picker.value = '2';
  picker.change();
  assert.match(svg.innerHTML, />No token activity<\/text>/);
  assert.match(page.table.innerHTML, /No token activity/);

  picker.value = '';
  picker.change();
  assert.match(svg.innerHTML, />300M<\/text>/);
  assert.match(legend.innerHTML, /Larger/);

  page.elements['report-data'].textContent = JSON.stringify({ ...data, days: [] });
  runInNewContext(page.script, page.sandbox);
  assert.match(svg.innerHTML, />No token activity<\/text>/);
  assert.doesNotMatch(svg.innerHTML, /NaN|Infinity/);
});

test('requests, recorded changes and verified outcomes are labelled and only recorded work counts as saved time', () => {
  const data = { days: ['2026-11-01'], overview: { summary: 'S', goal: 'G', achievement: 'A' }, projects: [{ name: 'Alpha', tokens: 10, prompts: 3, daily: { '2026-11-01': 10 }, report: report([
    example({ task: 'Asked for retries', status: 'requested' }),
    example({ task: 'Changed the cache', status: 'recorded', a: 3, b: 1 }),
    example({ task: 'Fixed the parser', status: 'verified', a: 2, b: 1 })
  ]) }] };
  const { app } = mount(data);
  assert.match(app.innerHTML, /chip requested">Requested</);
  assert.match(app.innerHTML, /chip recorded">Recorded</);
  assert.match(app.innerHTML, /chip verified">Verified ✓</);
  assert.match(app.innerHTML, /1 verified · 1 recorded · 1 requested only/);
  assert.match(app.innerHTML, /about 3 h across 2 examples, excluding requests with no result/);
  assert.doesNotMatch(app.innerHTML, /saves 3 h<\/b><\/span><\/div><\/article><article class="ex"><h5>Asked/);
});

test('older reports without status stay readable and only clear no-result wording is read as a request', () => {
  const data = { days: ['2026-11-01'], projects: [{ name: 'Old', tokens: 10, daily: { '2026-11-01': 10 }, report: report([
    example({ task: 'Usage audit', detail: 'No root cause or fix is recorded.', a: 3, b: 1 }),
    example({ task: 'Fresh feature', detail: 'Added a status bar.', a: 2, b: 1 })
  ]) }] };
  const { app } = mount(data);
  assert.match(app.innerHTML, /Requested \(inferred\)/);
  assert.match(app.innerHTML, /1 requested/);
  assert.match(mount({ days: [], projects: [{ name: 'N', tokens: 1, report: report([example({})]) }] }).app.innerHTML, /Outcome status was not recorded for this report/);
  assert.match(app.innerHTML, /about 1 h across 1 example/);
  const bare = mount({ projects: [{ name: 'x', tokens: 1 }] });
  assert.match(bare.app.innerHTML, /no report written/);
  assert.match(bare.app.innerHTML, /<b>1<\/b><span>project[ <]/);
  assert.doesNotMatch(bare.app.innerHTML, /1 projects/);
});

test('prompting findings show the checked excerpt and a UTC reference, and keep older reviews readable', () => {
  const references = [{ id: 'P2', at: '2026-11-19T03:39:24.117Z', session: 'S1', source: 'codex' }, { id: 'P5', at: '2026-11-19T05:21:00Z', session: 'S1', source: 'claude' }];
  const review = { summary: 'Clear goals.', strengths: ['P2: Names the check.'], opportunities: ['P5: Undefined term.'], prompts: 4, sessions: 1, split: 'single batch', references,
    strengthItems: [{ id: 'P2', quote: 'verify the output first', text: 'Names the check.' }], opportunityItems: [], rewrite: 'Do X.', contextNote: 'README routes this.' };
  const data = { days: [], promptingReview: { effort: 'high', scope: 'user messages', summary: 'Across projects, checks are named.' }, projects: [
    { name: 'New', tokens: 2, promptReview: review },
    { name: 'Legacy', tokens: 1, promptReview: { ...review, strengthItems: undefined, opportunityItems: undefined } }
  ] };
  const { app } = mount(data);
  assert.match(app.innerHTML, /<q>verify the output first<\/q> Names the check\./);
  assert.match(app.innerHTML, /P2 · Codex · 2026-11-19 03:39Z/);
  assert.match(app.innerHTML, /<li>Undefined term\.<span class="ref">P5 · Claude Code · 2026-11-19 05:21Z<\/span><\/li>/);
  assert.match(app.innerHTML, /Written by the model as an illustration/);
  assert.match(app.innerHTML, /Across projects, checks are named\./);
});

test('git evidence is capped per project, shown in UTC and flags an unknown author', () => {
  const commits = Array.from({ length: 25 }, (_, i) => ({ hash: String(i).padStart(40, 'a'), at: '2026-11-18T16:15:02+04:00', subject: 'Change ' + i }));
  const git = { count: 25, first: '2026-11-18T16:15:02+04:00', last: '2026-11-18T16:15:02+04:00', repositories: [{ name: 'repo', commits, authorUnknown: true }, { name: 'gone', commits: [], unavailable: true }] };
  const { app } = mount({ days: [], projects: [{ name: 'G', tokens: 1, git }] });
  assert.match(app.innerHTML, /2026-11-18 12:15Z/);
  assert.match(app.innerHTML, /Show 5 more commits/);
  assert.match(app.innerHTML, /author email not set/);
  assert.match(app.innerHTML, /gone · Git history unavailable/);
  assert.match(app.innerHTML, /25 commits/);
});

test('busy reports list a few projects first and open everything for print', () => {
  const projects = Array.from({ length: 9 }, (_, i) => ({ name: 'P' + i, tokens: 100 - i, report: report([example({ status: 'recorded' })]) }));
  const opened = [{ open: false }, { open: false }];
  const { app } = mount({ days: [], projects }, { hash: '#print', details: opened });
  assert.match(app.innerHTML, /Show 4 more projects/);
  assert.match(app.innerHTML, /id="tgl"/);
  assert.deepEqual(opened.map((item) => item.open), [true, true]);
  assert.equal(mount({ days: [], projects: [projects[0]] }).app.innerHTML.includes('id="tgl"'), false);
  assert.match(mount({ days: [], projects: [projects[0]] }).app.innerHTML, /class="card proj" id="p-P0" style="--pc:var\(--c0\)" open/);
});

test('report text colours meet WCAG AA contrast in light and dark', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'template', 'report.html'), 'utf8');
  const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]));
  const light = vars(css.slice(css.indexOf(':root{'), css.indexOf('@media screen and (prefers-color-scheme:dark)')));
  const dark = vars(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('*{box-sizing')));
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const text of ['fg', 'sec', 'accent', 'ok', 'warn']) {
      for (const surface of ['card', 'bg']) {
        assert.ok(ratio(set[text], set[surface]) >= 4.5, name + ' ' + text + ' on ' + surface + ' is ' + ratio(set[text], set[surface]).toFixed(2));
      }
    }
  }
});

test('advice is its own section with official links only, and collapsed rows carry an icon', () => {
  const advice = { strength: { text: 'Goals first.', evidence: 'a: stated up front.' }, watch: { text: 'Very short asks.', evidence: 'a: repeated.', topic: 'context' },
    habit: { text: 'Say what you tried.', topic: 'context' }, firstLook: true, prompts: 4,
    links: [{ title: 'Prompting best practices', url: 'https://platform.claude.com/docs/x' }, { title: 'Bad', url: 'https://evil.example/x' }] };
  const data = buildData({ month: '2026-11', scan, reports: { 'a</script>b': report([example()]) }, overview: { summary: 's', goal: 'g', achievement: 'a', advice }, now: new Date(2026, 10, 18) });
  const html = mount(data).app.innerHTML;
  assert.ok(html.includes('id="advice"') && html.includes('href="#advice"') && html.includes('First look · 4 prompts'));
  assert.ok(html.indexOf('id="advice"') > html.indexOf('id="projects"') && !html.slice(html.indexOf('id="overview"'), html.indexOf('id="usage"')).includes('Strength'));
  assert.ok(html.includes('href="https://platform.claude.com/docs/x"') && !html.includes('evil.example'));
  assert.ok(/class="pico"[^>]*><svg/.test(html));
  assert.ok(!mount(buildData({ month: '2026-11', scan, reports: { 'a</script>b': report([example()]) }, overview: { summary: 's', goal: 'g', achievement: 'a' }, now: new Date(2026, 10, 18) })).app.innerHTML.includes('id="advice"'));
});

test('buildData keeps dailyTurns for turn-only sources', () => {
  const d = buildData({ month: '2026-11', scan: { projects: [{ name: 'x', totalTokens: 0, sessions: 1, promptCount: 2, dailyTurns: { '2026-11-02': 2 } }] }, now: new Date(2026, 10, 18) });
  assert.deepStrictEqual(d.projects[0].dailyTurns, { '2026-11-02': 2 });
});
