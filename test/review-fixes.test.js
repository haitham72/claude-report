'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitCommand, run } = require('../bin/hook');
const { installRuntime, applyInstall } = require('../src/install');
const { redact } = require('../src/scan');
const { runClaude, WORK_DIR } = require('../src/claude');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-'));

test('splitCommand keeps a quoted path with spaces as one program', () => {
  assert.deepStrictEqual(
    splitCommand('"C:/Users/x/AppData/Local/Dynamic Island/dynamic-island.exe" --claude-statusline'),
    ['C:/Users/x/AppData/Local/Dynamic Island/dynamic-island.exe', '--claude-statusline']);
});

test('splitCommand hands pipes, variables and .cmd files to a shell', () => {
  assert.strictEqual(splitCommand('a | b'), null);
  assert.strictEqual(splitCommand('echo $HOME'), null);
  assert.strictEqual(splitCommand('"C:/tools/line.cmd" --x'), null);
});

test('a shell chain is run through the shell, a plain one is not', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ chain: 'a | b' }));
  let shell;
  run('{"session_id":"s"}', { dir, spawn: (_c, o) => { shell = o.shell; return { stdout: 'x' }; } });
  assert.strictEqual(shell, true);
});

test('installRuntime copies the hook and its module to a stable folder that still loads', () => {
  const dest = tmp();
  const hook = installRuntime(path.join(__dirname, '..'), dest);
  assert.ok(fs.existsSync(hook));
  assert.ok(fs.existsSync(path.join(dest, 'runtime', 'src', 'live.js')));
  const fresh = require('child_process').execFileSync('node', [hook], { input: '{"session_id":"s","model":{"display_name":"M"}}', encoding: 'utf8', env: { ...process.env, HOME: dest, USERPROFILE: dest, NO_COLOR: '1' } });
  assert.strictEqual(fresh, 'M');
});

test('applyInstall leaves no temp file behind and keeps valid JSON', () => {
  const dir = tmp();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }));
  applyInstall({ settingsPath, hookPath: path.join(dir, 'claude-report', 'hook.js'), configDir: path.join(dir, 'cfg') });
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).model, 'sonnet');
});

test('redact covers JWTs, URL credentials and private keys', () => {
  assert.ok(!redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk1234').includes('eyJ'));
  assert.ok(!redact('git clone https://user:hunter2@github.com/x/y').includes('hunter2'));
  assert.ok(!redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----').includes('MIIabc'));
});

test('claude runs without a session file, in the work folder', async () => {
  let seen;
  const { EventEmitter } = require('events');
  const spawn = (_b, args, opts) => {
    seen = { args, opts };
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { on() {}, end() { setImmediate(() => { c.stdout.emit('data', 'ok'); c.emit('close', 0); }); } };
    return c;
  };
  assert.strictEqual(await runClaude({ model: 'haiku', effort: 'low', prompt: 'p', spawn }), 'ok');
  assert.ok(seen.args.includes('--no-session-persistence'));
  assert.strictEqual(seen.opts.cwd, WORK_DIR);
});

test('an earlier ide-companio config is carried over so Disconnect restores the old status line', () => {
  const { migrateLegacy, planInstall } = require('../src/install');
  const oldDir = tmp();
  const newDir = path.join(tmp(), 'claude-report');
  fs.writeFileSync(path.join(oldDir, 'config.json'), JSON.stringify({ chain: 'old-app.exe --x' }));
  assert.strictEqual(migrateLegacy(newDir, oldDir), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).chain, 'old-app.exe --x');
  assert.strictEqual(migrateLegacy(newDir, oldDir), false, 'never overwrites');
  const legacy = { statusLine: { type: 'command', command: '"C:/n/node.exe" "C:/Users/x/.ide-companio/runtime/bin/hook.js"' } };
  const up = planInstall(legacy, 'C:/x/.claude-report/runtime/bin/hook.js');
  assert.strictEqual(up.legacy, true);
  assert.ok(up.settings.statusLine.command.includes('.claude-report'));
  assert.strictEqual(up.chain, null, 'the saved chain is kept, not overwritten');
  assert.strictEqual(planInstall({ statusLine: { type: 'command', command: '"n" "C:/x/.claude-report/runtime/bin/hook.js"' } }, 'C:/x/.claude-report/runtime/bin/hook.js').already, true);
});
