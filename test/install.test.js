'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookCommand, planInstall, applyInstall, planUninstall, applyUninstall } = require('../src/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
const HOOK = '/x/claude-report/bin/hook.js';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('hookCommand uses forward slashes', () => {
  assert.match(hookCommand('C:\\a\\claude-report\\bin\\hook.js'), /^node ".*\/claude-report\/bin\/hook\.js"$/);
});

test('plan without an existing statusLine', () => {
  const input = { theme: 'dark' };
  const p = planInstall(input, HOOK);
  assert.strictEqual(p.chain, null);
  assert.strictEqual(p.already, false);
  assert.strictEqual(p.settings.theme, 'dark');
  assert.strictEqual(p.settings.statusLine.type, 'command');
  assert.deepStrictEqual(input, { theme: 'dark' });
});

test('plan chains an existing statusLine and keeps other keys', () => {
  const input = { statusLine: { type: 'command', command: 'di.exe --claude-statusline', padding: 2 } };
  const copy = JSON.parse(JSON.stringify(input));
  const p = planInstall(input, HOOK);
  assert.strictEqual(p.chain, 'di.exe --claude-statusline');
  assert.strictEqual(p.settings.statusLine.padding, 2);
  assert.ok(p.settings.statusLine.command.includes('hook.js'));
  assert.deepStrictEqual(input, copy);
  assert.deepStrictEqual(planInstall({ statusLine: { type: 'other' } }, HOOK), { error: 'unsupported statusLine type' });
});

test('apply is idempotent and backs up once', () => {
  const d = tmp();
  const settingsPath = path.join(d, 'settings.json');
  const configDir = path.join(d, 'cfg');
  const orig = { statusLine: { type: 'command', command: 'di.exe' }, a: 1 };
  fs.writeFileSync(settingsPath, JSON.stringify(orig));
  const r1 = applyInstall({ settingsPath, hookPath: HOOK, configDir });
  assert.strictEqual(r1.already, false);
  assert.strictEqual(r1.backedUpTo, settingsPath + '.claude-report.bak');
  assert.deepStrictEqual(readJson(settingsPath + '.claude-report.bak'), orig);
  assert.deepStrictEqual(readJson(path.join(configDir, 'config.json')), { chain: 'di.exe' });
  assert.ok(fs.readFileSync(settingsPath, 'utf8').endsWith('}\n'));
  const r2 = applyInstall({ settingsPath, hookPath: HOOK, configDir });
  assert.strictEqual(r2.already, true);
  assert.deepStrictEqual(readJson(path.join(configDir, 'config.json')), { chain: 'di.exe' });
  assert.deepStrictEqual(readJson(settingsPath + '.claude-report.bak'), orig);
});

test('missing settings file counts as empty; invalid JSON refused untouched', () => {
  const d = tmp();
  const ok = path.join(d, 'new.json');
  applyInstall({ settingsPath: ok, hookPath: HOOK, configDir: path.join(d, 'c1') });
  assert.ok(readJson(ok).statusLine);
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  assert.throws(() => applyInstall({ settingsPath: bad, hookPath: HOOK, configDir: path.join(d, 'c2') }), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{oops');
  assert.ok(!fs.existsSync(bad + '.claude-report.bak'));
});

test('uninstall restores the chain, or removes the key', () => {
  const d = tmp();
  const settingsPath = path.join(d, 's.json');
  const configDir = path.join(d, 'cfg');
  const orig = { statusLine: { type: 'command', command: 'di.exe', padding: 1 } };
  fs.writeFileSync(settingsPath, JSON.stringify(orig));
  applyInstall({ settingsPath, hookPath: HOOK, configDir });
  applyUninstall({ settingsPath, configDir });
  assert.deepStrictEqual(readJson(settingsPath), orig);

  const s2 = path.join(d, 's2.json');
  const c2 = path.join(d, 'cfg2');
  fs.writeFileSync(s2, JSON.stringify({ a: 1 }));
  applyInstall({ settingsPath: s2, hookPath: HOOK, configDir: c2 });
  applyUninstall({ settingsPath: s2, configDir: c2 });
  assert.deepStrictEqual(readJson(s2), { a: 1 });
});

test('uninstall does nothing when the statusLine is not ours', () => {
  const s = { statusLine: { type: 'command', command: 'other' } };
  const p = planUninstall(s, 'x');
  assert.strictEqual(p.restored, false);
  assert.deepStrictEqual(p.settings, s);
});

test('several editors share one hook: newest version wins, never downgrades, dangling path heals', () => {
  const { runtimeVersionOf, hookPathOf, isConnected } = require('../src/install');
  const at = (v) => `C:/u/.claude-report/runtime/${v}/bin/hook.js`;
  const wired = (p) => ({ statusLine: { type: 'command', command: `"C:/n/node.exe" "${p}"` } });
  const all = () => true;

  assert.deepStrictEqual(runtimeVersionOf(at('0.11.2')), [0, 11, 2]);
  assert.deepStrictEqual(runtimeVersionOf('C:/u/.claude-report/runtime/bin/hook.js'), [0, 0, 0]);
  assert.strictEqual(hookPathOf(wired(at('1.0.0')).statusLine.command), at('1.0.0'));

  // An older editor starting up leaves a newer hook alone.
  assert.strictEqual(planInstall(wired(at('0.12.0')), at('0.11.2'), 'node', { exists: all }).already, true);
  // A newer editor moves it forward; 0.10 < 0.9 must not compare as strings.
  const up = planInstall(wired(at('0.9.1')), at('0.11.2'), 'node', { exists: all });
  assert.strictEqual(up.already, false);
  assert.strictEqual(up.legacy, true);
  assert.ok(up.settings.statusLine.command.includes('/runtime/0.11.2/'));
  // The unversioned path from 0.11.1 and earlier moves to the versioned one.
  assert.strictEqual(planInstall(wired('C:/u/.claude-report/runtime/bin/hook.js'), at('0.11.2'), 'node', { exists: all }).already, false);
  // Same version: nothing to do.
  assert.strictEqual(planInstall(wired(at('0.11.2')), at('0.11.2'), 'node', { exists: all }).already, true);
  // A newer path whose file is gone is replaced, even by an older build.
  assert.strictEqual(planInstall(wired(at('0.12.0')), at('0.11.2'), 'node', { exists: () => false }).already, false);

  assert.strictEqual(isConnected(wired(at('0.11.2')), () => false), false);
  assert.strictEqual(isConnected(wired(at('0.11.2')), all), true);
  assert.strictEqual(isConnected({ statusLine: { type: 'command', command: 'bash ~/x.sh' } }, all), false);
});

test('pruneRuntimes drops copies older than the hook in use, never the kept ones or newer ones', () => {
  const fs = require('fs');
  const os = require('os');
  const { pruneRuntimes } = require('../src/install');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const make = (...parts) => { const d = path.join(home, 'runtime', ...parts); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'hook.js'), ''); };
  for (const v of ['0.9.1', '0.11.2', '0.12.0', '0.13.0']) make(v, 'bin');
  make('bin'); // unversioned, pre-0.11.2
  fs.mkdirSync(path.join(home, 'runtime', 'notes'));
  const hook = (v) => path.join(home, 'runtime', v, 'bin', 'hook.js');
  const removed = pruneRuntimes(home, [hook('0.12.0'), hook('0.12.0')]).sort();
  assert.deepStrictEqual(removed, ['0.11.2', '0.9.1', 'bin']);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'runtime')).sort(), ['0.12.0', '0.13.0', 'notes']);
  // Nothing known in use: nothing versioned is removed.
  make('0.1.0', 'bin');
  assert.deepStrictEqual(pruneRuntimes(home, []), []);
});
