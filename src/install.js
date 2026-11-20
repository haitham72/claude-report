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

const isOurs = (sl) => !!(sl && typeof sl.command === 'string' && /ide-companio|claude-report/.test(sl.command) && sl.command.includes('hook.js'));

function planInstall(settings, hookPath, nodePath) {
  const sl = settings && settings.statusLine;
  if (isOurs(sl)) {
    // Earlier builds installed a copy under ~/.ide-companio. Move the setting to the new copy and keep the saved chain.
    if (/.ide-companio/.test(sl.command) && hookPath && !/.ide-companio/.test(hookPath)) {
      const next = { ...settings, statusLine: { ...sl, type: 'command', command: hookCommand(hookPath, nodePath) } };
      return { settings: next, chain: null, already: false, legacy: true, changes: ['statusLine moves from the old Companio hook to the Claude Report hook; your own status line stays chained'] };
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
// are copied to a stable place instead.
function installRuntime(extensionPath, destDir = DEFAULT_DIR) {
  const files = [['bin', 'hook.js'], ['src', 'live.js']];
  for (const [dir, name] of files) {
    const to = path.join(destDir, 'runtime', dir);
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(extensionPath, dir, name), path.join(to, name));
  }
  return path.join(destDir, 'runtime', 'bin', 'hook.js');
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

module.exports = { hookCommand, planInstall, applyInstall, planUninstall, applyUninstall, installRuntime, migrateLegacy, isConnected: (settings) => isOurs(settings && settings.statusLine) };
