'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listReports, loadRun, saveRun } = require('../src/report-store');

function loadHost(vscode, home, runModel, workerResult = () => ({ projects: [] }), overrides = {}) {
  const file = require.resolve('../extension');
  delete require.cache[file];
  const load = Module._load;
  const previousHome = process.env.CLAUDE_REPORT_HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const realCloud = require('../src/cloud-providers');
  const { cloudScanResult, ...moduleOverrides } = overrides;
  const defaultCloudScan = {
    providers: [{ id: 'claude', label: 'Claude Code', installed: true, connected: true, status: 'connected', planLabel: 'Pro', reason: '', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    modelsByProvider: { claude: [{ id: 'haiku', label: 'Haiku', tier: 'fast' }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced' }, { id: 'opus', label: 'Opus', tier: 'strong' }] },
    calibrations: {},
    liveQuotas: {}
  };
  const inputs = {
    vscode,
    os: { ...os, homedir: () => home },
    worker_threads: { Worker: class extends EventEmitter {
      constructor(workerFile, { workerData }) {
        super();
        const result = path.basename(workerFile) === 'cloud-scan-worker.js'
          ? (cloudScanResult ? cloudScanResult(workerData) : defaultCloudScan)
          : workerResult(workerData, workerFile);
        queueMicrotask(() => this.emit('message', result));
      }
    } },
    './src/cloud-providers': {
      ...realCloud,
      detectProvider: () => null,
      detectCloudProviders: () => [],
      discoverProviderModels: () => [],
      runCloudProvider: runModel
    },
    './src/install': { ...require('../src/install'), migrateLegacy() {} },
    './src/live': { readLive: () => null, readHistory: () => [] },
    './src/sessions': { listSessions: () => [] },
    './src/transcript-live': { readTranscriptLive: () => null },
    // The real poll would read this machine's Claude Code login and call Anthropic.
    './src/plan-usage': { getUsage: (cb) => cb(null, 'disabled', { route: 'disabled' }), lastUsageRoute: () => 'disabled' },
    ...moduleOverrides,
  };
  process.env.CLAUDE_REPORT_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  Module._load = function (name, parent, ...rest) {
    return parent?.filename === file && Object.hasOwn(inputs, name) ? inputs[name] : load.call(this, name, parent, ...rest);
  };
  try {
    return require(file);
  } finally {
    Module._load = load;
    if (previousHome === undefined) delete process.env.CLAUDE_REPORT_HOME;
    else process.env.CLAUDE_REPORT_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  }
}

test('the sidebar Manage action edits, compares, and enhances a selected saved project', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-host-'));
  t.after(() => fs.rmSync(home, { recursive: true }));
  const month = '2026-11';
  const date = new Date('2026-11-18T12:00:00Z');
  const report = (project) => ({ project, summary: `Original ${project} summary`, examples: [], usedFor: [], didntWork: [], nextMonth: [] });
  const projects = ['Alpha', 'Beta'].map((name) => ({ id: name.toLowerCase(), name, report: report(name) }));
  const evidence = projects.map(({ id, name }) => ({ id, name, prompts: [{ at: date.toISOString(), text: `Review the implementation for ${name}.` }] }));
  const dateRange = { from: '2026-10-31', to: '2026-11-18' };
  const data = { month, dateRange, projects, label: 'November 2026', overview: { summary: 'Original overview' } };
  const original = saveRun(home, data, {}, '<p>original</p>', date, { evidence, metadata: { cutoff: date.toISOString() } });

  let provider, receive, disposeView, reviewRange = dateRange;
  let activeReviewWorkers = 0, peakReviewWorkers = 0;
  const commands = [], documents = [], errors = [], requests = [], posts = [], previews = [], picks = [];
  const vscode = {
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {} }),
      registerWebviewViewProvider: (_, value) => { provider = value; },
      createWebviewPanel: () => { const panel = { webview: {} }; previews.push(panel); return panel; },
      async showQuickPick(items) {
        const wanted = picks.shift();
        const find = (label) => {
          const selected = items.find((item) => (item.label || item) === label);
          assert.ok(selected, `Expected ${label} in the menu`);
          return selected;
        };
        return Array.isArray(wanted) ? wanted.map(find) : find(wanted);
      },
      async showInputBox({ title, value }) {
        if (title === 'Start date') return '2026-10-30';
        if (title === 'End date') return '2026-11-02';
        assert.equal(title, 'Summary');
        assert.equal(value, 'Original Alpha summary');
        return 'My edited summary';
      },
      async showInformationMessage(message, opts, action) {
        const detail = opts && opts.detail;
        if (/^Create the /.test(message)) return action;
        if (message === 'Run a Deep prompting review?') {
          assert.match(detail, /depth · [0-9]+ model requests?./);
          return action;
        }
        assert.equal(message, 'Enhance this saved report?');
        assert.match(detail, /[0-9]+ projects?/);
        assert.match(detail, /through your Claude Code/);
        assert.match(detail, /token/i);
        return action;
      },
      showWarningMessage() {},
      showErrorMessage: (message) => errors.push(message)
    },
    commands: {
      registerCommand() {},
      async executeCommand(...args) { commands.push(args); }
    },
    workspace: {
      getConfiguration: () => ({ get: (key) => ({ reportModel: 'haiku', finalizerModel: 'opus', 'export.save': false })[key] }),
      async openTextDocument({ content }) { documents.push(JSON.parse(content)); return { uri: documents.length }; }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    ThemeColor: class {}
  };
  const host = loadHost(vscode, home, async (request) => {
    requests.push(request);
    if (request.kind === 'deep-review') {
      assert.equal(request.model, 'haiku');
      peakReviewWorkers = Math.max(peakReviewWorkers, ++activeReviewWorkers);
      await Promise.resolve();
      activeReviewWorkers--;
      return JSON.stringify({ summary: 'Defines scope clearly.',
        strengths: [{ id: 'P1', quote: 'Review the implementation', text: 'Identifies a specific review target.' }],
        opportunities: [], rewrite: 'Review the implementation and list two test results.' });
    }
    if (request.kind === 'overview') {
      assert.equal(request.model, 'opus');
      assert.equal(activeReviewWorkers, 0);
      assert.match(request.prompt, /"promptingReviews":\[\{"project":"Alpha".*"project":"Beta"/);
      assert.doesNotMatch(request.prompt, /Review the implementation for Alpha|fixture-session/);
      return JSON.stringify({ summary: 'Reviewed both implementations.', goal: 'Improve the current work.',
        achievement: 'Recorded review targets.', promptingSummary: 'Both projects supplied clear scope.' });
    }
    return JSON.stringify({ summary: 'Cloud summary', examples: [{ task: 'Check the new behavior', basis: 'Test results' }] });
  }, (input) => {
    if (input.deepGit || input.git) return {};
    if (!input.deep) return { projects: evidence.map((p) => ({ ...p, promptCount: 1, daily: {}, totalTokens: 25, sessions: 1 })) };
    assert.deepEqual(input.dateRange, reviewRange);
    return { projects: evidence.map((p) => ({ ...p, prompts: p.prompts.map((prompt) =>
      ({ ...prompt, words: 5, source: 'codex', session: 'fixture-session' })) })) };
  });
  host.activate({ subscriptions: [] });
  provider.resolveWebviewView({
    webview: { onDidReceiveMessage(fn) { receive = fn; }, postMessage: (message) => posts.push(message) },
    onDidChangeVisibility() {}, onDidDispose(fn) { disposeView = fn; }
  });
  t.after(() => { disposeView(); host.deactivate(); });

  await receive({ cmd: 'opt', key: 'depth', value: 'deep' });
  await receive({ cmd: 'opt', key: 'estimateTime', value: true });
  await receive({ cmd: 'reportRange', mode: 'custom' });
  const configured = posts.filter(({ type }) => type === 'state').at(-1).d.export;
  assert.equal(configured.depth, 'deep');
  assert.equal(configured.estimateTime, true);
  assert.deepEqual(configured.dateRange, { from: '2026-10-30', to: '2026-11-02' });

  const manage = async (run, ...menu) => {
    picks.push(...menu);
    await receive({ cmd: 'manage', month, run });
    assert.deepEqual(errors, []);
    assert.deepEqual(picks, []);
  };
  await manage(original, 'Edit projects', 'Alpha', 'Summary');
  const edited = listReports(home).find(({ run }) => run !== original).run;
  const editedReport = loadRun(home, month, edited);
  assert.equal(editedReport.metadata.parentRun, original);
  assert.deepEqual(editedReport.metadata.overrides, { alpha: { summary: 'My edited summary' } });
  assert.deepEqual(loadRun(home, month, original).data, data);

  await manage(edited, 'Compare with previous revision');
  assert.equal(documents[0].projects[0].report.summary, 'Original Alpha summary');
  assert.equal(documents[1].projects[0].report.summary, 'My edited summary');
  assert.deepEqual(commands[0].slice(0, 3), ['vscode.diff', 1, 2]);

  await manage(edited, 'Enhance report', 'Selected projects', ['Alpha'], 'Claude Code', 'Sonnet', 'high');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].label, 'Alpha');
  assert.equal(requests[0].model, 'sonnet');
  assert.equal(requests[0].effort, 'high');
  assert.match(requests[0].prompt, /Review the implementation for Alpha/);
  assert.doesNotMatch(requests[0].prompt, /Review the implementation for Beta/);
  const enhanced = listReports(home).find(({ run }) => run !== original && run !== edited).run;
  const enhancedReport = loadRun(home, month, enhanced);
  assert.equal(enhancedReport.metadata.parentRun, edited);
  assert.equal(enhancedReport.metadata.provider, 'cloud');
  assert.ok(enhancedReport.metadata.events.some(({ text }) => text === 'Alpha model request completed'));
  assert.equal(enhancedReport.data.projects[0].report.summary, 'My edited summary');
  assert.equal(enhancedReport.data.projects[0].report.examples[0].task, 'Check the new behavior');
  assert.deepEqual(enhancedReport.data.projects[1], projects[1]);
  assert.equal(enhancedReport.data.overviewStale, true);
  assert.ok(posts.some(({ type }) => type === 'runStart'));
  assert.equal(previews.length, 0);

  await manage(original, 'Run Deep prompting review', 'Medium');
  const deep = listReports(home).find(({ metadata }) => metadata?.kind === 'deep');
  const revision = loadRun(home, month, deep.run);
  assert.equal(revision.metadata.parentRun, original);
  assert.equal(revision.metadata.effort, 'medium');
  assert.equal(revision.metadata.finalizerModel, 'opus');
  assert.equal(revision.data.promptingReview.summary, 'Both projects supplied clear scope.');
  assert.deepEqual(revision.data.dateRange, dateRange);
  assert.equal(revision.data.projects[0].promptReview.references[0].id, 'P1');
  assert.deepEqual(revision.data.projects[0].report, projects[0].report);
  const deepRequests = requests.filter(({ kind }) => kind === 'deep-review');
  assert.equal(deepRequests.length, 2);
  assert.equal(peakReviewWorkers, 2);
  assert.equal(requests.at(-1).model, 'opus');
  assert.match(deepRequests[0].prompt, /Review the implementation for Alpha/);
  assert.doesNotMatch(deepRequests[0].prompt, /Review the implementation for Beta/);
  assert.doesNotMatch(JSON.stringify(revision.data), /fixture-session/);
  assert.equal(previews.length, 0);
  await receive({ cmd: 'open', month, run: deep.run });
  assert.match(previews.at(-1).webview.html, /<h2>Prompting<\/h2>/);
  assert.equal(new Set(deepRequests.map(({ depth }) => depth)).size, 1, 'one Deep run reviews at one depth only');
  reviewRange = configured.dateRange;
  const beforeCreate = requests.length;
  await receive({ cmd: 'create', projects: ['alpha', 'beta'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.slice(beforeCreate).map(({ kind, model }) => [kind, model]), [
    ['project', 'haiku'], ['project', 'haiku'], ['deep-review', 'haiku'], ['deep-review', 'haiku'], ['overview', 'opus']
  ]);
  await receive({ cmd: 'reportRange', mode: 'month' });
  assert.equal(posts.filter(({ type }) => type === 'state').at(-1).d.export.dateRange, null);
});

// Opens the sidebar on a host whose scan workers answer only once openScan() is called.
function openSidebar(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-host-side-'));
  t.after(() => fs.rmSync(home, { recursive: true }));
  let openScan;
  const scanHeld = new Promise((resolve) => { openScan = resolve; });
  let provider, receive, disposeView;
  const posts = [];
  const vscode = {
    window: { createStatusBarItem: () => ({ show() {}, hide() {} }), registerWebviewViewProvider: (_, value) => { provider = value; } },
    commands: { registerCommand() {} },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {}
  };
  const start = () => {
    const host = loadHost(vscode, home, async () => '', undefined, {
      worker_threads: { Worker: class extends EventEmitter {
        constructor(workerFile) {
          super();
          if (path.basename(workerFile) === 'cloud-scan-worker.js') {
            queueMicrotask(() => this.emit('message', { providers: [], modelsByProvider: {}, calibrations: {}, liveQuotas: {} }));
          } else {
            scanHeld.then(() => this.emit('message', { projects: [] }));
          }
        }
      } },
      ...overrides,
    });
    host.activate({ subscriptions: [] });
    provider.resolveWebviewView({
      webview: { onDidReceiveMessage(fn) { receive = fn; }, postMessage: (message) => posts.push(message) },
      onDidChangeVisibility() {}, onDidDispose(fn) { disposeView = fn; }
    });
    t.after(() => { disposeView(); host.deactivate(); });
  };
  return {
    home, start, openScan,
    receive: (message) => receive(message),
    states: () => posts.filter(({ type }) => type === 'state').map(({ d }) => d),
    tick: () => new Promise(setImmediate),
  };
}

test('the sidebar posts at once and keeps a late plan-usage answer in every later post', async (t) => {
  const reading = (pct) => ({ fiveHour: { pct, resetsAt: null, seenAt: Date.now() }, sevenDay: null, updatedAt: Date.now(), stale: true });
  let live = reading(10);
  const pending = [];
  // The API answers: the files now hold the new reading, and every waiting getUsage caller hears oauth-api.
  const answer = (pct) => { live = reading(pct); pending.splice(0).forEach((cb) => cb(null, 'ok', { route: 'oauth-api' })); };
  const { start, openScan, receive, states, tick } = openSidebar(t, {
    './src/live': { readLive: () => live, readHistory: () => [] },
    './src/plan-usage': { getUsage: (cb) => { pending.push(cb); }, lastUsageRoute: () => 'none' },
  });
  start();

  // The scan is held, so the API answers while this push still waits for it.
  const first = receive({ cmd: 'ready' });
  await tick();
  assert.equal(states().length, 1, 'posted before the scan and the API finish');
  assert.equal(states()[0].live.fiveHour.pct, 10);
  answer(42);
  await tick();
  assert.equal(states().at(-1).live.fiveHour.pct, 42);
  openScan();
  await first;
  assert.equal(states().at(-1).live.fiveHour.pct, 42, 'the final post does not bring back the older reading');
  assert.deepEqual(states().at(-1).reportProjects, []);

  // The scan is cached now, so this push finishes first and the answer is posted on top of it.
  await receive({ cmd: 'ready' });
  const finished = states().length;
  answer(77);
  await tick();
  assert.equal(states().length, finished + 1);
  assert.equal(states().at(-1).live.fiveHour.pct, 77);
  assert.deepEqual(states().at(-1).reportProjects, [], 'the scan results stay');
});

test('after a restart the sidebar shows the last scan at once, then the new one, and saves it once', async (t) => {
  const side = openSidebar(t);
  const file = path.join(side.home, 'scan-cache.json');
  const monthLabel = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  const reportProjects = [{ id: 'cached', name: 'from-cache', prompts: 3, tokens: 9, eligible: true }];
  const cached = { monthLabel, metrics: { days: [], projects: [{ name: 'from-cache' }] }, metricSources: [], defaultSource: 'claude', reportProjects };
  fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: Date.now(), scan: cached }));
  side.start();

  // The scan is held: the first post already carries the saved Metrics and project list.
  const first = side.receive({ cmd: 'ready' });
  await side.tick();
  assert.equal(side.states().length, 1);
  assert.equal(side.states()[0].metrics.projects[0].name, 'from-cache');
  assert.deepEqual(side.states()[0].reportProjects, reportProjects);
  side.openScan();
  await first;
  assert.deepEqual(side.states().at(-1).reportProjects, [], 'the new scan replaces the saved one');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scan.monthLabel, monthLabel);
  assert.deepEqual(saved.scan.reportProjects, []);
  assert.deepEqual(saved.scan.metrics.projects, []);

  // The next push reuses the same scan, so the file is not written again.
  const written = fs.statSync(file).mtimeMs;
  await side.receive({ cmd: 'ready' });
  assert.equal(fs.statSync(file).mtimeMs, written);
});

test('a scan cache older than two days is ignored', async (t) => {
  const side = openSidebar(t);
  const monthLabel = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  fs.writeFileSync(path.join(side.home, 'scan-cache.json'), JSON.stringify({ version: 1, savedAt: Date.now() - 3 * 86400e3,
    scan: { monthLabel, metrics: { days: [], projects: [{ name: 'old' }] }, reportProjects: [] } }));
  side.start();
  const first = side.receive({ cmd: 'ready' });
  await side.tick();
  assert.equal(side.states()[0].metrics, undefined);
  side.openScan();
  await first;
});

test('creating a report with a non-Claude cloud hook (codex) routes through runCloudProvider, shows subscription % without money, and records metadata', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-host-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true }));
  const date = new Date().toISOString();
  const projects = [{
    id: 'alpha',
    name: 'Alpha',
    baseName: 'Alpha',
    promptCount: 3,
    totalTokens: 1200,
    sessions: 1,
    daily: {},
    prompts: [
      { at: date, text: 'Refactor the parser module and add unit tests.' },
      { at: date, text: 'Fix edge case when the stream is empty.' },
      { at: date, text: 'Run the full suite to verify all checks pass.' }
    ]
  }];

  let provider, receive, disposeView;
  const posts = [], modals = [], cloudRequests = [], terminals = [], errors = [];
  const vscode = {
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {} }),
      registerWebviewViewProvider: (_, value) => { provider = value; },
      createTerminal: (options) => { terminals.push(options); return { show() {} }; },
      async showInformationMessage(message, opts, action) {
        modals.push({ message, detail: opts?.detail });
        if (/^Create the /.test(message)) return action;
        return action;
      },
      showWarningMessage() {},
      showErrorMessage: (m) => errors.push(m)
    },
    commands: { registerCommand() {}, async executeCommand() {} },
    workspace: { getConfiguration: () => ({ get: (k) => (k === 'export.save' ? false : undefined) }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {}
  };

  let codexConnected = true;
  const host = loadHost(vscode, home, async (req) => {
    cloudRequests.push(req);
    if (req.kind === 'overview') {
      return JSON.stringify({ summary: 'Codex overview.', goal: 'Ship clean parser.', achievement: 'Added parser tests.' });
    }
    return JSON.stringify({ summary: 'Codex project summary.', examples: [{ task: 'Refactor parser', basis: 'Unit tests' }] });
  }, (input) => {
    if (input.git) return {};
    return { projects };
  }, {
    cloudScanResult: () => ({
      providers: [
        { id: 'claude', label: 'Claude Code', installed: true, connected: false, status: 'signed-out', planLabel: '', reason: 'Not signed in', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'codex', label: 'Codex', installed: true, connected: codexConnected, status: codexConnected ? 'connected' : 'signed-out', planLabel: 'ChatGPT Plus', reason: '', supportsEffort: true, efforts: ['low', 'medium', 'high'],
          loginLaunch: { command: 'codex', args: ['login'] } }
      ],
      modelsByProvider: {
        codex: [
          { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', tier: 'fast' },
          { id: 'gpt-5.4', label: 'gpt-5.4', tier: 'balanced' }
        ]
      },
      calibrations: {
        codex: {
          source: 'calibrated',
          fiveHour: { median: 70000, p25: 40000, p75: 105000, count: 4 },
          sevenDay: { median: 650000, p25: 400000, p75: 1000000, count: 3 }
        }
      },
      liveQuotas: {
        codex: {
          fiveHour: { pct: 10, resetsAt: Date.now() / 1000 + 3600, seenAt: Date.now() },
          sevenDay: { pct: 25, resetsAt: Date.now() / 1000 + 86400, seenAt: Date.now() }
        }
      }
    })
  });

  host.activate({ subscriptions: [] });
  provider.resolveWebviewView({
    webview: { onDidReceiveMessage(fn) { receive = fn; }, postMessage: (m) => posts.push(m) },
    onDidChangeVisibility() {}, onDidDispose(fn) { disposeView = fn; }
  });
  t.after(() => { disposeView(); host.deactivate(); });

  await receive({ cmd: 'ready' });
  await receive({ cmd: 'cloudScan' });
  await receive({ cmd: 'cloudPickProvider', provider: 'codex' });
  await receive({ cmd: 'cloudPickModel', provider: 'codex', role: 'project', model: 'gpt-5.4-mini', changeId: 9 });
  assert.equal(posts.at(-1).changeId, 9);
  await receive({ cmd: 'cloudPickModel', provider: 'codex', role: 'project', model: 'undiscovered', changeId: 10 });
  assert.equal(posts.at(-1).d.models.project.model, 'gpt-5.4-mini');
  await receive({ cmd: 'cloudPickEffort', provider: 'codex', role: 'overview', effort: 'high' });
  await receive({ cmd: 'cloudSignIn', provider: 'codex' });
  assert.equal(terminals.length, 0);

  await receive({ cmd: 'estimateReport', provider: 'codex', projects: ['alpha'], requestId: 11 });
  assert.equal(posts.at(-1).requestId, 11);
  assert.equal(posts.at(-1).d.requests, 2);
  await receive({ cmd: 'estimateReport', provider: 'codex', projects: [], requestId: 12 });
  assert.deepEqual(posts.at(-1), { type: 'estimate', requestId: 12, d: null });

  await receive({ cmd: 'create', projects: ['alpha'] });
  assert.deepEqual(errors, []);
  assert.equal(cloudRequests.length, 2);
  assert.ok(cloudRequests.every((r) => r.provider === 'codex'));
  assert.equal(cloudRequests[0].model, 'gpt-5.4-mini');

  const createModal = modals.find((m) => /^Create the /.test(m.message));
  assert.ok(createModal, 'confirmation modal shown');
  assert.match(createModal.message, /with Codex\?/);
  assert.match(createModal.detail, /through your Codex\./);
  assert.match(createModal.detail, /5-hour/i);
  assert.match(createModal.detail, /%/);
  assert.doesNotMatch(createModal.detail, /\$|USD/i);

  const saved = listReports(home);
  assert.equal(saved.length, 1);
  const run = loadRun(home, saved[0].month, saved[0].run);
  assert.equal(run.metadata.provider, 'cloud');
  assert.equal(run.metadata.cloudProvider, 'codex');
  assert.equal(run.metadata.planLabel, 'ChatGPT Plus');
  assert.ok(run.metadata.estimatedQuota);
  assert.equal(run.metadata.estimatedQuota.confidence, 'calibrated');
  codexConnected = false;
  await receive({ cmd: 'cloudScan' });
  await receive({ cmd: 'cloudSignIn', provider: 'codex' });
  assert.equal(terminals[0].shellPath, 'codex');
  assert.deepEqual(terminals[0].shellArgs, ['login']);
  await receive({ cmd: 'create', projects: ['alpha'] });
  assert.match(errors.at(-1), /Connect Codex/);
  assert.equal(cloudRequests.length, 2, 'a signed-out hook cannot dispatch a request');
});
