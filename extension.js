'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const { readLive, SHARED_USAGE } = require('./src/live');
const { getUsage, lastUsageRoute } = require('./src/plan-usage');
const { SOURCES, labelOf, productList } = require('./src/sources');
const { detectHost, defaultSource } = require('./src/host');
const { readPlanHistory } = require('./src/plan-history');
const { planInstall, applyInstall, applyUninstall, installRuntime, migrateLegacy, isConnected, isWired, hookPathOf, pruneRuntimes } = require('./src/install');
const { writeFileAtomic } = require('./src/atomic');
const { runClaude, MODELS, EFFORTS } = require('./src/claude');
const { generateReports, expandedProjectWords } = require('./src/generate');
const { buildData, renderHtml, renderDocument, withExampleHours } = require('./src/render');
const { wrapForWebview } = require('./src/webview');
const { accountUsername } = require('./src/user');
const { buildEntry, buildDeepEntry, generateOverview } = require('./src/overview');
const { buildPanelHtml, buildMetricsData } = require('./src/panel');
const { statusItems, MAX_ITEMS } = require('./src/statusbar');
const { readTranscriptLive } = require('./src/transcript-live');
const { mergeLive } = require('./src/live-merge');
const { listSessions, ageLabel, groupOf, isUuid } = require('./src/sessions');
const { resumeTarget } = require('./src/resume');
const { prepareLocal, thinkingSetting, modelInfo } = require('./src/local-report');
const { startEngine } = require('./src/local-models');
const { pickModel, fitAdvice, fittingModels } = require('./src/local-fit');
const { reportDir: storedReportDir, saveRun, loadRun, listReports, recordReportExport } = require('./src/report-store');
const { createReportManager } = require('./src/report-management');
const { editProject } = require('./src/report-editor');
const { projectKey, labelProjects, captureEvidence, reviseProjects, reportsByProject, matchLegacyProject } = require('./src/report-revision');
const { reportRuntime, formatDuration } = require('./src/report-runtime');
const { applyTimeEvidence } = require('./src/time-evidence');
const { EFFORTS: DEEP_EFFORTS, SCOPE: DEEP_SCOPE, budgetFor, prepareReview } = require('./src/deep-review');
const { reviewCache, selectInlineFiles, planProjectReview, runProjectReview } = require('./src/deep-stages');
const { requestBudget, mapLimit, plannedRequests, DEEP_CONCURRENCY } = require('./src/request-budget');
const { readPrefs, writePref } = require('./src/prefs');
const { exportReport, buildMessage, defaultBody } = require('./src/export');
const { mailtoUrl } = require('./src/mail');
const { lastDaysRange, dayList, dayKey, projectNameOf, scrubDeep } = require('./src/scan');
const { localDay, readDateRange, dateRangeLabel, reportBounds } = require('./src/report-window');
const pkg = require('./package.json');

const HOME_DIR = process.env.CLAUDE_REPORT_HOME || path.join(os.homedir(), '.claude-report');
// One runtime folder per version: editors running different builds never overwrite each other's hook.
const RUNTIME_HOOK = path.join(HOME_DIR, 'runtime', pkg.version, 'bin', 'hook.js');
// Claude Code honours CLAUDE_CONFIG_DIR; so do we, which also keeps tests away from the real settings.json.
const CLAUDE_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const STATUS_REFRESH_MS = 15000;
const SCAN_MAX_AGE_MS = 120000;
const WINDOW_DAYS = 30;
const MIN_PROMPTS = 1; // any project with prompts can be reported
const COMMANDS = { open: 'claudeReport.openMetrics', connect: 'claudeReport.installHook' };

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (month) => { const [y, m] = month.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }); };
const workspaceCwd = () => {
  const f = vscode.workspace.workspaceFolders;
  return f && f[0] ? f[0].uri.fsPath : undefined;
};

// --- scanning, off the extension host thread --------------------------------

const scans = {};

function runWorker(file, workerData, signal, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(path.join(__dirname, 'src', file), { workerData });
    let timer;
    const finish = (callback, result) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(result);
    };
    const abort = () => {
      finish(reject, signal.reason);
      worker.terminate().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    // A locked or huge database must not leave the caller waiting for ever.
    if (timeoutMs > 0) timer = setTimeout(() => { finish(reject, new Error(file + ' timed out after ' + Math.round(timeoutMs / 1000) + ' s')); worker.terminate().catch(() => {}); }, timeoutMs);
    worker.once('message', (result) => finish(resolve, result));
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => finish(reject, new Error(file + ' exited without a result (' + code + ')')));
  });
}

const scanJobs = new Map();
const SCAN_TIMEOUT_MS = 120000;

// key 'month:YYYY-MM' for a calendar month, 'days' for the rolling Metrics window.
async function getScan(key, maxAgeMs = SCAN_MAX_AGE_MS, input = key === 'days' ? { days: WINDOW_DAYS } : { month: key.slice(6) }) {
  const hit = scans[key];
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.scan;
  if (!scanJobs.has(key)) {
    const job = runWorker('scan-worker.js', input, undefined, SCAN_TIMEOUT_MS).then((scan) => {
      scans[key] = { at: Date.now(), scan };
      return scan;
    }).finally(() => scanJobs.delete(key));
    scanJobs.set(key, job);
  }
  return scanJobs.get(key);
}

// --- saved reports -----------------------------------------------------------

const reportDir = (month, run = '') => storedReportDir(HOME_DIR, month, run);

function openReport(month, run = '') {
  try {
    const dir = reportDir(month, run);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    const html = renderHtml(data);
    const panel = vscode.window.createWebviewPanel('claudeReportReport', `AI report ${month}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = wrapForWebview(html);
  } catch {
    vscode.window.showErrorMessage('Claude Report: that report could not be opened.');
  }
}

// --- live numbers ------------------------------------------------------------

// Model and context from transcripts (every IDE). Plan 5h/7d come from several routes:
// OAuth usage poll and shared cache (via plan-usage), status-line hook snapshots, and windows.json.
// Newest reading wins inside readLive.
function planUsageEnabled() {
  try { return vscode.workspace.getConfiguration('claudeReport').get('planUsage.enabled') !== false; }
  catch { return true; }
}

function refreshPlanUsageAsync() {
  return new Promise((resolve) => {
    if (!planUsageEnabled()) return resolve();
    getUsage(() => resolve(), { historyDir: HOME_DIR, sharedFile: SHARED_USAGE, enabled: true });
  });
}

function currentLive() {
  const cwd = workspaceCwd();
  return mergeLive({ hook: readLive({ cwd, dir: HOME_DIR, sharedFile: SHARED_USAGE }), transcript: readTranscriptLive({ cwd }) });
}

// --- bottom status bar -------------------------------------------------------

// Where the extension writes what it is doing, so a missing status bar can be diagnosed.
let channel = null;
function log(message) {
  try { if (channel) channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`); } catch { /* logging must never break anything */ }
}

let lastShown = '';

function paintStatus(slots) {
  let items;
  try {
    items = statusItems(currentLive(), COMMANDS);
  } catch (e) {
    log(`status bar: could not read live numbers: ${e && e.stack ? e.stack : e}`);
    return;
  }
  const shown = items.map((i) => i.text).join(' | ');
  if (shown !== lastShown) { lastShown = shown; log(`status bar shows: ${shown}`); }
  slots.forEach((slot, i) => {
    const it = items[i];
    if (!it) { slot.hide(); return; }
    slot.text = it.text;
    slot.color = it.color;
    slot.command = it.command;
    slot.tooltip = it.tooltip;
    slot.show();
  });
}

// Tries memory → shared cache → OAuth API → stale cache. Sync routes paint immediately;
// the OAuth route paints again when the response lands.
function refreshStatus(slots) {
  paintStatus(slots);
  if (!planUsageEnabled()) return;
  getUsage(() => paintStatus(slots), { historyDir: HOME_DIR, sharedFile: SHARED_USAGE, enabled: true });
}

// Writes the state of every live source to the Claude Report output panel and shows it.
function diagnose() {
  const cwd = workspaceCwd();
  const enabled = planUsageEnabled();
  getUsage((data, state, meta) => {
    const hook = readLive({ cwd, dir: HOME_DIR, sharedFile: SHARED_USAGE });
    const transcript = readTranscriptLive({ cwd });
    const merged = currentLive();
    const items = statusItems(merged, COMMANDS);
    log('--- diagnostics ---');
    log(`workspace: ${cwd || 'none'}`);
    log(`plan usage setting: ${enabled ? 'on' : 'off'}`);
    log(`plan usage route: ${meta && meta.route ? meta.route : lastUsageRoute()} (${state})${data ? ` five_hour=${data.five_hour && data.five_hour.utilization} seven_day=${data.seven_day && data.seven_day.utilization}` : ''}`);
    log(`hook/shared reading: ${hook ? JSON.stringify(hook) : 'none (no status-line or shared usage yet)'}`);
    log(`transcript reading: ${transcript ? JSON.stringify(transcript) : 'none (no recent Claude Code session found)'}`);
    log(`status bar would show: ${items.map((i) => i.text).join(' | ')}`);
    log('If you still see nothing, right-click the status bar and check that Claude Report is ticked.');
    if (channel) channel.show(true);
  }, { historyDir: HOME_DIR, sharedFile: SHARED_USAGE, enabled });
}

// The chained status line is a program that may have been uninstalled since.
function savedChain() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'config.json'), 'utf8')).chain || null;
  } catch {
    return null;
  }
}

function chainMissing() {
  const chain = savedChain();
  if (!chain) return false;
  const m = /^\s*"([^"]+)"|^\s*(\S+)/.exec(chain);
  const exe = m && (m[1] || m[2]);
  return !!exe && /[\\/]/.test(exe) && !fs.existsSync(exe);
}

function dropChain() {
  try {
    const file = path.join(HOME_DIR, 'config.json');
    writeFileAtomic(file, JSON.stringify({ chain: null }, null, 2) + '\n');
    vscode.window.showInformationMessage('Previous status line removed.');
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Report: ${e.message}`);
  }
}

// --- local model (LM Studio or Ollama on this computer) ------------------------

const localConfig = () => {
  const p = readPrefs(HOME_DIR);
  return { enabled: p['local.enabled'] === true, engine: p['local.engine'] === 'ollama' ? 'ollama' : 'lmstudio', model: p['local.model'] || '', thinking: p['local.thinking'] === true };
};

const setLocal = async (key, value) => writePref(HOME_DIR, `local.${key}`, value);

async function inspectLocal(cfg, details, signal, fit = false) {
  const result = await runWorker('local-model-worker.js', { ...cfg, details, fit }, signal);
  if (result.error) throw new Error(result.error);
  return { ...cfg, ...result };
}

const engineName = (engine) => (engine === 'ollama' ? 'Ollama' : 'LM Studio');
const engineRunning = (state, engine) => state.engines.some((item) => item.engine === engine && item.running);

// Opens the engine only because the user asked to (a button click). Never called on its own.
async function openEngine(engine) {
  const name = engineName(engine);
  const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${name}…` },
    () => startEngine(engine));
  if (!ok) vscode.window.showInformationMessage(`Could not reach ${name}; open it, start its local server, and try again.`);
  return ok;
}

// Asks the user to open the server when it is down (never starts it unasked), picks a model when none
// is chosen, and asks before loading a model that does not fit the GPU memory free right now.
// Throws 'cancelled' when the user backs out.
async function resolveLocal(cfg, signal, { ask = true } = {}) {
  let state = await inspectLocal(cfg, false, signal, true);
  while (!engineRunning(state, cfg.engine)) {
    const name = engineName(cfg.engine);
    const open = `Open ${name}`;
    const choice = await vscode.window.showInformationMessage(`${name} is not open yet.`,
      { modal: true }, open, 'Recheck');
    if (choice === open) await openEngine(cfg.engine);
    else if (choice !== 'Recheck') throw new Error('cancelled');
    state = await inspectLocal(cfg, false, signal, true);
  }
  let chosen = pickModel(state.models, cfg.model);
  if (!chosen) throw new Error(cfg.model ? 'The selected model is unavailable on the local server.' : `${engineName(cfg.engine)} has no models. Download one first.`);
  if (!cfg.model) log(`no local model picked; using ${chosen.id}`);
  for (;;) {
    const advice = ask ? fitAdvice(chosen, state.gpu, state.models) : null;
    if (!advice) break;
    const use = advice.alt ? `Use ${advice.alt.id}` : null;
    const choice = await vscode.window.showInformationMessage(advice.message, { modal: true }, ...['Continue', use].filter(Boolean));
    if (choice === 'Continue') break;
    if (choice === use) { chosen = advice.alt; continue; }
    throw new Error('cancelled');
  }
  // Model details (reasoning, native endpoint) were read for the configured model only; read them for the one chosen.
  if (cfg.engine === 'ollama' && chosen.id !== cfg.model) chosen = { ...chosen, ...(await modelInfo({ engine: 'ollama', model: chosen.id }))[0] };
  const alternatives = fittingModels(state.models).map((m) => m.id);
  return { ...cfg, ...chosen, model: chosen.id, alternatives };
}

// --- sessions ---------------------------------------------------------------

function sessionRows() {
  const now = Date.now();
  try {
    return listSessions({ now }).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, project: s.project, active: s.active, status: s.status, age: ageLabel(s.updatedAt, now), group: groupOf(s, now) }));
  } catch (e) {
    log(`sessions: ${e && e.message}`);
    return [];
  }
}

function legacyHook() {
  try {
    const sl = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')).statusLine;
    return !!(sl && typeof sl.command === 'string' && /\.ide-companio/.test(sl.command));
  } catch {
    return false;
  }
}

function claudeTerminal(cwd, text, name) {
  const t = vscode.window.createTerminal({ name: name || 'Claude', cwd: cwd && fs.existsSync(cwd) ? cwd : undefined });
  t.show();
  t.sendText(text);
}

// The Claude Code extension is always used when it is installed. The terminal command is only the
// fallback for an editor without it, and for resuming a session the panel cannot find (see resume.js).
const claudeExtension = () => !!(vscode.extensions && vscode.extensions.getExtension && vscode.extensions.getExtension('anthropic.claude-code'));

async function openInClaudeExtension(commands, ...args) {
  for (const command of commands) {
    try {
      await vscode.commands.executeCommand(command, ...args);
      return true;
    } catch (e) {
      log(`${command}: ${e && e.message}`);
    }
  }
  return false;
}

// A session from the open folder resumes in the Claude Code panel, the same command its own list uses.
// A session from another folder resumes in a terminal started in that folder, from any editor.
async function resumeSession(id, cwd, title) {
  if (!isUuid(id)) return;
  const target = resumeTarget({ here: workspaceCwd(), cwd });
  if (target.via === 'panel' && claudeExtension()) {
    if (await openInClaudeExtension(['claude-vscode.primaryEditor.open'], id)) return;
    vscode.window.showInformationMessage('Open this session from the Claude Code panel instead.');
    return;
  }
  if (target.missing) vscode.window.showWarningMessage('The folder this session ran in no longer exists, so it may not be found from here.');
  claudeTerminal(target.cwd, `claude --resume ${id}`, title ? `Claude: ${String(title).slice(0, 40)}` : 'Claude');
}

// New session: the Claude Code extension when it is installed, never the CLI in that case.
async function newSession() {
  if (claudeExtension()) {
    // newConversation only tells an already open Claude Code panel to start over, so on its own it does nothing when no
    // panel is open. primaryEditor.open always creates a fresh conversation (it is what the extension's own link handler calls).
    const opened = await openInClaudeExtension(['claude-vscode.primaryEditor.open', 'claude-vscode.editor.open', 'claude-vscode.sidebar.open']);
    if (!opened) vscode.window.showInformationMessage('Start a new session from the Claude Code panel instead.');
    return;
  }
  claudeTerminal(workspaceCwd(), 'claude');
}

// --- exporting a finished report -------------------------------------------

const EXPORT_KEYS = ['save', 'outlook', 'format', 'to', 'folder', 'estimateTime', 'depth', 'deepEffort'];
const REPORT_CHOICE_KEYS = ['estimateTime', 'depth', 'deepEffort'];

function exportOptions() {
  const c = vscode.workspace.getConfiguration('claudeReport');
  const prefs = readPrefs(HOME_DIR);
  const folder = c.get('export.folder') || '';
  const choice = (key) => prefs['report.' + key] ?? c.get('export.' + key);
  const effort = choice('deepEffort');
  return {
    save: c.get('export.save') !== false,
    outlook: c.get('export.outlook') === true,
    estimateTime: choice('estimateTime') === true,
    depth: choice('depth') === 'deep' ? 'deep' : 'quick',
    deepEffort: DEEP_EFFORTS.includes(effort) ? effort : 'medium',
    dateRange: readDateRange(prefs['report.dateRange']),
    format: c.get('export.format') === 'pdf' ? 'pdf' : 'html',
    to: c.get('export.to') || '',
    folder,
    folderLabel: folder ? path.basename(folder) || folder : 'Downloads/Reports',
    subject: c.get('export.subject') || '',
    body: c.get('export.body') || ''
  };
}

async function setExportOption(key, value) {
  if (!EXPORT_KEYS.includes(key)) return;
  if (key === 'depth' && !['quick', 'deep'].includes(value)) return;
  if (key === 'deepEffort' && !DEEP_EFFORTS.includes(value)) return;
  if (REPORT_CHOICE_KEYS.includes(key)) {
    writePref(HOME_DIR, 'report.' + key, key === 'estimateTime' ? value === true : value);
    return;
  }
  await vscode.workspace.getConfiguration('claudeReport').update(`export.${key}`, value, vscode.ConfigurationTarget.Global);
}

async function chooseReportRange() {
  const current = exportOptions().dateRange;
  const today = dayKey(new Date());
  const validateDate = (value) => !localDay(value) ? 'Use YYYY-MM-DD.' :
    value > today ? 'Choose today or an earlier date.' : undefined;
  const from = await vscode.window.showInputBox({
    title: 'Start date', prompt: 'First day to include (YYYY-MM-DD)', value: current?.from || today.slice(0, 7) + '-01',
    validateInput: validateDate
  });
  if (from === undefined || validateDate(from)) return false;
  const validateEnd = (value) => validateDate(value) || (value < from ? 'End date must be on or after the start date.' : undefined);
  const to = await vscode.window.showInputBox({
    title: 'End date', prompt: 'Last day to include (YYYY-MM-DD)', value: current?.to >= from ? current.to : today,
    validateInput: validateEnd
  });
  if (to === undefined || validateEnd(to)) return false;
  writePref(HOME_DIR, 'report.dateRange', { from, to });
  return true;
}

async function pickExportFolder() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Save reports here' });
  if (picked && picked[0]) await setExportOption('folder', picked[0].fsPath);
}

// Saves or drafts a report according to the configured export options.
const exportsInProgress = new Set();

async function runExport(month, run = '', { manual = false } = {}) {
  const key = month + '/' + run;
  if (exportsInProgress.has(key)) {
    vscode.window.showInformationMessage('This report is already being exported.');
    return;
  }
  exportsInProgress.add(key);
  try {
    await exportSavedReport(month, run, manual);
  } finally {
    exportsInProgress.delete(key);
  }
}

async function exportSavedReport(month, run, manual) {
  const options = exportOptions();
  if (manual) options.save = true;
  if (!options.save && !options.outlook) return;
  let data, dir;
  try {
    dir = reportDir(month, run);
    data = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  } catch {
    vscode.window.showErrorMessage('Claude Report: that report could not be found.');
    return;
  }
  const started = Date.now();
  // Up to three projects: name the file after them, not the person.
  const names = (data.projects || []).map((p) => p.name).filter(Boolean);
  const res = await exportReport({ month, label: data.label, user: names.length && names.length <= 3 ? names.join(' ') : data.user, overview: data.overview, htmlPath: path.join(dir, 'report.html'), htmlContent: renderDocument(data), options, home: dir, run });
  log('export ' + (run || month) + ' finished in ' + formatDuration(Math.max(0, Date.now() - started)));
  (res.notes || []).forEach((n) => log(`export: ${n}`));

  if (res.saved) {
    try { recordReportExport(HOME_DIR, month, run, res.saved); }
    catch (error) { log('export history not updated: ' + error.message); vscode.window.showWarningMessage('Report exported, but it could not be added to your export list.'); }
    void vscode.window.showInformationMessage(`Saved a copy to ${res.saved}`, 'Show in folder').then((choice) => {
      if (choice) return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.saved));
    });
  } else if (options.save) {
    void vscode.window.showWarningMessage('Could not save a copy of the report.', 'Show log').then((choice) => { if (choice && channel) channel.show(true); });
  }
  if (options.outlook && res.mail && res.mail.ok === false) {
    // Outlook could not attach by itself: open a plain draft and show the file to drag in.
    const subject = buildMessage({ template: options.subject || 'AI report, {label}, {user}', month, label: data.label, user: data.user, overview: data.overview });
    const body = options.body ? buildMessage({ template: options.body, month, label: data.label, user: data.user, overview: data.overview }) : defaultBody({ label: data.label, user: data.user, overview: data.overview });
    vscode.env.openExternal(vscode.Uri.parse(mailtoUrl({ to: options.to, subject, body })));
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.attachment));
    vscode.window.showInformationMessage('Email draft opened; drag the selected file in to attach it.');
  }
}

// --- the sidebar -------------------------------------------------------------

class Panel {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.stateRequest = 0;
    this.localRequest = 0;
    this.lastScan = null;
    this.reportProgress = [];
    this.reportManager = createReportManager({
      vscode, home: HOME_DIR, openReport, runExport: (month, run) => runExport(month, run, { manual: true }),
      isExporting: (month, run) => exportsInProgress.has(month + '/' + run),
      editReport: (month, run, record) => editSavedReport(this, month, run, record),
      enhanceReport: (month, run, record, options) => enhanceReport(this, month, run, record, options),
      deepReport: (month, run, record, options) => deepReport(this, month, run, record, options),
      showRuntime, compareReport, refresh: () => this.push(false)
    });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = wrapForWebview(buildPanelHtml());
    // A failed write (e.g. settings.json locked by another program) is shown, never an unhandled rejection.
    view.webview.onDidReceiveMessage((m) => this.onMessage(m || {}).catch((e) => {
      log(`panel ${m && m.cmd}: ${e && e.message}`);
      vscode.window.showErrorMessage(`Claude Report: ${e && e.message}`);
    }));
    view.onDidChangeVisibility(() => { if (view.visible) this.push(false); });
    this.poll = setInterval(() => { if (this.view && this.view.visible) this.push(false); }, 15000);
    if (this.poll.unref) this.poll.unref();
    view.onDidDispose(() => { this.view = null; clearInterval(this.poll); });
  }

  post(m) {
    if (m.type === 'runStart') this.reportProgress = [];
    if (['runStart', 'stage', 'progress', 'running'].includes(m.type)) this.reportProgress.push(m);
    if (this.view) this.view.webview.postMessage(m);
  }

  // Draws the page again from the files on disk. A new nonce makes the editor treat it as new content.
  reset() {
    if (!this.view) return;
    this.forceNext = true;
    this.view.webview.html = wrapForWebview(buildPanelHtml());
  }

  async onMessage(m) {
    if (m.cmd === 'ready') {
      const f = this.forceNext;
      this.forceNext = false;
      if (activeReport && this.reportProgress.length) this.post({ type: 'tab', tab: 'report' });
      for (const event of this.reportProgress) this.view?.webview.postMessage(event);
      return this.push(f);
    }
    if (m.cmd === 'refresh') return this.reloadAll ? this.reloadAll() : this.push(true);
    if (m.cmd === 'create') return createReport(this, Array.isArray(m.projects) ? m.projects : undefined);
    if (m.cmd === 'manage') return this.reportManager.manage(m.month, m.run || '');
    if (m.cmd === 'retryFailed') {
      try {
        const record = loadRun(HOME_DIR, m.month, m.run || '');
        if (record.data.reviewFailures?.length) return await deepReport(this, m.month, m.run || '', record, { failedOnly: true });
        return await enhanceReport(this, m.month, m.run || '', record, { failedOnly: true });
      }
      catch (error) { return vscode.window.showErrorMessage('Claude Report: ' + error.message); }
    }
    if (m.cmd === 'archivedReports') return this.reportManager.archivedReports();
    if (m.cmd === 'cancelReport') return activeReport?.abort();
    if (m.cmd === 'resume') return resumeSession(m.id, m.cwd, m.title);
    if (m.cmd === 'dropChain') { dropChain(); return this.push(false); }
    if (m.cmd === 'newSession') return newSession();
    if (m.cmd === 'localScan') return this.scanLocal();
    if (m.cmd === 'openEngine') { await openEngine(localConfig().engine); return this.scanLocal(); }
    if (m.cmd === 'localThinking') { await setLocal('thinking', m.enabled === true); return this.scanLocal(); }
    if (m.cmd === 'localEngine') { await setLocal('engine', m.engine === 'ollama' ? 'ollama' : 'lmstudio'); await setLocal('model', ''); return this.scanLocal(); }
    if (m.cmd === 'localPick') { await setLocal('model', String(m.model || '')); return this.scanLocal(); }
    if (m.cmd === 'localMode') { await setLocal('enabled', m.mode === 'local'); return this.scanLocal(); }
    if (m.cmd === 'test') return testHook(this);
    // The folder comes from the host's own dialog, never from the webview.
    if (m.cmd === 'opt') { if (m.key !== 'folder') await setExportOption(m.key, m.value); return this.push(false); }
    if (m.cmd === 'reportRange') {
      if (m.mode === 'month') writePref(HOME_DIR, 'report.dateRange', null);
      else if (m.mode !== 'custom' || !await chooseReportRange()) return;
      return this.push(false);
    }
    if (m.cmd === 'pickFolder') { await pickExportFolder(); return this.push(false); }
    if (m.cmd === 'export') return runExport(m.month, m.run || '', { manual: true });
    if (m.cmd === 'open') return openReport(m.month, m.run || '');
    if (m.cmd === 'connect') { await installHook(this.context); return this.push(false); }
    if (m.cmd === 'disconnect') { await uninstallHook(); return this.push(false); }
  }

  state() {
    const cfg = vscode.workspace.getConfiguration('claudeReport');
    const local = localConfig();
    const output = exportOptions();
    let connected = false;
    // Connected means the setting points at us AND the file it runs exists; otherwise the panel waits forever.
    try { connected = isConnected(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'))); } catch { /* not readable means not connected */ }
    const history = listReports(HOME_DIR, { includeArchived: true });
    return {
      version: `v${pkg.version}`,
      connected,
      monthLabel: output.dateRange ? dateRangeLabel(output.dateRange) : monthLabel(monthKey()),
      models: { project: local.enabled ? `${local.model || 'local model'} · local` : `${cfg.get('reportModel')} · ${cfg.get('reportEffort')}`, final: local.enabled ? 'local model' : `${cfg.get('finalizerModel')} · ${cfg.get('finalizerEffort')}`, local: local.enabled },
      export: output,
      sessions: sessionRows(),
      openProject: workspaceCwd() ? projectNameOf(workspaceCwd()) : null,
      hookLegacy: legacyHook(),
      localPrefs: local,
      cloud: { project: `${cfg.get('reportModel')} · ${cfg.get('reportEffort')}`, final: `${cfg.get('finalizerModel')} · ${cfg.get('finalizerEffort')}` },
      chainMissing: chainMissing(),
      reports: history.filter((r) => !r.archived).map(({ month, run, label, projects, partial, metadata }) => ({
        month, run, label, projects, partial, durationMs: metadata?.durationMs, parentRun: metadata?.parentRun,
        depth: metadata?.deepPlan ? 'Deep' : undefined
      })),
      archivedReportCount: history.filter((r) => r.archived).length,
      live: currentLive(),
      planHistory: readPlanHistory({ dir: HOME_DIR, controlFile: path.join(path.dirname(CLAUDE_SETTINGS), 'cursor-claude-control', 'usage-history.json') })
    };
  }

  async scanLocal() {
    const request = ++this.localRequest;
    const cfg = localConfig();
    const update = (d) => { if (request === this.localRequest) this.post({ type: 'local', d }); };
    const empty = { ...cfg, gpu: null, engines: [], models: [] };
    update({ ...empty, checking: cfg.enabled });
    if (!cfg.enabled) return;
    try {
      update(await inspectLocal(cfg, true));
    } catch (error) {
      log('local models: ' + error.message);
      update({ ...empty, error: 'Could not check the local server.' });
    }
  }

  async push(force) {
    const request = ++this.stateRequest;
    await refreshPlanUsageAsync();
    if (request !== this.stateRequest) return;
    const base = this.state();
    if (this.lastScan?.monthLabel === base.monthLabel) Object.assign(base, this.lastScan);
    this.post({ type: 'state', d: { ...base } });
    try {
      const dateRange = base.export.dateRange;
      const month = dateRange ? dateRange.to.slice(0, 7) : monthKey();
      const key = dateRange ? `range:${dateRange.from}/${dateRange.to}` : `month:${month}`;
      const maxAge = force ? 0 : SCAN_MAX_AGE_MS;
      const [scan, monthScan] = await Promise.all([getScan('days', maxAge), getScan(key, maxAge, { month, dateRange })]);
      base.reportProjects = labelProjects(monthScan.projects).filter((p) => p.promptCount > 0)
        .map((p) => ({ id: p.id, name: p.name, hint: p.name === p.baseName ? undefined : p.location,
          prompts: p.promptCount, tokens: p.totalTokens, eligible: p.promptCount >= MIN_PROMPTS }));
      const { from, to } = lastDaysRange(WINDOW_DAYS);
      const cwd = workspaceCwd();
      const metrics = {
        days: dayList(from, to),
        openProject: cwd ? projectNameOf(cwd) : null
      };
      base.metrics = buildMetricsData({ ...metrics, projects: scan.projects });
      const plan = new Set(SOURCES.filter((s) => s.plan).map((s) => s.id));
      base.metricSources = Object.entries(scan.sources || {}).map(([id, projects]) => ({
        id, label: labelOf(id), plan: plan.has(id),
        metrics: buildMetricsData({
          ...metrics, projects,
          showUsageTrend: plan.has(id)
        })
      }));
      // The tab opened first until the user picks one: the editor's own agent, else Claude.
      base.defaultSource = defaultSource(detectHost(vscode.env && vscode.env.appName),
        base.metricSources.map((s) => s.id), { claudeInstalled: claudeExtension() });
    } catch (e) {
      base.metrics = null;
      base.error = String(e.message);
    }
    if (request !== this.stateRequest) return;
    this.lastScan = { monthLabel: base.monthLabel, metrics: base.metrics, metricSources: base.metricSources, defaultSource: base.defaultSource, reportProjects: base.reportProjects };
    this.post({ type: 'state', d: base });
  }
}

// --- commands ----------------------------------------------------------------

// The absolute node the status line will run with, so it does not depend on Claude Code's shell PATH.
function resolveNode() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function installHook(context) {
  const nodePath = resolveNode();
  if (!nodePath) {
    vscode.window.showErrorMessage('Node.js is required to connect Claude Code; install it and try again.');
    return;
  }
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { /* applyInstall reports unreadable files */ }
  const plan = planInstall(settings, RUNTIME_HOOK, nodePath);
  if (plan.error) { vscode.window.showErrorMessage(`Claude Report: ${plan.error}`); return; }
  if (plan.already) {
    // settings.json can point at us while the runtime copy is gone; Connect must still repair it.
    try {
      installRuntime(context.extensionPath, HOME_DIR);
      vscode.window.showInformationMessage('Claude Code is already connected.');
    } catch (e) {
      log(`could not write ${RUNTIME_HOOK}: ${e.message}`);
      vscode.window.showErrorMessage('Could not update the Claude Code hook files.');
    }
    return;
  }

  log('connect: ' + plan.changes.join('; '));
  const ok = await vscode.window.showInformationMessage(
    'Connect Claude Code to show live plan usage? Your settings are backed up first.',
    { modal: true }, 'Connect');
  if (ok !== 'Connect') return;
  try {
    const hookPath = installRuntime(context.extensionPath, HOME_DIR);
    applyInstall({ settingsPath: CLAUDE_SETTINGS, hookPath, nodePath, configDir: HOME_DIR });
    vscode.window.showInformationMessage('Connected. Status appears after the next Claude Code response.');
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Report: ${e.message}`);
  }
}

async function uninstallHook() {
  try {
    const res = applyUninstall({ settingsPath: CLAUDE_SETTINGS, configDir: HOME_DIR });
    vscode.window.showInformationMessage(res && res.note ? "Claude Code wasn't connected to Claude Report." : 'Disconnected. Your previous status line is back.');
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Report: ${e.message}`);
  }
}

// Runs the exact command stored in settings.json with a sample status line, the way Claude Code would.
function testHook(panel) {
  const lines = [];
  let ok = false;
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    const command = settings.statusLine && settings.statusLine.command;
    if (!command) throw new Error('settings.json has no status line command');
    const sample = JSON.stringify({ session_id: 'selftest', cwd: HOME_DIR, model: { display_name: 'Test' }, context_window: { used_percentage: 12 } });
    const started = Date.now();
    const r = spawnSync(command, { shell: true, input: sample, encoding: 'utf8', timeout: 5000, windowsHide: true });
    lines.push(`The command ran in ${Date.now() - started} ms (exit ${r.status}).`);
    lines.push(`It printed: ${String(r.stdout || '').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 80) || 'nothing'}`);
    // The saved command may still be the old Companio copy, which writes to the old folder.
    const snaps = [path.join(HOME_DIR, 'live', 'selftest.json'), path.join(os.homedir(), '.ide-companio', 'live', 'selftest.json')];
    const wrote = snaps.some((p) => fs.existsSync(p));
    snaps.forEach((p) => { try { fs.unlinkSync(p); } catch { /* removed or never written */ } });
    if (/\.ide-companio/.test(command)) lines.push('This still runs the old Companio copy. Press Update the hook.');
    lines.push(wrote ? 'It saved a reading: yes.' : 'It saved a reading: no. Check the Node path in the command.');
    ok = r.status === 0 && wrote;
    lines.push(ok ? 'The hook works. Now send a message in Claude Code: if Last reading never changes, your Claude Code is not running status lines.' : 'The hook failed.');
  } catch (e) {
    lines.push(e.message);
  }
  panel.post({ type: 'test', ok, lines });
}

let activeReport;

async function runReportTask(panel, operation, work) {
  if (activeReport) {
    vscode.window.showInformationMessage('A report is already being written.');
    return;
  }
  const controller = new AbortController();
  activeReport = controller;
  const runtime = reportRuntime(panel, controller.signal, log, operation);
  try {
    await work(runtime);
  } catch (error) {
    // 'cancelled': the user closed the GPU-memory prompt before a local load.
    if (controller.signal.aborted || error.message === 'cancelled') {
      // Before start() the sidebar still shows the previous run; 'cancelled' would replace its Open report.
      if (runtime.started) runtime.stage('cancelled', 'Report cancelled');
    } else {
      const message = scrubDeep(error.message || String(error));
      runtime.stage('error', message);
      vscode.window.showErrorMessage('Claude Report: ' + message);
    }
  } finally {
    activeReport = undefined;
    if (runtime.started) {
      runtime.event('Finished', runtime.metadata().durationMs);
      panel.post({ type: 'running', on: false });
    }
  }
}

async function createReport(panel, keys) {
  const output = exportOptions();
  const { depth, deepEffort } = output;
  let saved;
  await runReportTask(panel, 'create', async (runtime) => { saved = await writeReport(panel, keys, runtime, output); });
  if (!saved) return;
  if (depth === 'deep') {
    const record = loadRun(HOME_DIR, saved.month, saved.run);
    const deepRun = await deepReport(panel, saved.month, saved.run, record, { effort: deepEffort, finalizeOverview: true });
    if (deepRun) await runExport(saved.month, deepRun);
    return;
  }
  await runExport(saved.month, saved.run);
}

function defaultModels() {
  const cfg = vscode.workspace.getConfiguration('claudeReport');
  return {
    project: { model: cfg.get('reportModel'), effort: cfg.get('reportEffort') },
    overview: { model: cfg.get('finalizerModel'), effort: cfg.get('finalizerEffort') }
  };
}

async function runProjectReports(projects, route, runtime) {
  runtime.signal.throwIfAborted();
  let { project, overview } = route.models;
  let run = runClaude;
  const source = route.local ? 'local' : 'cloud';
  let engine, thinking, context;
  if (route.local) {
    runtime.stage('gathering', 'Preparing local model');
    const target = route.target || await resolveLocal(route.local, runtime.signal);
    runtime.signal.throwIfAborted();
    engine = target.engine;
    thinking = thinkingSetting(target.reasoning, target.thinking);
    project = overview = { model: target.model };
    run = await prepareLocal(target, { signal: runtime.signal });
    context = run.context;
  }
  runtime.event([source, engine, project.model, project.effort, thinking, context && context + ' context tokens'].filter(Boolean).join(' · '));
  run = runtime.model(run);
  runtime.stage('working', 'Writing project reports');
  const maxOutputTokens = route.local ? (context ? Math.min(3600, Math.floor(context * 0.36)) : 2800) : undefined;
  const result = await generateReports({
    projects, run, local: Boolean(route.local), estimateTime: route.estimateTime, concurrency: route.local ? 1 : 3,
    maxOutputTokens,
    localInputChars: context ? Math.max(600, Math.min(48000, (context - maxOutputTokens - 1600) * 3)) : undefined,
    localMaxPrompts: context ? Math.min(60, Math.max(16, Math.floor(context / 256))) : undefined,
    models: { project, finalizer: null }, signal: runtime.signal, onProgress: runtime.progress
  });
  const reports = scrubDeep(result.reports);
  if (route.local) Object.values(reports).forEach((report) => { report.source = 'local'; });
  return { reports, failures: result.failures, run, overview, provider: source, model: project.model, effort: project.effort, engine, thinking, context };
}

async function addGitEvidence(projects, month, cutoff, runtime, dateRange) {
  runtime.stage('gathering', 'Reading Git history');
  const git = await runWorker('scan-worker.js', {
    month, cutoff, dateRange, git: projects.map(({ id, name, repositories }) => ({ id, name, repositories }))
  }, runtime.signal);
  return projects.map((project) => ({ ...project, git: git[projectKey(project)] }));
}

function timeEntries(month, projects, scope = projects) {
  const entries = readPrefs(HOME_DIR)['report.time']?.[month] || {};
  const counts = new Map();
  for (const project of scope) {
    const name = project.baseName || project.name;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Object.fromEntries(projects.map((project) => {
    const name = project.baseName || project.name;
    const key = projectKey(project);
    return [key, entries[key] ?? (counts.get(name) === 1 ? entries[name] : undefined)];
  }));
}

async function writeReport(panel, keys, runtime, { dateRange, estimateTime, depth, deepEffort }) {
  const month = dateRange ? dateRange.to.slice(0, 7) : monthKey();
  const cutoff = reportBounds(month, dateRange).to.toISOString();
  const label = dateRange ? dateRangeLabel(dateRange) : month;
  const scanStarted = Date.now();
  const scan = await runWorker('scan-worker.js', { month, cutoff, dateRange }, runtime.signal);
  const scanDuration = Math.max(0, Date.now() - scanStarted);
  let eligible = labelProjects(scan.projects).filter((p) => p.promptCount >= MIN_PROMPTS);
  if (!eligible.length) {
    vscode.window.showInformationMessage('Not enough prompts in the selected dates.');
    return;
  }
  if (keys) {
    eligible = eligible.filter((p) => keys.includes(projectKey(p)));
  } else {
    // Started from the command palette: pick the projects here.
    const picked = await vscode.window.showQuickPick(
      eligible.map((p) => ({ label: p.name, description: `${p.promptCount} prompts`,
        detail: p.name === p.baseName ? undefined : p.location, picked: true, project: p })),
      { canPickMany: true, title: 'Projects for the report' });
    if (!picked) return;
    eligible = picked.map((x) => x.project);
  }
  if (!eligible.length) {
    vscode.window.showInformationMessage('Pick at least one project for the report.');
    return;
  }
  const settings = localConfig();
  const local = settings.enabled ? settings : null;
  const models = defaultModels();
  const where = local ? 'on this computer with ' + engineName(local.engine) : 'with Claude Code';
  const ok = await vscode.window.showInformationMessage(
    'Create the ' + label + ' report for ' + eligible.length + (eligible.length === 1 ? ' project ' : ' projects ') + where + '?',
    local ? { modal: true } : { modal: true, detail: 'Redacted prompts are sent through your Claude Code.' }, 'Create');
  if (ok !== 'Create') return;

  vscode.commands.executeCommand('workbench.view.extension.claudeReport');
  panel.post({ type: 'tab', tab: 'report' });
  runtime.start();
  runtime.event('Preflight activity scan', scanDuration);
  const gitProjects = await addGitEvidence(eligible, month, cutoff, runtime, dateRange);
  const evidence = captureEvidence(gitProjects);
  const projects = gitProjects.map((p, i) => ({ ...p, prompts: evidence[i].prompts }));
  const result = await runProjectReports(projects, { local, models, estimateTime }, runtime);
  if (!Object.keys(result.reports).length) throw new Error('Every project failed. See the project rows and runtime log for details.');

  const user = accountUsername();
  if (!dateRange) applyTimeEvidence(result.reports, timeEntries(month, projects, scan.projects));
  const overview = depth === 'deep' ? null : await writeOverview({ user, month, projects, result, runtime, dateRange });
  if (depth !== 'deep' && !overview) vscode.window.showWarningMessage('The report was saved without the overview cards.');
  const data = buildData({ month, scan: { projects }, reports: result.reports, user, overview, now: new Date(cutoff), dateRange });
  data.failures = result.failures;
  const run = saveGeneratedReport(panel, data, result, runtime, { cutoff, evidenceKind: 'sampled', kind: 'generated', estimateTime,
    ...(depth === 'deep' && { pendingOverview: true }) }, evidence);
  return { month, run };
}

async function writeOverview({ user, month, projects, result, runtime, dateRange }) {
  runtime.stage('overview', 'Writing the report overview');
  const entry = buildEntry({ user, month, projects, reports: result.reports });
  if (dateRange) entry.period = dateRange;
  return scrubDeep(await generateOverview({ entry, run: result.run, ...result.overview, signal: runtime.signal }));
}

function saveGeneratedReport(panel, data, result, runtime, metadata, evidence) {
  const { provider, model, effort, engine, thinking, context } = result;
  runtime.signal.throwIfAborted();
  runtime.stage('saving', 'Saving the report');
  const run = saveRun(HOME_DIR, data, reportsByProject(data.projects), renderDocument(data), new Date(), {
    metadata: { ...metadata, provider, model, effort, engine, thinking, context, ...runtime.metadata() }, evidence
  });
  const partial = Boolean(data.failures?.length);
  runtime.stage('done', partial ? 'Partial report saved' : metadata.pendingOverview ? 'Project drafts saved' : 'Report ready', { month: data.month, run, partial });
  if (partial) vscode.window.showWarningMessage('Report saved, though some projects could not be included.');
  void panel.push(false);
  return run;
}

async function editSavedReport(panel, month, parentRun, record) {
  const edit = await editProject(vscode, record.data);
  if (!edit) return;
  const key = projectKey(edit.project);
  const removed = edit.remove ? new Set([key]) : new Set();
  const data = reviseProjects(record.data, edit.replacement ? new Map([[key, edit.replacement]]) : new Map(), removed);
  if (edit.replacement) data.failures = data.failures?.map((failure) =>
    (failure.id || failure.project) === key ? { ...failure, id: key, project: edit.replacement.name } : failure);
  const overrides = { ...record.metadata.overrides };
  if (edit.remove) delete overrides[key];
  if (edit.overrides && Object.keys(edit.overrides).length) overrides[key] = { ...overrides[key], ...edit.overrides };
  const metadata = { ...record.metadata, cutoff: originalCutoff(month, parentRun, record), overrides, kind: 'edited', parentRun };
  delete metadata.events;
  delete metadata.durationMs;
  saveRun(HOME_DIR, data, reportsByProject(data.projects), renderDocument(data), new Date(), {
    metadata, evidence: record.evidence?.filter((p) => !removed.has(projectKey(p))) ?? null
  });
  void panel.push(false);
}

function originalCutoff(month, run, record) {
  if (record.metadata.cutoff) return record.metadata.cutoff;
  const savedAt = fs.statSync(path.join(reportDir(month, run), 'report.json')).mtime;
  if (record.data.dateRange) return reportBounds(month, record.data.dateRange, savedAt).to.toISOString();
  const [year, index] = month.split('-').map(Number);
  const through = record.data.through || Number(record.data.days?.at(-1)?.slice(-2));
  const end = through ? new Date(year, index - 1, through + 1) : new Date(year, index, 1);
  return new Date(Math.min(+end, +savedAt)).toISOString();
}

async function deepReport(panel, month, parentRun, record, options = {}) {
  let saved;
  await runReportTask(panel, 'deep prompting review', async (runtime) => {
    const data = record.data;
    let effort = options.effort || (options.failedOnly ? data.promptingReview?.effort : null);
    if (!effort) {
      const picked = await vscode.window.showQuickPick(DEEP_EFFORTS.map((level) => ({
        label: level[0].toUpperCase() + level.slice(1), description: DEEP_SCOPE[level], level
      })), { title: 'Deep review depth' });
      if (!picked) return;
      effort = picked.level;
    }
    const failed = new Set((data.reviewFailures || []).map((item) => item.id));
    const selected = data.projects.filter((project) => !options.failedOnly || failed.has(projectKey(project)));
    if (!selected.length) return;
    const cutoff = originalCutoff(month, parentRun, record);
    panel.post({ type: 'tab', tab: 'report' });
    runtime.start();
    runtime.stage('gathering', 'Counting user messages locally');
    const scan = await runWorker('scan-worker.js', { month, cutoff, deep: true, dateRange: data.dateRange }, runtime.signal);
    const reviewFailures = [];
    const unavailable = (project, error) => {
      const message = scrubDeep(String(error?.message || error)).slice(0, 180);
      reviewFailures.push({ id: projectKey(project), project: project.name, error: message });
      runtime.progress({ project: project.name, status: 'failed', error: message });
    };
    const candidates = [];
    for (const project of selected) {
      try {
        const source = matchLegacyProject(project, scan.projects);
        if (!source.prompts.length) throw new Error('No user messages available in the saved reporting period');
        candidates.push({ ...source, id: projectKey(project), name: project.name });
      } catch (error) { unavailable(project, error); }
    }
    if (effort !== 'low') runtime.stage('gathering', 'Checking project context and changed filenames');
    const git = candidates.length && effort !== 'low' ? await runWorker('scan-worker.js', {
      deepGit: candidates.map(({ id, name, location, repositories }) => ({ id, name, location, repositories })),
      month, cutoff, effort: 'medium', dateRange: data.dateRange
    }, runtime.signal) : {};
    const reviews = candidates.map((project) => prepareReview(project, git[project.id]));
    const inlineProjects = effort === 'high' ? reviews.flatMap((review, index) => {
      const files = selectInlineFiles(review);
      return files.length ? [{ id: review.id, name: review.name, repositories: candidates[index].repositories, files }] : [];
    }) : [];
    if (inlineProjects.length) runtime.stage('gathering', 'Reading selected Git diffs');
    const inline = inlineProjects.length ? await runWorker('scan-worker.js', {
      deepGit: inlineProjects, month, cutoff, effort: 'high', dateRange: data.dateRange
    }, runtime.signal) : {};
    const config = localConfig();
    const local = config.enabled;
    const target = local ? await resolveLocal(config, runtime.signal) : null;
    const models = defaultModels();
    const model = { model: target?.model || models.project.model || 'haiku', effort: models.project.effort || 'medium' };
    const finalModel = { model: target?.model || models.overview.model || 'sonnet', effort: models.overview.effort || 'high' };
    const cloudContext = vscode.workspace.getConfiguration('claudeReport').get('deep.cloudContext');
    let context = target?.loadedContext || target?.reportContext || (local ? 8192 :
      Number.isSafeInteger(cloudContext) && cloudContext >= 2048 ? cloudContext : 200000);
    let budget = budgetFor(context);
    const cache = reviewCache(HOME_DIR, { period: data.dateRange || month, provider: target?.engine || 'cloud',
      model: model.model, reasoning: target ? Boolean(config.thinking) : model.effort });
    const describe = (plans) => plans.map((item) =>
      item.name + ' · ' + item.prompts + ' messages, ' + item.words.toLocaleString() + ' words, ~' +
      item.tokens.toLocaleString() + ' input tokens' + (item.reused ? ' · cached review' : item.chunks === 1 ? ' · 1 request' : ' · ' + item.chunks + ' batches') +
      (item.diffExcerpts ? ' · ' + item.diffExcerpts + ' diff excerpts' : '')).join('\n');
    const makePlan = () => reviews.map((review) => planProjectReview({ review, level: effort, inline: inline[review.id], budget, context, cache }));
    const summarizePlan = (prepared) => prepared.map(({ plan, cached, details }, index) => {
      const { id, name, stats } = reviews[index];
      return { id, name, ...stats, tokens: plan.tokens, chunks: plan.chunks.length, split: plan.split, fragments: plan.fragments,
        reused: Boolean(cached), diffExcerpts: details.diffExcerpts };
    });
    let prepared = makePlan();
    const requestCount = plannedRequests(summarizePlan(prepared)).review + 1;
    const ok = await vscode.window.showInformationMessage('Run a Deep prompting review?',
      { modal: true, detail: effort[0].toUpperCase() + effort.slice(1) + ' depth · ' + requestCount + (requestCount === 1 ? ' model request.' : ' model requests.') }, 'Run Deep review');
    runtime.signal.throwIfAborted();
    if (ok !== 'Run Deep review') {
      runtime.stage('cancelled', 'Deep review cancelled');
      return;
    }
    let runner = runClaude;
    if (target) {
      runtime.stage('gathering', 'Preparing the Deep review model');
      const localRunner = await prepareLocal({ ...target, deepEffort: config.thinking ? 'medium' : 'low' }, { signal: runtime.signal });
      runner = localRunner;
      if (localRunner.context) {
        context = localRunner.context;
        budget = budgetFor(context);
      }
      runtime.event('Deep reasoning setting: ' + (localRunner.thinking || 'model default'));
      prepared = makePlan();
    }
    const plan = summarizePlan(prepared);
    for (const line of describe(plan).split('\n').filter(Boolean)) runtime.event(line);
    runtime.event('Requests for this run: ' + (requestCount - 1) + ' project review ' + (requestCount === 2 ? 'request' : 'requests') + ' at ' + effort + ' depth, then 1 final synthesis.');
    runtime.event(model.model + ' · ' + (target ? 'one project at a time' : 'up to ' + Math.min(DEEP_CONCURRENCY, reviews.length) + ' project reviews at once'));
    const reviewing = plan.some((item) => !item.reused && item.chunks > 1)
      ? 'Reviewing larger projects in session batches'
      : 'Reviewing projects at ' + effort + ' depth';
    runtime.stage('working', reviewing);
    // The plan above is a hard cap: a stray request for another depth or past the planned count is refused before it runs.
    const requestGuard = requestBudget({ depth: effort, limits: { 'deep-review': plannedRequests(plan).limit, overview: 1 } });
    const run = requestGuard(runtime.model((request) => runner({ ...request,
      onTokenUsage: (count) => runtime.event(request.label + ' · actual input ' + count.toLocaleString() + ' tokens') })));
    const audited = new Map();
    for (const review of reviews) {
      runtime.progress({ project: review.name, status: 'queued' });
    }
    const audit = async (review, index) => {
      try {
        const output = await runProjectReview({ review, level: effort, prepared: prepared[index], run, model, budget, context, cache, signal: runtime.signal,
          onDetail: (detail) => runtime.progress({ project: review.name, status: 'working', detail }) });
        audited.set(review.id, output);
        runtime.progress({ project: review.name, status: 'done' });
      } catch (error) {
        runtime.signal.throwIfAborted();
        unavailable(review, error);
      }
    };
    await mapLimit(reviews, local ? 1 : DEEP_CONCURRENCY, audit);
    const keys = new Set(selected.map(projectKey));
    const revised = {
      ...data, promptingReview: { effort, scope: DEEP_SCOPE[effort], model: model.model, finalizer: finalModel.model },
      projects: data.projects.map((project) => {
        if (!keys.has(projectKey(project))) return project;
        return { ...project, promptReview: audited.get(projectKey(project)) };
      }),
      reviewFailures: [...(data.reviewFailures || []).filter((item) => !keys.has(item.id)), ...reviewFailures]
    };
    if (audited.size || options.finalizeOverview || record.metadata.pendingOverview) {
      runtime.stage('overview', 'Writing the final report with ' + finalModel.model);
      const entry = buildDeepEntry(revised);
      const overview = scrubDeep(await generateOverview({ entry, run, ...finalModel, signal: runtime.signal, label: finalModel.model + ' final report' }));
      if (overview) {
        const { promptingSummary, ...cards } = overview;
        revised.overview = cards;
        if (promptingSummary) revised.promptingReview.summary = promptingSummary;
        revised.overviewStale = false;
      } else {
        revised.overviewStale = true;
        vscode.window.showWarningMessage('Project reviews saved without a final summary.');
      }
    }
    runtime.signal.throwIfAborted();
    runtime.stage('saving', 'Saving Deep prompting review');
    saved = saveRun(HOME_DIR, revised, reportsByProject(revised.projects), renderDocument(revised), new Date(), {
      metadata: { ...record.metadata, cutoff, parentRun, kind: 'deep', provider: target ? 'local' : 'cloud',
        model: model.model, effort, finalizerModel: finalModel.model, pendingOverview: false, deepPlan: plan, ...runtime.metadata() },
      evidence: record.evidence
    });
    const partial = Boolean(revised.reviewFailures.length || revised.failures?.length);
    runtime.stage('done', partial ? 'Partial Deep report saved' : 'Deep report ready', { month, run: saved, partial });
    void panel.push(false);
  });
  return saved;
}

async function chooseEnhancementRoute() {
  const provider = await vscode.window.showQuickPick(['Cloud', 'Local'], { title: 'Enhancement provider' });
  if (!provider) return;
  const models = defaultModels();
  if (provider === 'Cloud') {
    const model = await vscode.window.showQuickPick(
      ['sonnet', 'opus', ...MODELS.filter((value) => value !== 'sonnet' && value !== 'opus')],
      { title: 'Claude Code model for this enhancement' });
    if (!model) return;
    const effort = await vscode.window.showQuickPick(['high', ...EFFORTS.filter((value) => value !== 'high')], {
      title: 'Claude Code effort for this enhancement'
    });
    if (effort) return { models: { project: { model, effort }, overview: { model, effort } }, description: `${model} · ${effort}` };
    return;
  }

  const prefs = localConfig();
  const engine = await vscode.window.showQuickPick([prefs.engine, prefs.engine === 'ollama' ? 'lmstudio' : 'ollama'], {
    title: 'Local engine for this enhancement'
  });
  if (!engine) return;
  const config = { ...prefs, engine, model: engine === prefs.engine ? prefs.model : '' };
  const state = await inspectLocal(config, false);
  if (!state.engines.some((item) => item.engine === engine && item.running)) {
    throw new Error('Start ' + (engine === 'ollama' ? 'Ollama' : 'LM Studio') + ' before enhancing with it.');
  }
  if (!state.models.length) throw new Error('The local server returned no models.');
  const picked = await vscode.window.showQuickPick(state.models.map((item) => ({
    label: item.id, description: item.state === 'loaded' ? 'Loaded' : undefined
  })), { title: 'Local model for this enhancement' });
  if (!picked) return;
  const selection = { ...config, model: picked.label };
  const target = await resolveLocal(selection);
  const reasoning = target.reasoning || [];
  const on = reasoning.includes('low') || reasoning.includes('on');
  const options = [...(on ? ['On'] : []), ...(reasoning.includes('off') ? ['Off'] : [])];
  if (options.length) {
    const setting = await vscode.window.showQuickPick(options, { title: 'Thinking for this enhancement' });
    if (!setting) return;
    target.thinking = setting === 'On';
  } else {
    target.thinking = false;
  }
  return { local: selection, target, models, description: `${target.model} · ${engine}` };
}

async function enhancementProjects(data, failedOnly) {
  if (failedOnly) return data.projects.filter((p) =>
    (data.failures || []).some((failure) => (failure.id || failure.project) === projectKey(p)));
  if (!data.projects.length) return [];
  const scope = await vscode.window.showQuickPick(['All projects', 'Selected projects'], { title: 'Projects to enhance' });
  if (scope === 'All projects') return data.projects;
  if (scope !== 'Selected projects') return [];
  const selected = await vscode.window.showQuickPick(data.projects.map((project) => ({ label: project.name, project })), {
    title: 'Select projects to enhance', canPickMany: true
  });
  return selected?.map((item) => item.project) || [];
}

async function getEnhancementEvidence(selected, record, month, cutoff, runtime) {
  const captured = new Map((record.evidence || []).map((project) => [projectKey(project), project]));
  const missing = selected.filter((project) => !captured.has(projectKey(project)));
  const rebuilt = new Map();
  if (missing.length) {
    runtime.stage('gathering', 'Rebuilding evidence from available history');
    const scan = await runWorker('scan-worker.js', { month, cutoff, dateRange: record.data.dateRange }, runtime.signal);
    const matches = missing.map((project) => {
      const match = matchLegacyProject(project, scan.projects);
      return { ...match, id: projectKey(project), name: project.name, baseName: project.baseName || project.name };
    });
    const withGit = await addGitEvidence(matches, month, cutoff, runtime, record.data.dateRange);
    for (const project of withGit) rebuilt.set(project.id, project);
    for (const project of captureEvidence(withGit)) captured.set(projectKey(project), { ...project, rebuilt: true });
  }
  const projects = selected.map((project) => {
    const key = projectKey(project);
    const previousExpandedWords = project.report?.examples?.some((example) => example.detail) ? undefined : expandedProjectWords(project.report);
    return { ...captured.get(key), id: key, name: project.name, git: project.git ?? rebuilt.get(key)?.git, previousExpandedWords };
  });
  return { projects, evidence: [...captured.values()], rebuilt: missing.length > 0 };
}

function keepReportEdits(next, prior, overrides) {
  const taskKey = (example) => example.task.trim().toLowerCase();
  const generated = new Map(next.examples.map((example) => [taskKey(example), example]));
  const examples = [...(prior?.examples || [])].filter((example) => example.timeSource === 'reported' ||
    (example.timeSource !== 'estimated' && (example.withAI || example.withoutAI))).map((example) => {
    const detail = generated.get(taskKey(example))?.detail;
    return detail && !example.detail ? { ...example, detail } : example;
  });
  const tasks = new Set(examples.map(taskKey));
  return withExampleHours({
    ...next, examples: [...examples, ...next.examples.filter((example) => !tasks.has(taskKey(example)))],
    ...overrides
  });
}

async function enhanceReport(panel, month, parentRun, record, { failedOnly = false } = {}) {
  return runReportTask(panel, failedOnly ? 'retry' : 'enhance', async (runtime) => {
    const { data, metadata } = record;
    const selected = await enhancementProjects(data, failedOnly);
    if (!selected.length) return;
    const route = await chooseEnhancementRoute();
    if (!route) return;
    const { estimateTime } = exportOptions();
    const all = selected.length === data.projects.length;
    const known = new Set((record.evidence || []).map(projectKey));
    const requiresRebuild = selected.some((project) => !known.has(projectKey(project)));
    const cutoff = originalCutoff(month, parentRun, record);
    const detail = selected.length + (selected.length === 1 ? ' project' : ' projects') + ' · ' + route.description + '.' +
      (route.local ? '' : ' Redacted prompts are sent through your Claude Code.');
    if (await vscode.window.showInformationMessage('Enhance this saved report?', { modal: true, detail }, 'Enhance') !== 'Enhance') return;
    runtime.start();
    const input = await getEnhancementEvidence(selected, record, month, cutoff, runtime);
    const result = await runProjectReports(input.projects, { ...route, estimateTime }, runtime);
    if (!Object.keys(result.reports).length) throw new Error('Enhancement failed for every selected project. See the runtime log for details.');
    const evidenceById = new Map(input.projects.map((p) => [p.id, p]));
    const replacements = new Map();
    for (const project of selected) {
      const key = projectKey(project), report = result.reports[key];
      if (!report) continue;
      const git = project.git ?? evidenceById.get(key)?.git;
      replacements.set(key, { ...project, git, report: keepReportEdits(report, project.report, metadata.overrides?.[key]) });
    }
    const revised = reviseProjects(data, replacements);
    const attempted = new Set(selected.map(projectKey));
    revised.failures = [
      ...(data.failures || []).filter((failure) => !attempted.has(failure.id || failure.project)),
      ...result.failures
    ];
    if (all && !revised.failures.length) {
      const reports = Object.fromEntries(revised.projects.map((p) => [projectKey(p), p.report]));
      const projects = revised.projects.map((p) => ({
        ...p, id: projectKey(p), totalTokens: p.tokens, promptCount: p.prompts,
        prompts: evidenceById.get(projectKey(p))?.prompts || []
      }));
      revised.overview = await writeOverview({ user: data.user, month, projects, result: { ...result, reports }, runtime, dateRange: data.dateRange });
      revised.overviewStale = !revised.overview;
    }
    saveGeneratedReport(panel, revised, result, runtime, {
      cutoff, parentRun, overrides: metadata.overrides, kind: 'enhanced', estimateTime,
      evidenceKind: input.rebuilt || input.evidence.some((p) => p.rebuilt) ? 'rebuilt' : 'sampled',
    }, input.evidence);
  });
}

function showRuntime(month, run, { metadata }) {
  if (!Array.isArray(metadata.events) || !metadata.events.length) {
    return vscode.window.showInformationMessage('No timing details were recorded for this report.');
  }
  if (!channel) return;
  channel.appendLine('\nClaude Report runtime · ' + (run || month) + ' · ' + formatDuration(metadata.durationMs));
  for (const { atMs, text, durationMs } of metadata.events) {
    channel.appendLine('+' + formatDuration(atMs) + '  ' + text + (durationMs === undefined ? '' : ' (' + formatDuration(durationMs) + ')'));
  }
  channel.show();
}

async function compareReport(month, run, record) {
  const original = loadRun(HOME_DIR, month, record.metadata.parentRun);
  const openDocument = ({ data }) => vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
    overview: data.overview, projects: data.projects.map(({ name, report, promptReview }) => ({ name, report, promptReview }))
  }, null, 2) });
  const [before, after] = await Promise.all([openDocument(original), openDocument(record)]);
  await vscode.commands.executeCommand('vscode.diff', before.uri, after.uri, 'Claude Report · ' + (run || month));
}

// --- lifecycle ---------------------------------------------------------------

function syncRuntime(context) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { return; }
  if (!isWired(settings)) return; // never connected here: leave settings.json to the Connect command
  let hookPath;
  try { hookPath = installRuntime(context.extensionPath, HOME_DIR); }
  catch (e) { log(`runtime copy failed, status line will not report: ${e.message}`); return; }
  const nodePath = resolveNode();
  if (!nodePath) return;
  const plan = planInstall(settings, hookPath, nodePath);
  if (!plan.error && !plan.already) {
    try {
      applyInstall({ settingsPath: CLAUDE_SETTINGS, hookPath, nodePath, configDir: HOME_DIR });
      log(plan.changes.join('; '));
    } catch (e) { log(`statusLine update failed: ${e.message}`); return; }
  }
  // Drop hook copies older than the one in use; keep this editor's own.
  let inUse = null;
  try { inUse = hookPathOf(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')).statusLine.command); } catch { /* unreadable: keep everything */ }
  if (inUse) {
    const removed = pruneRuntimes(HOME_DIR, [inUse, hookPath]);
    if (removed.length) log(`removed old hook copies: ${removed.join(', ')}`);
  }
}

let timer = null;

function activate(context) {
  migrateLegacy(HOME_DIR);
  channel = vscode.window.createOutputChannel ? vscode.window.createOutputChannel('Claude Report') : null;
  log(`activated ${pkg.version} in ${vscode.env && vscode.env.appName ? vscode.env.appName : 'an editor'}`);

  // Once connected, every editor that runs this extension keeps the hook healthy: it writes its own
  // versioned runtime copy, and moves the statusLine forward only when its build is newer than the one
  // in use or that one's file is gone. Older installs in other editors never downgrade it.
  syncRuntime(context);

  // A higher priority sits further left, so the slots read in order. Left is the default
  // because the right end is often crowded; it can be switched in settings (needs a reload).
  const side = vscode.workspace.getConfiguration('claudeReport').get('statusBarSide') === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
  const slots = Array.from({ length: MAX_ITEMS }, (_, i) => vscode.window.createStatusBarItem(`claudeReport.slot${i}`, side, 100 - i));
  slots.forEach((slot) => { slot.name = 'Claude Report'; }); // lets the user hide it from the status bar menu
  log(`status bar: ${slots.length} slots on the ${side === vscode.StatusBarAlignment.Right ? 'right' : 'left'}`);
  const tick = () => refreshStatus(slots);
  tick();
  timer = setInterval(tick, STATUS_REFRESH_MS);
  if (timer.unref) timer.unref();

  const panel = new Panel(context);
  // Refresh is a soft reload of the extension: caches dropped, status bar redrawn, sidebar page rebuilt, data read again.
  panel.reloadAll = async () => {
    Object.keys(scans).forEach((k) => delete scans[k]);
    lastShown = '';
    refreshStatus(slots);
    if (panel.view) panel.reset(); else await panel.push(true);
  };
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  context.subscriptions.push(...slots, vscode.window.registerWebviewViewProvider('claudeReport.metrics', panel, { webviewOptions: { retainContextWhenHidden: true } }));
  reg('claudeReport.openMetrics', () => vscode.commands.executeCommand('workbench.view.extension.claudeReport'));
  reg('claudeReport.diagnose', () => diagnose());
  reg('claudeReport.refresh', () => panel.reloadAll());
  reg('claudeReport.restart', () => vscode.commands.executeCommand('workbench.action.restartExtensionHost'));
  reg('claudeReport.createReport', () => createReport(panel));
  reg('claudeReport.installHook', async () => { await installHook(context); refreshStatus(slots); return panel.push(false); });
  reg('claudeReport.uninstallHook', async () => { await uninstallHook(); refreshStatus(slots); return panel.push(false); });
}

function deactivate() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { activate, deactivate, _sessions: { newSession, resumeSession } };
