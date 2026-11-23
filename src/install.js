'use strict';

// Wires our hook in as the Claude Code statusLine without losing the user's own:
// the previous command is saved in config.json and the hook chains to it.
const fs = require('fs');
const path = require('path');
const { DEFAULT_DIR } = require('./live');
const { writeFileAtomic } = require('./atomic');

// nodePath is the absolute node the extension found; Claude Code's own shell may not have node on its PATH.
const hookCommand = (hookPath, nodePath = 'node') =>
  `${nodePath === 'node' ? 'node' : `"${nodePath.replace(/\\/g, '/')}"`} "${path.resolve(hookPath).replace(/\\/g, '/')}"`;

// Ours by folder name, or by the runtime layout itself so a custom CLAUDE_REPORT_HOME still counts.
const isOurs = (sl) => !!(sl && typeof sl.command === 'string' && sl.command.includes('hook.js')
  && (/ide-companio|claude-report/.test(sl.command) || /[\\/]runtime[\\/](\d+\.\d+\.\d+[\\/])?bin[\\/]hook\.js/.test(sl.command)));

// The hook script a statusLine command runs: the last quoted (or bare) path ending in hook.js.
function hookPathOf(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(/"([^"]*hook\.js)"\s*$/) || command.match(/(\S*hook\.js)\s*$/);
  return m ? m[1] : null;
}

// Runtime copies live in runtime/<version>/ so several editors running different versions never
// overwrite a file another editor (or a running Claude Code status line) has open. Unversioned and
// ide-companio paths count as 0.0.0, so any versioned build moves them forward.
function runtimeVersionOf(p) {
  const m = typeof p === 'string' && p.replace(/\\/g, '/').match(/\/runtime\/(\d+)\.(\d+)\.(\d+)\/bin\/hook\.js$/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function planInstall(settings, hookPath, nodePath, { exists = fs.existsSync } = {}) {
  const sl = settings && settings.statusLine;
  if (isOurs(sl)) {
    const current = hookPathOf(sl.command);
    const same = current && hookPath && path.resolve(current) === path.resolve(hookPath);
    // Newest build wins: never move the setting to an older copy, unless the one it points at is gone.
    const newer = hookPath && cmpVersion(runtimeVersionOf(hookPath), runtimeVersionOf(current)) > 0;
    const missing = !current || !exists(current);
    if (hookPath && !same && (newer || missing)) {
      const next = { ...settings, statusLine: { ...sl, type: 'command', command: hookCommand(hookPath, nodePath) } };
      const why = /.ide-companio/.test(sl.command) ? 'from the old Companio hook' : missing ? 'from a missing hook file' : 'to the newer hook';
      return { settings: next, chain: null, already: false, legacy: true, changes: [`statusLine moves ${why}; your own status line stays chained`] };
    }
    return { settings, chain: null, already: true, changes: [] };
  }
  let chain = null;
  if (sl !== undefined && sl !== null) {
    if (typeof sl !== 'object' || sl.type !== 'command') return { error: 'unsupported statusLine type' };
    chain = typeof sl.command === 'string' ? sl.command : null;
  }
  const next = { ...settings, statusLine: { ...(sl && typeof sl === 'object' ? sl : {}), type: 'command', command: hookCommand(hookPath, nodePath) } };
  const changes = ['statusLine now runs the claude-report hook'];
  if (chain) changes.push(`your existing status line is kept and still shown: ${chain}`);
  return { settings: next, chain, already: false, changes };
}

function readSettings(settingsPath) {
  let text;
  try { text = fs.readFileSync(settingsPath, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  if (!text.trim()) return {};
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
    return j;
  } catch {
    throw new Error(`${settingsPath} is not valid JSON; fix it first, nothing was changed`);
  }
}

// Written beside the target and renamed over it, so a crash or a concurrent
// Claude Code write can never leave settings.json half written.
const writeSettings = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(s, null, 2) + '\n');
};

// The extension folder is versioned and disappears on update or uninstall, so
// settings.json must never point into it. The hook and the one module it needs
// are copied to a stable place instead, one folder per version. A folder already
// holding identical files is left alone, and changed files are written beside the
// target and renamed in, so a status line mid-run never reads half a file.
function installRuntime(extensionPath, destDir = DEFAULT_DIR, version = require(path.join(extensionPath, 'package.json')).version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`bad runtime version: ${version}`);
  const root = path.join(destDir, 'runtime', String(version));
  for (const [dir, name] of [['bin', 'hook.js'], ['src', 'live.js']]) {
    const to = path.join(root, dir, name);
    const body = fs.readFileSync(path.join(extensionPath, dir, name));
    let same = false;
    try { same = fs.readFileSync(to).equals(body); } catch { /* not there yet */ }
    if (same) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    writeFileAtomic(to, body);
  }
  return path.join(root, 'bin', 'hook.js');
}

function applyInstall({ settingsPath, hookPath, nodePath, configDir = DEFAULT_DIR }) {
  const settings = readSettings(settingsPath);
  const plan = planInstall(settings, hookPath, nodePath);
  if (plan.error || plan.already) return { ...plan, backedUpTo: null };
  const bak = settingsPath + '.claude-report.bak';
  let backedUpTo = null;
  if (fs.existsSync(settingsPath) && !fs.existsSync(bak)) {
    fs.copyFileSync(settingsPath, bak);
    backedUpTo = bak;
  }
  fs.mkdirSync(configDir, { recursive: true });
  if (!plan.legacy) fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ chain: plan.chain }, null, 2) + '\n');
  writeSettings(settingsPath, plan.settings);
  return { ...plan, backedUpTo };
}

function planUninstall(settings, chain) {
  const sl = settings && settings.statusLine;
  if (!isOurs(sl)) return { settings, restored: false, changes: [], note: 'statusLine is not ours; nothing changed' };
  const next = { ...settings };
  if (chain) next.statusLine = { ...sl, type: 'command', command: chain };
  else delete next.statusLine;
  return { settings: next, restored: true, changes: [chain ? `statusLine restored to: ${chain}` : 'statusLine removed'] };
}

function applyUninstall({ settingsPath, configDir = DEFAULT_DIR }) {
  const settings = readSettings(settingsPath);
  let chain = null;
  try { chain = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')).chain || null; } catch { /* none */ }
  const plan = planUninstall(settings, chain);
  if (plan.restored) writeSettings(settingsPath, plan.settings);
  return plan;
}

// Earlier builds were called ide-companio and kept the user's previous status line in
// ~/.ide-companio/config.json. Copy it over so Disconnect still restores that line.
function migrateLegacy(newDir, oldDir = path.join(require('os').homedir(), '.ide-companio')) {
  try {
    const from = path.join(oldDir, 'config.json');
    const to = path.join(newDir, 'config.json');
    if (fs.existsSync(to) || !fs.existsSync(from)) return false;
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

// Connected means the setting is ours AND the script it runs exists; a dangling path never reports.
const isConnected = (settings, exists = fs.existsSync) => {
  const sl = settings && settings.statusLine;
  if (!isOurs(sl)) return false;
  const p = hookPathOf(sl.command);
  return !!p && exists(p);
};

module.exports = { hookCommand, hookPathOf, runtimeVersionOf, planInstall, applyInstall, planUninstall, applyUninstall, installRuntime, migrateLegacy, isWired: (settings) => isOurs(settings && settings.statusLine), isConnected };
