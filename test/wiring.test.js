'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// extension.js needs the `vscode` module, which only exists inside the editor.
function loadWithFakeVscode({ extension = false, rejectAll = false } = {}) {
  // Keeps activate away from the real ~/.claude-report.
  process.env.CLAUDE_REPORT_HOME = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'wire-'));
  // ...and away from the real ~/.claude/settings.json: activate may repoint a connected status line.
  process.env.CLAUDE_CONFIG_DIR = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'wire-cfg-'));
  const calls = { commands: [], views: [], statusItems: [], executed: [], terminals: [], errors: [], infos: [] };
  const fake = {
    window: {
      createStatusBarItem: () => { const i = { show() {}, hide() {}, dispose() {} }; calls.statusItems.push(i); return i; },
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      registerWebviewViewProvider: (id) => { calls.views.push(id); return { dispose() {} }; },
      showInformationMessage: (m) => { calls.infos.push(m); }, showWarningMessage() {}, showErrorMessage: (m) => { calls.errors.push(m); },
      createTerminal: () => { const term = { sent: [], show() {}, sendText(s) { term.sent.push(s); } }; calls.terminals.push(term); return term; },
      withProgress: (_o, fn) => fn({ report() {} }),
      createWebviewPanel: () => ({ webview: {} })
    },
    commands: { registerCommand: (id) => { calls.commands.push(id); return { dispose() {} }; }, executeCommand: async (id) => { calls.executed.push(id); if (rejectAll) throw new Error('command failed'); } },
    extensions: { getExtension: (id) => (extension && id === 'anthropic.claude-code' ? { id } : undefined) },
    workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1 },
    ThemeColor: class { constructor(id) { this.id = id; } }
  };
  // The real plan-usage poll would read this machine's Claude Code login and call Anthropic.
  const planUsage = { getUsage: (cb) => cb(null, 'disabled', { route: 'disabled' }), lastUsageRoute: () => 'disabled' };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return fake;
    if (request === './src/plan-usage') return planUsage;
    return orig.call(this, request, ...rest);
  };
  const file = path.join(__dirname, '..', 'extension.js');
  delete require.cache[require.resolve(file)];
  try {
    return { ext: require(file), calls, fake };
  } finally {
    Module._load = orig;
  }
}

test('activate registers every command and the Metrics view the manifest declares', () => {
  const { ext, calls } = loadWithFakeVscode();
  const context = { subscriptions: [], extensionPath: path.join(__dirname, '..') };
  ext.activate(context);
  ext.deactivate();

  const manifest = require('../package.json');
  const declared = manifest.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(calls.commands.slice().sort(), declared);
  assert.deepStrictEqual(calls.views, [manifest.contributes.views.claudeReport[0].id]);
  assert.strictEqual(calls.statusItems.length, require('../src/statusbar').MAX_ITEMS);
});

function withClaudeExtension(present, rejectAll) {
  const { ext, calls, fake } = loadWithFakeVscode({ extension: present, rejectAll });
  return { ext, calls, fake };
}

test('New session opens the Claude Code extension and never the CLI when the extension is installed', async () => {
  const { ext, calls } = withClaudeExtension(true, false);
  await ext._sessions.newSession();
  assert.deepStrictEqual(calls.executed, ['claude-vscode.primaryEditor.open']);
  assert.strictEqual(calls.terminals.length, 0);
});

test('with the extension installed but failing, it tries its other commands and then reports, still no CLI', async () => {
  const { ext, calls } = withClaudeExtension(true, true);
  await ext._sessions.newSession();
  assert.deepStrictEqual(calls.executed, ['claude-vscode.primaryEditor.open', 'claude-vscode.editor.open', 'claude-vscode.sidebar.open']);
  assert.strictEqual(calls.terminals.length, 0);
  assert.strictEqual(calls.infos.length, 1);
});

test('without the extension, New session starts the CLI in a terminal', async () => {
  const { ext, calls } = withClaudeExtension(false, false);
  await ext._sessions.newSession();
  assert.strictEqual(calls.terminals.length, 1);
  assert.deepStrictEqual(calls.terminals[0].sent, ['claude']);
  assert.deepStrictEqual(calls.executed, []);
});

test('a session from another folder resumes in a terminal in its own folder even when the extension is installed', async () => {
  const { ext, calls } = withClaudeExtension(true, false);
  const id = '11111111-1111-4111-8111-111111111111';
  await ext._sessions.resumeSession(id, require('os').tmpdir(), 'Some title');
  assert.strictEqual(calls.terminals.length, 1);
  assert.deepStrictEqual(calls.terminals[0].sent, ['claude --resume ' + id]);
});

test('activate moves a connected status line to its own versioned hook, only in the configured settings', () => {
  const fs = require('fs');
  const { ext } = loadWithFakeVscode();
  const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const old = path.join(process.env.CLAUDE_REPORT_HOME, 'runtime', 'bin', 'hook.js').replace(/\\/g, '/');
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: `node "${old}"` } }));
  ext.activate({ subscriptions: [], extensionPath: path.join(__dirname, '..') });
  ext.deactivate();
  const cmd = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
  const v = require('../package.json').version;
  assert.ok(cmd.includes(`/runtime/${v}/bin/hook.js`), cmd);
  assert.ok(fs.existsSync(path.join(process.env.CLAUDE_REPORT_HOME, 'runtime', v, 'bin', 'hook.js')));
});
