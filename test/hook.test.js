'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../bin/hook');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
const input = JSON.stringify({
  session_id: 's1', cwd: '/p', model: { display_name: 'Opus' },
  context_window: { used_percentage: 12.4 },
  rate_limits: { five_hour: { used_percentage: 30 }, seven_day: { used_percentage: 41 } },
});

test('chain: passes the original input and prints its stdout unchanged', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ chain: 'orig --x' }));
  let call;
  const spawn = (cmd, args, opts) => { call = { cmd, args, opts }; return { stdout: 'ORIGINAL\x1b[0m\n' }; };
  assert.strictEqual(run(input, { dir, spawn }), 'ORIGINAL\x1b[0m\n');
  assert.strictEqual(call.cmd, 'orig');
  assert.deepStrictEqual(call.args, ['--x']);
  assert.strictEqual(call.opts.input, input);
  assert.ok(!call.opts.shell, 'a plain command runs without a shell');
  assert.ok(fs.existsSync(path.join(dir, 'live', 's1.json')));
});

test('no chain: our own line, omitting absent parts', () => {
  const dir = tmp();
  const spawn = () => assert.fail('must not spawn');
  assert.strictEqual(run(input, { dir, spawn }), 'Opus · ctx 12% · 5h 30% · 7d 41%');
  const min = JSON.stringify({ session_id: 's2', model: { display_name: 'Haiku' } });
  assert.strictEqual(run(min, { dir, spawn }), 'Haiku');
});

test('garbage input and failing chain never throw', () => {
  const dir = tmp();
  assert.strictEqual(run('not json', { dir }), '');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ chain: 'x' }));
  assert.doesNotThrow(() => run(input, { dir, spawn: () => { throw new Error('boom'); } }));
});

test('a chain that prints nothing falls back to our own line', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ chain: 'closed-app.exe' }));
  assert.strictEqual(run(input, { dir, spawn: () => ({ stdout: '' }) }), 'Opus · ctx 12% · 5h 30% · 7d 41%');
  assert.strictEqual(run(input, { dir, spawn: () => { throw new Error('boom'); } }), 'Opus · ctx 12% · 5h 30% · 7d 41%');
});
