'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { openMailDraft, mailtoUrl } = require('../src/mail');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-test-'));
const file = path.join(tmp, 'r.html');
fs.writeFileSync(file, 'x');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeSpawn(code = 0) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { c.killed = true; };
    calls.push({ cmd, args, opts });
    setImmediate(() => c.emit('close', code));
    return c;
  };
  fn.calls = calls;
  return fn;
}

test('win32 passes values by env only', async () => {
  const subject = 'He said "hi" `whoami` $(calc) \'';
  const spawn = fakeSpawn();
  const r = await openMailDraft({ file, to: 'a@b.c', subject, body: 'B"$(x)', platform: 'win32', spawn });
  assert.deepStrictEqual(r, { ok: true, method: 'outlook-com' });
  const { cmd, args, opts } = spawn.calls[0];
  assert.strictEqual(cmd, 'powershell.exe');
  assert.deepStrictEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.strictEqual(opts.env.CR_SUBJECT, subject);
  assert.strictEqual(opts.env.CR_FILE, file);
  assert.strictEqual(opts.env.CR_TO, 'a@b.c');
  for (const v of [subject, file, 'a@b.c', 'B"$(x)']) assert.ok(!args.join(' ').includes(v));
});

test('win32 failure and spawn error', async () => {
  const r = await openMailDraft({ file, platform: 'win32', spawn: fakeSpawn(1) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.method, 'outlook-com');
  const bad = () => { throw new Error('ENOENT'); };
  const r2 = await openMailDraft({ file, platform: 'win32', spawn: bad });
  assert.strictEqual(r2.ok, false); assert.match(r2.error, /ENOENT/);
});

test('darwin uses argv', async () => {
  const spawn = fakeSpawn();
  const r = await openMailDraft({ file, to: 'a@b.c', subject: 'S "q"', body: 'B', platform: 'darwin', spawn });
  assert.strictEqual(r.method, 'outlook-applescript'); assert.ok(r.ok);
  const { cmd, args } = spawn.calls[0];
  assert.strictEqual(cmd, 'osascript');
  assert.deepStrictEqual(args.slice(-4), [file, 'a@b.c', 'S "q"', 'B']);
  assert.ok(args.includes('on run argv'));
});

test('unsupported platform spawns nothing', async () => {
  const spawn = fakeSpawn();
  const r = await openMailDraft({ file, platform: 'linux', spawn });
  assert.deepStrictEqual(r, { ok: false, method: 'none', error: 'no supported mail client' });
  assert.strictEqual(spawn.calls.length, 0);
});

test('missing or relative file fails before spawning', async () => {
  const spawn = fakeSpawn();
  for (const f of [path.join(tmp, 'nope.html'), 'r.html', undefined]) {
    const r = await openMailDraft({ file: f, platform: 'win32', spawn });
    assert.strictEqual(r.ok, false); assert.match(r.error, /not found/);
  }
  assert.strictEqual(spawn.calls.length, 0);
});

test('mailtoUrl encodes and trims', () => {
  const u = mailtoUrl({ to: 'a@b.c', subject: 'a b&c', body: 'x'.repeat(2000) });
  assert.ok(u.startsWith('mailto:a%40b.c?subject=a%20b%26c&body='));
  assert.strictEqual(u.split('&body=')[1].length, 1500);
});
