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
const state = { version: 'v0.1.2', connected: true, monthLabel: 'November 2026', models: { project: 'haiku · medium', final: 'sonnet · high' }, reports: [], live: null, metrics };

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
