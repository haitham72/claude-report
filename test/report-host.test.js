'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listReports, loadRun, saveRun } = require('../src/report-store');

function loadHost(vscode, home, runClaude, workerResult = () => ({ projects: [] })) {
  const file = require.resolve('../extension');
  const load = Module._load;
  const previousHome = process.env.CLAUDE_REPORT_HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const inputs = {
    vscode,
    os: { ...os, homedir: () => home },
    worker_threads: { Worker: class extends EventEmitter {
      constructor(_file, { workerData }) {
        super();
        queueMicrotask(() => this.emit('message', workerResult(workerData)));
      }
    } },
    './src/claude': { ...require('../src/claude'), runClaude },
    './src/install': { ...require('../src/install'), migrateLegacy() {} },
    './src/live': { readLive: () => null, readHistory: () => [] },
    './src/sessions': { listSessions: () => [] },
    './src/transcript-live': { readTranscriptLive: () => null },
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
      async showWarningMessage(message, { detail }, action) {
        if (/^Create the /.test(message)) return action;
        if (message === 'Run separate Deep prompting review?') {
          assert.match(detail, /Alpha · 1 messages/);
          assert.match(detail, /Beta · 1 messages/);
          assert.match(detail, /Project reviewer: haiku.*Final synthesis: opus/);
          return action;
        }
        assert.equal(message, 'Enhance this saved report?');
        assert.match(detail, /Projects: Alpha\n/);
        assert.match(detail, /through Claude Code/);
        return action;
      },
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

  await manage(edited, 'Enhance report', 'Selected projects', ['Alpha'], 'Cloud', 'sonnet', 'high');
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
