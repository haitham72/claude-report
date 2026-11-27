'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { buildPanelHtml, buildMetricsData } = require('../src/panel');

// Runs the sidebar script against a stub DOM and a fake host.
function boot(saved = null) {
  const html = buildPanelHtml();
  const code = html.split('<script>')[1].split('</script>')[0];
  const sent = [];
  const listeners = {};
  let writes = 0, markup = '';
  const app = {
    get writes() { return writes; },
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; writes++; },
    addEventListener: (t, f) => { listeners['app:' + t] = f; }
  };
  const page = { };
  const window = { addEventListener: (t, f) => { listeners[`win:${t}`] = f; } };
  const document = { getElementById: (id) => (id === 'app' ? app : page) };
  vm.runInNewContext(code, { window, document, acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState(state) { saved = state; } }), setTimeout() {}, console });
  const msg = (m) => listeners['win:message']({ data: m });
  const click = (dataset) => listeners['app:click']({ target: { closest: () => ({ dataset }) } });
  return { app, sent, msg, click, html, get saved() { return saved; } };
}

test('Metrics source switches the body and keeps the current DOM on identical updates', () => {
  const s = boot();
  const projects = [{ name: 'codex-only', tokens: 20, sessions: 1, prompts: 1, t: { input: 16, output: 4, turns: 1 }, daily: {}, dailyTurns: {}, tools: {}, models: {}, hours: new Array(24).fill(0), cache: {} }];
  const d = { ...state, metricSources: [
    { id: 'claude', label: 'Claude', metrics },
    { id: 'codex', label: 'Codex', metrics: { ...metrics, projects } }
  ] };
  s.msg({ type: 'state', d });
  s.click({ tab: 'metrics' });
  assert.ok(s.app.innerHTML.includes('data-source="all"'));
  const writes = s.app.writes;
  s.msg({ type: 'state', d: { ...d } });
  assert.strictEqual(s.app.writes, writes);
  s.click({ source: 'codex' });
  assert.match(s.app.innerHTML, /data-source="codex" aria-pressed="true"/);
  assert.match(s.app.innerHTML, /codex-only/);
  assert.doesNotMatch(s.app.innerHTML, /web-storefront/);
  assert.doesNotMatch(s.app.innerHTML, /Plan usage|5-hour limit/);
});

const day = (n) => `2026-11-${String(n).padStart(2, '0')}`;
const metrics = buildMetricsData({
  days: [day(16), day(17), day(18)],
  projects: [{ name: 'web-storefront', totalTokens: 100, sessions: 1, promptCount: 5, tokens: { input: 1, output: 2, cacheRead: 90, cacheCreate: 7, turns: 3 }, daily: { [day(18)]: 100 }, dailyTurns: { [day(18)]: 3 }, tools: { Bash: { calls: 4, fails: 1 } }, models: { 'sonnet-5-5': 100 }, hours: new Array(24).fill(0), cache: { cold: 0, rebuilt: 0, afterIdle: 0, starts: 1 } }]
});
const state = { version: 'v0.1.2', connected: true, monthLabel: 'November 2026', estimateRevision: 1, models: { project: 'haiku · medium', final: 'sonnet · high' }, reports: [], live: null, metrics };

test('the shell asks the host for state, then draws four tabs and the Metrics page', () => {
  const s = boot();
  assert.deepStrictEqual(s.sent[0], { cmd: 'ready' });
  s.msg({ type: 'state', d: state });
  assert.ok(s.app.innerHTML.includes('Sessions'));
  s.click({ tab: 'metrics' });
  assert.ok(/Metrics/.test(s.app.innerHTML) && /Report/.test(s.app.innerHTML) && /Connect/.test(s.app.innerHTML));
  assert.ok(s.app.innerHTML.includes('Tokens'));
  assert.ok(!/cat|pet/i.test(s.app.innerHTML.replace(/metric|category|indicate/gi, '')), 'no pet or category');
});

test('not connected with no plan reading shows a dot on Connect and a way to get one on Metrics', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: false } });
  s.click({ tab: 'metrics' });
  assert.ok(s.app.innerHTML.includes('tabdot'));
  assert.ok(s.app.innerHTML.includes('No plan reading yet'));
  // A reading from the login poll means the hook is optional, so Metrics does not ask for it.
  s.msg({ type: 'state', d: { ...state, connected: false, live: { fiveHour: { pct: 30, resetsAt: null }, sevenDay: null } } });
  assert.doesNotMatch(s.app.innerHTML, /No plan reading yet/);
});

test('Metrics draws the plan gauges before the 30-day scan arrives', () => {
  const live = { fiveHour: { pct: 37, resetsAt: Math.round(Date.now() / 1000) + 3600, seenAt: Date.now() }, sevenDay: null };
  const early = { ...state, metrics: undefined, live, planHistory: [], planSources: ['claude'] };
  const s = boot();
  s.msg({ type: 'state', d: early });
  s.click({ tab: 'metrics' });
  assert.match(s.app.innerHTML, /Plan usage[\s\S]*37%/);
  assert.match(s.app.innerHTML, /Reading 30 days of usage/);
  assert.doesNotMatch(s.app.innerHTML, /class="splash"/);
  s.msg({ type: 'state', d: { ...state, live, planHistory: [] } });
  assert.match(s.app.innerHTML, /Plan usage[\s\S]*37%[\s\S]*Tokens/);

  // A saved pick of a source without plan limits keeps the splash until its numbers arrive.
  const codex = boot({ tab: 'metrics', metricSource: 'codex' });
  codex.msg({ type: 'state', d: early });
  assert.match(codex.app.innerHTML, /class="splash"/);
  assert.doesNotMatch(codex.app.innerHTML, /Plan usage/);
});

test('Report tab lists each project with its live status', () => {
  const s = boot();
  s.msg({ type: 'state', d: state });
  s.click({ tab: 'report' });
  assert.ok(s.app.innerHTML.includes('Pick a project'));
  s.click({ act: 'create' });
  assert.strictEqual(s.sent[1].cmd, 'create');
  s.msg({ type: 'stage', stage: 'gathering', text: 'Reading projects' });
  s.msg({ type: 'progress', project: 'web-storefront', status: 'queued' });
  s.msg({ type: 'progress', project: 'web-storefront', status: 'gathering' });
  s.msg({ type: 'progress', project: 'web-storefront', status: 'working' });
  assert.ok(/web-storefront[\s\S]*working/.test(s.app.innerHTML));
  s.msg({ type: 'progress', project: 'web-storefront', status: 'done' });
  assert.ok(/web-storefront[\s\S]*done/.test(s.app.innerHTML));
  assert.ok(s.app.innerHTML.includes('Running report…'), 'busy while a stage is running');
  s.msg({ type: 'stage', stage: 'done', text: 'Report ready' });
  assert.ok(s.app.innerHTML.includes('Pick a project'));
});

test('a new report run clears old progress and offers cancellation', () => {
  const s = boot();
  s.msg({ type: 'state', d: state });
  s.click({ tab: 'report' });
  s.msg({ type: 'runStart' });
  s.msg({ type: 'progress', project: 'old project', status: 'done' });
  s.msg({ type: 'stage', stage: 'done', text: 'Report ready' });
  assert.match(s.app.innerHTML, /old project/);
  s.msg({ type: 'runStart' });
  assert.doesNotMatch(s.app.innerHTML, /old project|Report ready/);
  assert.match(s.app.innerHTML, /data-act="cancelReport"/);
  s.click({ act: 'cancelReport' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'cancelReport' });
  s.msg({ type: 'stage', stage: 'cancelled', text: 'Run cancelled' });
  assert.match(s.app.innerHTML, /Run cancelled/);
  assert.doesNotMatch(s.app.innerHTML, /data-act="cancelReport"/);
});

test('Progress opens for a run, switches to live Flow, and keeps partial results actionable', () => {
  const s = boot();
  s.msg({ type: 'state', d: state });
  s.click({ tab: 'report' });
  assert.match(s.app.innerHTML, /data-act="toggleProgress"[^>]*aria-expanded="false"/);
  s.msg({ type: 'runStart' });
  assert.match(s.app.innerHTML, /data-view="list"[^>]*aria-pressed="true"/);
  s.click({ act: 'progressView', view: 'flow' });
  assert.strictEqual(s.saved.progressView, 'flow');
  s.msg({ type: 'stage', stage: 'gathering', text: 'Reading Git history' });
  s.msg({ type: 'stage', stage: 'working', text: 'Writing project reports' });
  s.msg({ type: 'progress', project: 'Portal', status: 'working' });
  assert.match(s.app.innerHTML, /class="progress-flow"[\s\S]*Reading Git history[\s\S]*progress-step active[\s\S]*Portal/);
  s.msg({ type: 'progress', project: 'Portal', status: 'failed', error: 'Model unavailable' });
  s.msg({ type: 'stage', stage: 'done', text: 'Partial report saved', durationMs: 6500, month: '2026-11', run: 'report-id', partial: true });
  assert.match(s.app.innerHTML, /Partial report saved · 6s/);
  assert.match(s.app.innerHTML, /Model unavailable/);
  assert.match(s.app.innerHTML, /Open report/);
  s.click({ act: 'retryFailed', month: '2026-11', run: 'report-id' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'retryFailed', month: '2026-11', run: 'report-id' });
  s.msg({ type: 'runStart' });
  s.msg({ type: 'stage', stage: 'done', text: 'Report ready', durationMs: 4200, month: '2026-11', run: 'revision-id' });
  assert.match(s.app.innerHTML, /data-act="toggleProgress"[^>]*aria-expanded="false"/);
  assert.match(s.app.innerHTML, /Report ready · 4s/);
});

test('Connect tab offers Connect or Disconnect to match the state, and posts the command', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: false } });
  s.click({ tab: 'connect' });
  assert.ok(s.app.innerHTML.includes('data-act="connect"'));
  s.click({ act: 'connect' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'connect' });
  s.msg({ type: 'state', d: { ...state, connected: true } });
  assert.ok(s.app.innerHTML.includes('data-act="disconnect"'));
});

test('Report tab lets you pick projects before creating, and sends only those', () => {
  const s = boot();
  const reportProjects = [
    { id: 'store-front-id', name: 'web-storefront', prompts: 20, tokens: 5, eligible: true },
    { name: 'beta', prompts: 12, tokens: 4, eligible: true },
    { name: 'tiny', prompts: 1, tokens: 1, eligible: false }
  ];
  s.msg({ type: 'state', d: { ...state, reportProjects } });
  s.click({ tab: 'report' });
  assert.ok(s.app.innerHTML.includes('Create report · 2 projects'), 'two eligible projects start selected');
  assert.ok(s.app.innerHTML.includes('title="1 prompts"'));
  assert.match(s.app.innerHTML, /data-proj="store-front-id"[\s\S]*web-storefront/);
  s.click({ proj: 'beta' });
  assert.ok(s.app.innerHTML.includes('Create report · 1 project'));
  s.click({ act: 'create' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1].projects, ['store-front-id']);
  s.click({ act: 'none' });
  assert.ok(!s.app.innerHTML.includes('Create report ·'));
  s.click({ act: 'all' });
  assert.ok(s.app.innerHTML.includes('Create report · 2 projects'));
});

test('Connect tab can test the hook and shows the result', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true } });
  s.click({ tab: 'connect' });
  s.click({ act: 'test' });
  assert.strictEqual(s.sent[s.sent.length - 1].cmd, 'test');
  s.msg({ type: 'test', ok: true, lines: ['The command ran in 80 ms (exit 0).'] });
  assert.ok(s.app.innerHTML.includes('The command ran in 80 ms'));
});

test('Report tab shows what happens after creating and posts option changes', () => {
  const s = boot();
  const exp = { save: true, preview: true, outlook: false, format: 'html', to: '', folder: '', folderLabel: 'Downloads' };
  s.msg({ type: 'state', d: { ...state, export: exp } });
  s.click({ tab: 'report' });
  assert.ok(s.app.innerHTML.includes('Output'));
  assert.ok(s.app.innerHTML.includes('Downloads'));
  assert.match(s.app.innerHTML, /Report depth/);
  assert.doesNotMatch(s.app.innerHTML, /Time evidence|Email draft|Deep review depth|data-opt="preview"/);
  s.click({ opt: 'depth', value: 'deep' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'opt', key: 'depth', value: 'deep' });
  assert.match(s.app.innerHTML, /Deep review depth/);
  s.click({ opt: 'estimateTime' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'opt', key: 'estimateTime', value: true });
  assert.match(s.app.innerHTML, /aria-label="AI time estimates" aria-checked="true"/);
  s.click({ act: 'reportRange', modeValue: 'custom' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'reportRange', mode: 'custom' });
  s.click({ opt: 'save' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'opt', key: 'save', value: false });
  s.click({ fmt: 'pdf' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'opt', key: 'format', value: 'pdf' });
  s.msg({ type: 'state', d: { ...state, export: { ...exp, depth: 'deep', deepEffort: 'medium', outlook: true, to: 'boss@example.com' } } });
  assert.match(s.app.innerHTML, /Deep review depth/);
  assert.doesNotMatch(s.app.innerHTML, /Email draft|boss@example.com/);
  s.click({ opt: 'deepEffort', value: 'high' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'opt', key: 'deepEffort', value: 'high' });
});

test('saved reports have separate open and manage buttons for the selected run', () => {
  const s = boot();
  const month = '2026-11';
  const run = '2026-11-22 08-03-04.100';
  const reports = [
    { month, run, label: 'November 2026', projects: 1, revision: true, durationMs: 65_000 },
    { month, label: 'November 2026', projects: 3 }
  ];
  s.msg({ type: 'state', d: { ...state, reports } });
  s.click({ tab: 'report' });
  assert.match(s.app.innerHTML, /<button[^>]+data-act="open"[^>]+data-run="2026-11-22 08-03-04.100"/);
  assert.match(s.app.innerHTML, /<button[^>]+data-act="manage"[^>]+aria-label="Manage November 2026, 2026-11-22 08:03:04"/);
  assert.match(s.app.innerHTML, /1 project · revision · 1m 5s/);
  s.click({ act: 'open', month, run });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'open', month, run });
  s.click({ act: 'manage', month, run });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'manage', month, run });
  s.click({ act: 'manage', month });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'manage', month });
});

test('hidden reports remain accessible when the visible list is empty', () => {
  const s = boot();
  s.msg({ type: 'state', d: state });
  s.click({ tab: 'report' });
  assert.doesNotMatch(s.app.innerHTML, /Hidden reports/);
  s.msg({ type: 'state', d: { ...state, archivedReportCount: 2 } });
  assert.match(s.app.innerHTML, /<button[^>]+data-act="archivedReports">Hidden reports/);
  s.click({ act: 'archivedReports' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'archivedReports' });
});

test('Report sections fold from their headings, long lists fold behind the arrow, and both survive a reload', () => {
  const s = boot();
  const reports = Array.from({ length: 7 }, (_, i) => ({ month: '2026-11', run: `2026-11-2${i} 08-00-00.000`, label: 'Report ' + i, projects: 1 }));
  const reportProjects = Array.from({ length: 9 }, (_, i) => ({ name: 'proj' + i, prompts: 9 - i, eligible: true }));
  s.msg({ type: 'state', d: { ...state, reports, reportProjects } });
  s.click({ tab: 'report' });
  ['r-projects', 'r-model', 'r-output', 'r-saved'].forEach((k) => assert.match(s.app.innerHTML, new RegExp(`data-fold="${k}"><button type="button" class="fold-t" aria-expanded="true">`), k));
  assert.match(s.app.innerHTML, /9 of 9 · <a data-act="all">/);
  assert.match(s.app.innerHTML, /data-list="r-projects"[\s\S]*?4 more/);
  assert.match(s.app.innerHTML, /data-list="r-saved"[\s\S]*?2 more/);

  s.click({ key: 'r-saved' });
  assert.match(s.app.innerHTML, /class="hrows hrows-expanded" data-list="r-saved"/);
  s.click({ fold: 'r-output' });
  assert.match(s.app.innerHTML, /class="cp-scope click sub closed" data-fold="r-output"/);
  assert.doesNotMatch(s.app.innerHTML, /Report depth|Save a copy/);
  assert.match(s.app.innerHTML, /Create report/, 'the button stays when Output is folded');

  const again = boot(s.saved);
  again.msg({ type: 'state', d: { ...state, reports, reportProjects } });
  assert.match(again.app.innerHTML, /class="hrows hrows-expanded" data-list="r-saved"/);
  assert.match(again.app.innerHTML, /data-fold="r-output"><button type="button" class="fold-t" aria-expanded="false">/);
  again.click({ fold: 'r-saved' });
  assert.doesNotMatch(again.app.innerHTML, /Report 0/);
  assert.match(again.app.innerHTML, /Hidden reports|Saved reports/);
});

test('Sessions groups fold, and a long group shows eight rows before the arrow', () => {
  const s = boot();
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'id' + i, title: 'Earlier ' + i, cwd: 'G:/x', project: 'x', active: false, status: '', age: i + 'd', group: 'Earlier' }));
  s.msg({ type: 'state', d: { ...state, sessions: many } });
  assert.match(s.app.innerHTML, /data-list="s-earlier"[\s\S]*?4 more/);
  s.click({ fold: 's-earlier' });
  assert.doesNotMatch(s.app.innerHTML, /Earlier 0/);
  assert.match(s.app.innerHTML, /closed" data-fold="s-earlier"/);
});

test('Metrics keeps an opened list open across the next state update', () => {
  const s = boot();
  const tools = {}; for (let i = 0; i < 14; i++) tools['T' + i] = { calls: 20 - i, fails: 0 };
  const m = { ...metrics, projects: metrics.projects.map((p) => ({ ...p, tools })) };
  s.msg({ type: 'state', d: { ...state, metrics: m } });
  s.click({ tab: 'metrics' });
  assert.match(s.app.innerHTML, /data-key="m-tools" aria-expanded="false"/);
  s.click({ key: 'm-tools' });
  s.msg({ type: 'state', d: { ...state, metrics: m, version: 'v0.1.3' } });
  assert.match(s.app.innerHTML, /class="hrows hrows-expanded" data-list="m-tools"/);
});

const sessions = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Fix the login form', cwd: 'G:/x/a', project: 'a', active: true, status: 'busy', age: 'now', group: 'Active' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Plan the release', cwd: 'G:/x/b', project: 'b', active: false, status: '', age: '4h', group: 'Today' },
  { id: '33333333-3333-4333-8333-333333333333', title: 'Old <b>work</b>', cwd: 'G:/x/a', project: 'a', active: false, status: '', age: '3d', group: 'Earlier' }
];

test('the shell always opens on Sessions and lists them by group', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, sessions, openProject: 'a' } });
  assert.ok(s.app.innerHTML.includes('New session'));
  assert.ok(s.app.innerHTML.includes('Fix the login form'));
  assert.ok(/Active[\s\S]*Today[\s\S]*Earlier/.test(s.app.innerHTML));
  assert.ok(!s.app.innerHTML.includes('Old <b>'), 'titles are escaped');
});

test('clicking a session asks the host to resume it, and New session starts one', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, sessions, openProject: 'a' } });
  s.click({ sid: sessions[1].id, cwd: 'G:/x/b' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'resume', id: sessions[1].id, cwd: 'G:/x/b' });
  s.click({ act: 'newSession' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'newSession' });
});

test('Only the open project narrows the session list', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, sessions, openProject: 'a' } });
  s.click({ act: 'sessOnly' });
  assert.ok(s.app.innerHTML.includes('Fix the login form'));
  assert.ok(!s.app.innerHTML.includes('Plan the release'));
});

test('an old Companio hook shows an Update the hook row', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, hookLegacy: true } });
  s.click({ tab: 'connect' });
  assert.ok(s.app.innerHTML.includes('Status hook'));
});

test('a session click sends its title so the terminal can be named, and a gone status line can be removed', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, sessions: [{ id: '44444444-4444-4444-8444-444444444444', title: 'T', cwd: 'G:/x', project: 'x', active: false, status: '', age: '1h', group: 'Today' }], connected: true, chainMissing: true } });
  s.click({ sid: '44444444-4444-4444-8444-444444444444', cwd: 'G:/x' });
  assert.strictEqual(s.sent[s.sent.length - 1].cmd, 'resume');
  s.click({ tab: 'connect' });
  assert.ok(s.app.innerHTML.includes('Previous status line'));
  s.click({ act: 'dropChain' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'dropChain' });
});

const local = {
  engine: 'lmstudio', model: '', enabled: false,
  gpu: { name: 'NVIDIA GeForce RTX 4080', totalMiB: 16376, usedMiB: 14062, freeMiB: 1989 },
  engines: [{ engine: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', running: true }, { engine: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', running: false }],
  models: [
    { id: 'qwen/qwen3-4b-2507', quantization: 'Q4_K_M', sizeBytes: 2.5e9, state: 'loaded', maxContextLabel: '262k', maxOnGpuLabel: '85k', estimated: true },
    { id: 'google/gemma-4-12b-qat', quantization: 'Q4_0', sizeBytes: 6.9e9, state: 'idle', maxContextLabel: '262k', maxOnGpuLabel: '38k', estimated: true }
  ]
};

test('Report model defaults to Cloud, showing Haiku and Sonnet, and looks for nothing locally', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: false, engine: 'lmstudio', model: '' }, cloud: { project: 'haiku · medium', final: 'sonnet · high' } } });
  s.click({ tab: 'connect' });
  assert.ok(s.app.innerHTML.includes('Report model'));
  assert.ok(s.app.innerHTML.includes('haiku · medium') && s.app.innerHTML.includes('sonnet · high'));
  assert.ok(!s.app.innerHTML.includes('Use for project summaries'));
  assert.ok(!s.app.innerHTML.includes('data-eng'), 'no engine picker in cloud mode');
  assert.ok(!s.sent.some((m) => m.cmd === 'localScan'));
});

test('switching to Local posts the mode, then shows the engine swap, GPU and models with their limits', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: false }, cloud: { project: 'haiku · medium', final: 'sonnet · high' } } });
  s.click({ tab: 'connect' });
  s.click({ mode: 'local' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'localMode', mode: 'local' });
  s.msg({ type: 'local', d: { ...local, enabled: true } });
  assert.ok(s.app.innerHTML.includes('data-eng="lmstudio"') && s.app.innerHTML.includes('data-eng="ollama"'));
  assert.ok(s.app.innerHTML.includes('RTX 4080') && s.app.innerHTML.includes('16 GB'));
  assert.ok(s.app.innerHTML.includes('qwen/qwen3-4b-2507') && s.app.innerHTML.includes('85k'));
  assert.ok(!s.app.innerHTML.includes('Use for project summaries'), 'the mode switch replaces that row');
  s.click({ eng: 'ollama' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'localEngine', engine: 'ollama' });
  s.click({ lm: 'google/gemma-4-12b-qat' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'localPick', model: 'google/gemma-4-12b-qat' });
  s.click({ mode: 'cloud' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'localMode', mode: 'cloud' });
});

test('in Local mode with the engine not running the model list is replaced by a hint', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: true } } });
  s.click({ tab: 'connect' });
  s.msg({ type: 'local', d: { ...local, enabled: true, engine: 'ollama', models: [] } });
  assert.ok(s.app.innerHTML.includes('not running'));
  assert.ok(!s.app.innerHTML.includes('data-lm='));
});

test('opening Connect while Local is already chosen asks the host to look', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: true, engine: 'lmstudio' } } });
  s.click({ tab: 'connect' });
  assert.strictEqual(s.sent[s.sent.length - 1].cmd, 'localScan');
});

test('Report tab shows a Cloud/Local seg with Cloud pressed by default', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: false } } });
  s.click({ tab: 'report' });
  const h = s.app.innerHTML;
  assert.ok(/data-mode="cloud"[^>]*aria-pressed="true"/.test(h) && /data-mode="local"[^>]*aria-pressed="false"/.test(h));
  assert.ok(h.includes('haiku · medium per project · sonnet · high overview'));
  assert.ok(!h.includes('Choose model…'));
});

test('Report tab: choosing Local posts the mode and offers Choose model…', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: false } } });
  s.click({ tab: 'report' });
  s.click({ mode: 'local' });
  assert.deepStrictEqual(s.sent[s.sent.length - 1], { cmd: 'localMode', mode: 'local' });
  assert.ok(s.app.innerHTML.includes('Choose model…'));
});

test('Local with no model picked still allows Create and says the model is chosen automatically', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: true, model: '' }, reportProjects: [{ name: 'A', path: '/a', prompts: 3, eligible: true }] } });
  s.click({ tab: 'report' });
  const h = s.app.innerHTML;
  assert.ok(h.includes('Auto: best model that fits'));
  assert.ok(!/data-act="create" disabled/.test(h));
});

test('Choose model… opens Connect and asks the host to scan', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: false } } });
  s.click({ tab: 'report' });
  s.click({ mode: 'local' });
  s.click({ tab: 'connect' });
  assert.strictEqual(s.sent[s.sent.length - 1].cmd, 'localScan');
  assert.ok(s.app.innerHTML.includes('Report model'));
});

test('a stopped local server is never started for the user: Connect offers an Open button that asks the host', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, localPrefs: { enabled: true, engine: 'lmstudio' } } });
  s.click({ tab: 'connect' });
  s.msg({ type: 'local', d: { enabled: true, engine: 'lmstudio', gpu: null, models: [],
    engines: [{ engine: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', running: false }, { engine: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', running: false }] } });
  assert.match(s.app.innerHTML, /data-act="openEngine">Open LM Studio/);
  assert.ok(!s.sent.some((m) => m.cmd === 'openEngine'), 'nothing opened before the click');
  s.click({ act: 'openEngine' });
  assert.ok(s.sent.some((m) => m.cmd === 'openEngine'));
});
test('the active tab survives a reload, and Connect rescans on each entry with pending feedback', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, connected: true, localPrefs: { enabled: true, engine: 'lmstudio' } } });
  s.click({ tab: 'connect' });
  assert.strictEqual(s.saved.tab, 'connect');
  assert.strictEqual(s.sent.filter((m) => m.cmd === 'localScan').length, 1);
  s.msg({ type: 'local', d: { enabled: true, engine: 'lmstudio', engines: [], models: [] } });
  s.click({ tab: 'sessions' });
  s.click({ tab: 'connect' });
  assert.strictEqual(s.sent.filter((m) => m.cmd === 'localScan').length, 2);
  assert.ok(s.app.innerHTML.includes('Checking local server'));
});

test('Only the open project on Sessions is a keyboard-operable switch', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, openProject: 'p', sessions: [] } });
  assert.match(s.app.innerHTML, /<button[^>]*role="switch"[^>]*data-act="sessOnly"/);
});

test('Report projects collapse to max 5 with x more, toggle Show less, and persist across reload', () => {
  const s = boot();
  const reportProjects = Array.from({ length: 9 }, (_, i) => ({ name: 'proj' + i, prompts: 9 - i, eligible: true }));
  s.msg({ type: 'state', d: { ...state, reportProjects } });
  s.click({ tab: 'report' });
  assert.match(s.app.innerHTML, /data-list="r-projects"[\s\S]*?4 more/);
  assert.match(s.app.innerHTML, /data-key="r-projects" aria-expanded="false"/);
  const visibleProjects = s.app.innerHTML.split('data-list="r-projects"')[1].split('class="hmore-body"')[0];
  assert.equal([...visibleProjects.matchAll(/data-proj=/g)].length, 5);
  s.click({ key: 'r-projects' });
  assert.match(s.app.innerHTML, /class="hrows hrows-expanded" data-list="r-projects"/);
  assert.match(s.app.innerHTML, /data-key="r-projects" aria-expanded="true"[\s\S]*?Show less/);
  assert.strictEqual(s.saved.more['r-projects'], true);

  const reloaded = boot(s.saved);
  reloaded.msg({ type: 'state', d: { ...state, reportProjects } });
  assert.match(reloaded.app.innerHTML, /class="hrows hrows-expanded" data-list="r-projects"/);
  assert.match(reloaded.app.innerHTML, /Show less/);
});

const cloudProvidersFixture = {
  provider: 'claude',
  cloudRevision: 1,
  providers: [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      connected: true,
      planLabel: 'Max 5x',
      headroom: '74% left',
      supportsEffort: true,
      efforts: ['low', 'medium', 'high'],
      models: [
        { id: 'haiku', label: 'Haiku', tier: 'fast', context: 200000 },
        { id: 'sonnet', label: 'Sonnet', tier: 'balanced', context: 200000 },
        { id: 'opus', label: 'Opus', tier: 'strong', context: 200000 }
      ],
      selection: {
        project: { model: 'haiku', effort: 'medium' },
        overview: { model: 'sonnet', effort: 'high' }
      }
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      installed: true,
      connected: true,
      planLabel: 'Pro',
      headroom: '88% left',
      supportsEffort: true,
      efforts: ['low', 'medium', 'high'],
      models: Array.from({ length: 8 }, (_, i) => ({ id: 'ag-model-' + i, label: 'AG Model ' + i, tier: 'balanced', context: 200000,
        ...(i === 1 ? { efforts: ['low', 'high'], defaultEffort: 'low' } : i === 2 ? { efforts: [] } : {}) })),
      selection: {
        project: { model: 'ag-model-0', effort: 'medium' },
        overview: { model: 'ag-model-1', effort: 'high' }
      }
    },
    {
      id: 'codex',
      label: 'Codex',
      installed: true,
      connected: false,
      canSignIn: true,
      reason: 'Not signed in to Codex'
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      installed: true,
      connected: false,
      canSignIn: false,
      reason: 'Use the CLI to sign in'
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      installed: true,
      connected: false,
      canSignIn: true,
      signInGuide: true
    }
  ]
};

test('Expandable cloud hooks list connected subscriptions, fold >5 models, switch roles, and pick models and effort', () => {
  const s = boot();
  const reportProjects = [{ id: 'p1', name: 'proj1', prompts: 5, eligible: true }];
  s.msg({ type: 'state', d: { ...state, reportProjects, cloud: structuredClone(cloudProvidersFixture) } });
  s.click({ tab: 'report' });

  const h0 = s.app.innerHTML;
  assert.match(h0, /data-cloud-provider="claude"[\s\S]*Claude Code[\s\S]*Max 5x[\s\S]*74% left/);
  assert.match(h0, /data-cloud-provider="antigravity"[\s\S]*Antigravity[\s\S]*Pro[\s\S]*88% left/);
  assert.doesNotMatch(h0, /data-cloud-model="ag-model-0"/, 'unselected provider drawer starts collapsed');

  // Clicking expand chevron opens Antigravity without changing selected provider.
  s.click({ cloudExpand: 'antigravity' });
  assert.ok(!s.sent.some((m) => m.cmd === 'cloudPickProvider'));
  assert.match(s.app.innerHTML, /data-list="r-cm-antigravity"[\s\S]*?3 more/, '8 models fold at max 5 with 3 more');
  s.click({ key: 'r-cm-antigravity' });
  assert.match(s.app.innerHTML, /class="hrows hrows-expanded" data-list="r-cm-antigravity"/);

  // Clicking provider row selects it and opens its drawer.
  s.click({ cloudProvider: 'antigravity' });
  const change = s.sent.at(-1);
  assert.equal(change.cmd, 'cloudPickProvider');
  assert.equal(change.provider, 'antigravity');
  const ag = { ...structuredClone(cloudProvidersFixture), provider: 'antigravity' };
  s.msg({ type: 'cloud', d: ag, changeId: change.changeId });
  assert.equal(s.sent.at(-1).provider, 'antigravity');
  assert.equal(s.sent.at(-1).cmd, 'estimateReport');
  assert.match(s.app.innerHTML, /data-cloud-effort="medium" data-provider="antigravity" data-role="project"/);

  // Role switcher switches between Per project and Overview, updating selected radio and effort.
  s.click({ cloudRole: 'overview' });
  assert.strictEqual(s.saved.cloudRole, 'overview');
  assert.match(s.app.innerHTML, /data-cloud-role="overview" class="on" aria-pressed="true"/);
  assert.match(s.app.innerHTML, /aria-pressed="true" data-cloud-model="ag-model-1" data-provider="antigravity"/);
  assert.doesNotMatch(s.app.innerHTML, /data-cloud-effort="medium" data-provider="antigravity"/);

  s.click({ cloudEffort: 'low', provider: 'antigravity', role: 'overview' });
  const effortChange = s.sent.at(-1);
  assert.deepStrictEqual(effortChange, { cmd: 'cloudPickEffort', provider: 'antigravity', role: 'overview', effort: 'low', changeId: 2 });
  ag.providers[1].selection.overview.effort = 'low';
  s.msg({ type: 'cloud', d: ag, changeId: effortChange.changeId });

  s.click({ cloudModel: 'ag-model-2', provider: 'antigravity' });
  const modelChange = s.sent.at(-1);
  assert.deepStrictEqual(modelChange, { cmd: 'cloudPickModel', provider: 'antigravity', role: 'overview', model: 'ag-model-2', changeId: 3 });
  ag.providers[1].selection.overview = { model: 'ag-model-2', effort: '' };
  s.msg({ type: 'cloud', d: ag, changeId: modelChange.changeId });
  assert.doesNotMatch(s.app.innerHTML, /data-cloud-effort="[^\"]*" data-provider="antigravity"/);
});

test('Connect tab shows signed-out installed hooks with Sign in button and never renders API-key prompts', () => {
  const s = boot();
  s.msg({ type: 'state', d: { ...state, localPrefs: { enabled: false }, cloud: structuredClone(cloudProvidersFixture) } });
  s.click({ tab: 'connect' });
  const h = s.app.innerHTML;
  assert.match(h, /Other installed hooks/);
  assert.match(h, /Not signed in to Codex/);
  assert.match(h, /data-cloud-signin="codex">Sign in<\/button>/);
  assert.match(h, /Gemini CLI[\s\S]*Use the CLI to sign in/);
  assert.doesNotMatch(h, /data-cloud-signin="gemini"/);
  assert.match(h, /data-cloud-signin="opencode">Sign-in steps<\/button>/);
  assert.match(h, /data-act="cloudScan">Rescan<\/button>/);
  assert.doesNotMatch(h, /<input/i, 'never render API-key input');
  assert.doesNotMatch(h, /api[- ]?key/i, 'never mention asking for an API key');

  s.click({ cloudSignin: 'codex' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'cloudSignIn', provider: 'codex' });
  s.click({ act: 'cloudScan' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'cloudScan' });
});

test('Report tab shows live subscription % impact strip without currency and lets user switch on tight headroom', () => {
  const s = boot();
  const reportProjects = [{ id: 'p1', name: 'proj1', prompts: 10, eligible: true }];
  const tightEstimate = {
    summaryLine: 'Est. ~18% of 5h Claude Code window (54% -> 72%)',
    tight: true,
    suggestedAlternative: { id: 'antigravity', label: 'Antigravity' }
  };
  s.msg({ type: 'state', d: { ...state, reportProjects, cloud: structuredClone(cloudProvidersFixture) } });
  s.click({ tab: 'report' });
  const request = s.sent.at(-1);
  assert.equal(request.cmd, 'estimateReport');
  s.msg({ type: 'estimate', requestId: request.requestId, d: tightEstimate });
  const h = s.app.innerHTML;
  assert.match(h, /data-estimate="1" role="status">Est\. ~18% of 5h Claude Code window/);
  assert.doesNotMatch(h, /\$|USD/i);
  assert.match(h, /This run could bring usage close to a subscription limit\./);
  assert.match(h, /data-cloud-switch="antigravity">Use Antigravity<\/button>/);

  s.click({ cloudSwitch: 'antigravity' });
  const change = s.sent.at(-1);
  assert.equal(change.cmd, 'cloudPickProvider');
  assert.equal(change.provider, 'antigravity');
  assert.doesNotMatch(s.app.innerHTML, /data-estimate="1"/);
  assert.match(s.app.innerHTML, /data-act="create" disabled/);
  s.msg({ type: 'cloud', d: { ...structuredClone(cloudProvidersFixture), provider: 'antigravity' }, changeId: change.changeId });

  // Updating estimate via message switches to local suggestion and switches to local mode.
  s.msg({ type: 'estimate', requestId: s.sent.at(-1).requestId, d: { summaryLine: 'Est. ~35% of 5h Antigravity window', tight: true, suggestedAlternative: { id: 'local', label: 'Local' } } });
  assert.match(s.app.innerHTML, /data-cloud-switch="local">Use Local<\/button>/);
  s.click({ cloudSwitch: 'local' });
  assert.deepStrictEqual(s.sent.at(-1), { cmd: 'localMode', mode: 'local' });
  assert.doesNotMatch(s.app.innerHTML, /data-estimate="1"/, 'local mode hides cloud impact strip');

  s.click({ mode: 'cloud' });
  assert.equal(s.sent.at(-1).cmd, 'estimateReport');
  assert.doesNotMatch(s.app.innerHTML, /data-estimate="1"/, 'returning to Cloud requests a new estimate');
});

test('Report estimates follow the selection and reject stale estimate replies', () => {
  const s = boot({ tab: 'report' });
  const d = { ...state, estimateRevision: 1, cloud: structuredClone(cloudProvidersFixture), reportProjects: [
    { id: 'p1', name: 'one', prompts: 10, eligible: true }, { id: 'p2', name: 'two', prompts: 12, eligible: true }
  ] };
  s.msg({ type: 'state', d });
  const first = s.sent.at(-1);
  assert.deepEqual(first.projects, ['p1', 'p2']);

  s.click({ proj: 'p2' });
  const second = s.sent.at(-1);
  assert.deepEqual(second.projects, ['p1']);
  s.msg({ type: 'estimate', requestId: second.requestId, d: { summaryLine: 'Estimate for one' } });
  s.msg({ type: 'estimate', requestId: first.requestId, d: { summaryLine: 'Estimate for both' } });
  assert.match(s.app.innerHTML, /Estimate for one/);
  assert.doesNotMatch(s.app.innerHTML, /Estimate for both/);

  s.msg({ type: 'state', d: { ...d, connected: false } });
  assert.equal(s.sent.at(-1).requestId, second.requestId);
  s.click({ opt: 'estimateTime' });
  const time = s.sent.at(-1);
  assert.equal(time.estimateTime, true);
  assert.deepEqual(time.projects, ['p1']);
  assert.doesNotMatch(s.app.innerHTML, /Estimate for one/);

  // A changed date range arrives before its project scan. The old request is ignored.
  s.msg({ type: 'state', d: { ...d, monthLabel: 'Custom dates', reportProjects: undefined } });
  s.msg({ type: 'estimate', requestId: time.requestId, d: { summaryLine: 'Estimate for old range' } });
  assert.doesNotMatch(s.app.innerHTML, /Estimate for old range/);
  s.msg({ type: 'state', d: { ...d, monthLabel: 'Custom dates', estimateRevision: null } });
  assert.equal(s.sent.at(-1).requestId, time.requestId, 'cached projects do not trigger estimates');
  s.msg({ type: 'state', d: { ...d, monthLabel: 'Custom dates', estimateRevision: 2 } });
  assert.deepEqual(s.sent.at(-1).projects, ['p1']);
  assert.notEqual(s.sent.at(-1).requestId, time.requestId);
});

test('Report waits for a verified cloud hook before estimating or enabling Create', () => {
  const s = boot({ tab: 'report' });
  s.msg({ type: 'state', d: { ...state, reportProjects: [{ id: 'p1', prompts: 3, eligible: true }], cloud: { loading: true, providers: [] } } });
  assert.match(s.app.innerHTML, /Checking for signed-in cloud hooks…/);
  assert.match(s.app.innerHTML, /data-act="create" disabled/);
  assert.equal(s.sent.length, 1);
  s.msg({ type: 'cloud', d: { provider: 'claude', providers: [] } });
  assert.match(s.app.innerHTML, /No signed-in cloud hook found/);
  assert.match(s.app.innerHTML, /Connect a cloud hook/);
  assert.equal(s.sent.length, 1);
});
