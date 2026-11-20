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
