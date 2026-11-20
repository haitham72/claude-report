'use strict';

// Builds design/panel-preview.html: the real sidebar page inside a mock editor window,
// with a fake host so every tab and the live report run can be tried in a browser.
// Token, tool, model and hour figures are the owner's real last 30 days. The plan-usage
// gauges, trend and the report run are sample/simulated, because nothing is connected here.
const fs = require('fs');
const path = require('path');
const { scanDays, dayList } = require('../src/scan');
const { buildPanelHtml, buildMetricsData } = require('../src/panel');
const { version } = require('../package.json');
const { listSessions, ageLabel, groupOf } = require('../src/sessions');

// DEMO=1 builds the same page from invented data (design/demo-data.js) for published screenshots.
const DEMO = process.env.DEMO === '1';
const demoData = DEMO ? require('./demo-data').demo(new Date()) : null;

const now = new Date();
const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 30);
const days = dayList(from, to);

const t = Date.now();
const history = [];
let s = 4, w = 18;
for (let i = 0; i < 240; i++) {
  s = Math.max(0, Math.min(100, s + Math.sin(i / 9) * 2.2 + 0.35));
  if (i % 60 === 0) s = 3;
  w = Math.min(100, w + 0.045);
  history.push({ t: t - (240 - i) * 60000, s: +s.toFixed(1), w: +w.toFixed(1) });
}
const live = { model: 'Sonnet', ctxPct: 23, fiveHour: { pct: 16, resetsAt: Math.floor(t / 1000) + 7200, seenAt: t - 90000 }, sevenDay: { pct: 28, resetsAt: Math.floor(t / 1000) + 300000, seenAt: t - 90000 }, stale: false, updatedAt: t - 90000, source: 'hook' };

const projects = DEMO ? demoData.projects : scanDays(30);
const state = {
  version: `v${version}`,
  connected: true,
  monthLabel: now.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
  models: { project: 'haiku · medium', final: 'sonnet · high' },
  reports: DEMO ? [{ month: 'demo', label: now.toLocaleString('en-GB', { month: 'long', year: 'numeric' }), projects: 6 }] : [],
  export: { save: true, preview: true, outlook: false, format: 'html', to: '', folder: '', folderLabel: 'Downloads' },
  hookLegacy: false,
  cloud: { project: 'haiku · medium', final: 'sonnet · high' },
  localPrefs: { enabled: false, engine: 'lmstudio', model: '' },
  sessions: DEMO ? demoData.sessions : listSessions({ now: Date.now() }).map((x) => ({ id: x.id, title: x.title, cwd: x.cwd, project: x.project, active: x.active, status: x.status, age: ageLabel(x.updatedAt, Date.now()), group: groupOf(x, Date.now()) })),
  openProject: projects[0] && projects[0].name,
  reportProjects: projects.filter((p) => p.promptCount > 0).map((p) => ({ name: p.name, prompts: p.promptCount, tokens: p.totalTokens, eligible: p.promptCount >= 1 })),
  live,
  metrics: buildMetricsData({ projects, days, live, history: DEMO ? require('./demo-data').planHistory(t) : history, openProject: projects[0] && projects[0].name })
};
const runNames = projects.filter((p) => p.promptCount >= 1).slice(0, 6).map((p) => p.name);
const skipped = projects.filter((p) => p.promptCount < 1).slice(0, 2).map((p) => p.name);

const host = `
(function () {
  var D = ${JSON.stringify(state).replace(/</g, '\\u003c')};
  var RUN = ${JSON.stringify(runNames)}, SKIP = ${JSON.stringify(skipped)};
  var LOCAL = __LOCAL__;
  var NOREPLY = __NOREPLY__;
  var send = function (m) { window.postMessage(m, '*'); };
  var timers = [];
  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function simulate() {
    timers.forEach(clearTimeout); timers = [];
    send({ type: 'stage', stage: 'gathering', text: 'Reading this month' });
    SKIP.forEach(function (n) { send({ type: 'progress', project: n, status: 'skipped' }); });
    RUN.forEach(function (n) { send({ type: 'progress', project: n, status: 'queued' }); });
    var at = 700;
    RUN.forEach(function (n, i) {
      var start = at + Math.floor(i / 3) * 2600 + (i % 3) * 250;
      later(start, function () { send({ type: 'progress', project: n, status: 'gathering' }); });
      later(start + 500, function () { send({ type: 'progress', project: n, status: 'working' }); });
      later(start + 2200 + (i % 3) * 300, function () { send({ type: 'progress', project: n, status: i === 4 ? 'failed' : 'done' }); });
    });
    var end = at + Math.ceil(RUN.length / 3) * 2600 + 600;
    later(end, function () { send({ type: 'stage', stage: 'finalizing', text: 'Tightening wording' }); });
    later(end + 1500, function () { send({ type: 'stage', stage: 'overview', text: 'Writing overview' }); });
    later(end + 3000, function () {
      send({ type: 'stage', stage: 'done', text: 'Report ready' });
      D.reports = [{ month: 'now', label: D.monthLabel, projects: RUN.length - 1 }];
      send({ type: 'state', d: D });
    });
  }
  window.acquireVsCodeApi = function () {
    var st = null;
    return { getState: function () { return st; }, setState: function (x) { st = x; }, postMessage: function (m) {
      if (NOREPLY) return;
      if (m.cmd === 'ready' || m.cmd === 'refresh') later(30, function () { send({ type: 'state', d: D }); });
      else if (m.cmd === 'create') simulate();
      else if (m.cmd === 'localScan') later(60, function () { send({ type: 'local', d: LOCAL }); });
      else if (m.cmd === 'localMode') { LOCAL.enabled = m.mode === 'local'; later(60, function () { send({ type: 'local', d: LOCAL }); }); }
      else if (m.cmd === 'localEngine') { LOCAL.engine = m.engine; later(60, function () { send({ type: 'local', d: LOCAL }); }); }
      else if (m.cmd === 'localPick') { LOCAL.model = m.model; later(60, function () { send({ type: 'local', d: LOCAL }); }); }
      else if (m.cmd === 'connect' || m.cmd === 'disconnect') { D.connected = m.cmd === 'connect'; D.live = D.connected ? live : null; D.metrics.live = D.live; later(200, function () { send({ type: 'state', d: D }); }); }
    } };
  };
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  // This script sits in <head>, where document.body does not exist yet, so the first call waits for the parser.
  function theme() { if (!document.body) return; var l = document.documentElement.getAttribute('data-theme') === 'light' || (document.documentElement.getAttribute('data-theme') !== 'dark' && dark && !dark.matches); document.body.className = l ? 'vscode-light' : 'vscode-dark'; }
  document.addEventListener('DOMContentLoaded', theme); theme(); if (dark && dark.addEventListener) dark.addEventListener('change', theme);
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();`;

const chrome = `
<title>Claude Report Panel</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Preview chrome only: a mock editor window around the real sidebar, so the VS Code theme variables the sidebar relies on exist here. */
body.vscode-dark{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--sb-bg:#181818;--sb-fg:#9d9d9d;--sb-line:#2b2b2b}
body.vscode-light{--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-sideBar-background:#f8f8f8;--vscode-editor-background:#ffffff;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--sb-bg:#f8f8f8;--sb-fg:#616161;--sb-line:#e5e5e5}
html,body{height:100%;background:var(--vscode-editor-background)!important}
.win{display:grid;grid-template-columns:min(320px,100%) 1fr;grid-template-rows:1fr auto;height:100vh;min-height:0}
.side{grid-row:1;overflow-y:auto;overflow-x:hidden;background:var(--vscode-sideBar-background);border-right:1px solid var(--sb-line);min-width:0}
.side #app{min-height:100%}
.editor{grid-row:1;overflow-y:auto;padding:20px 24px;color:var(--vscode-foreground);font-size:13px;min-width:0}
.editor h1{font-size:13px;margin:0 0 4px;font-weight:600}
.editor p{margin:0 0 14px;color:var(--vscode-descriptionForeground);max-width:60ch;line-height:1.5}
.sbl{margin:16px 0 4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.status{display:flex;align-items:center;gap:0;height:24px;padding:0 6px;background:var(--sb-bg);border-top:1px solid var(--sb-line);color:var(--sb-fg);font-size:12px;white-space:nowrap;overflow:hidden}
.status span{padding:0 6px}
.status .g{padding:0 0 0 6px;font-size:13px}
.status .t{padding:0 6px 0 3px}
.ok{color:#34c759}.mid{color:#ff9f0a}.hot{color:#ff453a}
.sbwrap{border:1px solid var(--sb-line);border-radius:4px;overflow:hidden;max-width:480px}
@media (max-width:720px){.win{grid-template-columns:1fr;height:auto}.side{max-height:none}.editor{grid-row:2}.status{grid-row:3}}
</style>`;

const bar = (items) => `<div class="sbwrap"><div class="status">${items}</div></div>`;
const ring = (cls, glyph, label) => `<span class="g ${cls}">${glyph}</span><span class="t">${label}</span>`;
const statusMock = `
<div class="sbl">Bottom status bar, ring gauge: normal, filling, nearly full</div>
${bar(`<span>Sonnet</span>${ring('ok', '◔', '5h 16%')}${ring('ok', '◑', '7d 28%')}<span>ctx 23%</span>`)}
${bar(`<span>Sonnet</span>${ring('mid', '◕', '5h 64%')}${ring('ok', '◑', '7d 41%')}<span>ctx 71%</span>`)}
${bar(`<span>Sonnet</span>${ring('hot', '●', '5h 91%')}${ring('mid', '◕', '7d 66%')}<span>ctx 88%</span>`)}
<p style="margin-top:12px">The real status bar can only show text, VS Code icons and one colour per item, so each gauge is a coloured glyph item next to a plain label item. Colours step green, amber, red at 50% and 80%.</p>`;

// The host script goes first: the sidebar script asks for the VS Code API as soon as it runs.
const html = `${chrome}
<script>${host}</script>
<div class="win"><div class="side" id="side">${buildPanelHtml()}</div>
<div class="editor"><h1>Claude Report sidebar preview</h1>
<p>Try the three tabs on the left. Create report runs a simulated report so you can see the live progress. Token, tool, model and hour figures are your real last 30 days; plan usage and the trend are sample values.</p>${statusMock}</div></div>`;

(async () => {
  const lm = require('../src/local-models');
  let local = { engine: 'lmstudio', model: '', enabled: false, gpu: null, engines: [], models: [] };
  if (DEMO) local = demoData.local;
  else try {
    const [gpu, engines] = await Promise.all([lm.gpuInfo(), lm.detectEngines()]);
    const running = engines.find((e) => e.engine === 'lmstudio' && e.running);
    const models = running ? await lm.listModels({ engine: 'lmstudio', baseUrl: running.baseUrl, gpu }) : [];
    local = { engine: 'lmstudio', model: '', enabled: false, gpu, engines, models: models.map((m) => ({ ...m, maxContextLabel: m.maxContext ? lm.formatTokens(m.maxContext) : '', maxOnGpuLabel: m.maxOnGpu === 0 ? 'too big' : m.maxOnGpu ? lm.formatTokens(m.maxOnGpu) : '' })) };
  } catch { /* no local server while building: the block shows its empty state */ }
  const embed = (h, noreply) => h.replace('__LOCAL__', () => JSON.stringify(local).replace(/</g, '\\u003c')).replace('__NOREPLY__', String(noreply));
  const out = embed(html, false);
  if (DEMO) {
    fs.writeFileSync(path.join(__dirname, 'demo-preview.html'), out);
    const { buildData, renderDocument } = require('../src/render');
    const scan = { projects };
    const reports = {};
    for (const [name, r] of Object.entries(demoData.reports)) reports[name] = { project: name, ...r };
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(__dirname, 'demo-report.html'), renderDocument(buildData({ month, scan, reports, user: demoData.user, overview: demoData.overview, now })));
    console.log('written design/demo-preview.html and design/demo-report.html');
    return;
  }
  fs.writeFileSync(path.join(__dirname, 'splash-preview.html'), embed(html, true));
  fs.writeFileSync(path.join(__dirname, 'panel-preview.html'), out);
  console.log('written design/panel-preview.html', out.length, 'bytes');
})();
