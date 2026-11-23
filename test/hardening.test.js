'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitCommand } = require('../bin/hook');
const live = require('../src/live');
const { applyInstall, pruneRuntimes } = require('../src/install');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('splitCommand sends shell-only syntax to a shell and keeps the quoted-path case off it', () => {
  for (const c of ['bash ~/status.sh', "node -e 'console.log(1)'", 'FOO=1 tool', 'tool --fmt="a b"', 'tool "a"b', 'tool a"b c"']) {
    assert.strictEqual(splitCommand(c), null, c);
  }
  assert.deepStrictEqual(splitCommand('"C:/Program Files/app.exe" --flag "x y"'), ['C:/Program Files/app.exe', '--flag', 'x y']);
  assert.deepStrictEqual(splitCommand('node C:/x/s.js --a=1'), ['node', 'C:/x/s.js', '--a=1']);
});

test('applyInstall writes config.json atomically (no temp litter)', () => {
  const home = tmp('cfg-');
  const settingsPath = path.join(home, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'orig-tool' } }));
  applyInstall({ settingsPath, hookPath: path.join(home, 'hook.js'), nodePath: 'node', configDir: home });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).chain, 'orig-tool');
  assert.deepStrictEqual(fs.readdirSync(home).filter((n) => n.endsWith('.tmp')), []);
});

test('live home is derived from the runtime location, else CLAUDE_REPORT_HOME, else ~/.claude-report', () => {
  const home = path.join(os.tmpdir(), 'h');
  assert.strictEqual(live.homeDir(path.join(home, 'runtime', '1.2.3', 'src'), {}), home);
  assert.strictEqual(live.homeDir(path.join(home, 'src'), { CLAUDE_REPORT_HOME: '/x/y' }), '/x/y');
  assert.strictEqual(live.homeDir(path.join(home, 'src'), {}), path.join(os.homedir(), '.claude-report'));
});

test('writeLive leaves no .tmp behind when the rename keeps failing, and retries a transient failure', () => {
  const dir = tmp('live-');
  const orig = fs.renameSync;
  const status = { session_id: 's1', rate_limits: { five_hour: { used_percentage: 5 } } };
  let n = 0;
  fs.renameSync = (a, b) => { if (n++ < 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return orig(a, b); };
  try { live.writeLive(status, { dir, now: 1 }); } finally { fs.renameSync = orig; }
  assert.ok(fs.existsSync(path.join(dir, 'live', 's1.json')));
  fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try { assert.throws(() => live.writeLive(status, { dir, now: 2 })); } finally { fs.renameSync = orig; }
  const litter = [dir, path.join(dir, 'live')].flatMap((d) => fs.readdirSync(d)).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(litter, []);
});

test('prune removes .tmp files older than an hour and keeps fresh ones', () => {
  const dir = tmp('prune-live-');
  const stale = path.join(dir, 'live', 'a.json.1.tmp');
  const fresh = path.join(dir, 'live', 'b.json.2.tmp');
  fs.mkdirSync(path.join(dir, 'live'));
  fs.writeFileSync(stale, '');
  fs.writeFileSync(fresh, '');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  live.writeLive({ session_id: 's2' }, { dir });
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(fresh));
});

test('pruneRuntimes matches kept paths case-insensitively on Windows', { skip: process.platform !== 'win32' }, () => {
  const home = tmp('prune-case-');
  const d = path.join(home, 'runtime', 'bin');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'hook.js'), '');
  const kept = path.join(d, 'hook.js').toUpperCase();
  assert.deepStrictEqual(pruneRuntimes(home, [kept]), []);
  assert.ok(fs.existsSync(d));
});
