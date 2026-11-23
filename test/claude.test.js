'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { runClaude } = require('../src/claude');

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdinData = '';
    child.stdin.on('data', (d) => { child.stdinData += d; });
    calls.push({ bin, args, opts, child });
    behave(child);
    return child;
  };
  return { spawn, calls };
}

test('prompt goes through stdin, args carry model and effort', async () => {
  const { spawn, calls } = fakeSpawn((c) => {
    c.stdin.on('finish', () => {
      c.stdout.write('  hello \n');
      c.emit('close', 0);
    });
  });
  const out = await runClaude({ model: 'haiku', effort: 'medium', prompt: 'secret prompt text', spawn });
  assert.strictEqual(out, 'hello');
  const { args, child } = calls[0];
  assert.ok(args.includes('-p'));
  assert.strictEqual(args[args.indexOf('--model') + 1], 'haiku');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'medium');
  assert.ok(!args.some((a) => a.includes('secret prompt text')));
  assert.strictEqual(child.stdinData, 'secret prompt text');
});

test('bad model or effort is rejected before spawning', async () => {
  const { spawn, calls } = fakeSpawn(() => {});
  await assert.rejects(runClaude({ model: 'haiku; rm -rf /', effort: 'low', prompt: 'x', spawn }), /model/);
  await assert.rejects(runClaude({ model: 'haiku', effort: 'extreme', prompt: 'x', spawn }), /effort/);
  assert.strictEqual(calls.length, 0);
});

test('a structured request passes its schema without a shell and unwraps the CLI result', async () => {
  const schema = { type: 'object', properties: { review: { type: 'string' } } };
  const result = { review: 'Done' };
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdin.on('finish', () => {
      child.stdout.write(JSON.stringify({ type: 'result', result: '', structured_output: result }));
      child.emit('close', 0);
    });
  });
  const output = await runClaude({ model: 'haiku', effort: 'medium', prompt: 'sample', schema, spawn });
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(calls[0].opts.shell, false);
  const { args } = calls[0];
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
});

test('non-zero exit rejects with the end of stderr', async () => {
  const { spawn } = fakeSpawn((c) => {
    setImmediate(() => {
      c.stderr.write('x'.repeat(500) + 'LAST WORDS');
      setImmediate(() => c.emit('close', 2));
    });
  });
  await assert.rejects(runClaude({ model: 'sonnet', effort: 'high', prompt: 'p', spawn }), (e) => {
    assert.match(e.message, /code 2/);
    assert.match(e.message, /LAST WORDS/);
    assert.ok(e.message.length < 400);
    return true;
  });
});

test('timeout kills the child and rejects', async () => {
  const { spawn, calls } = fakeSpawn(() => {});
  await assert.rejects(runClaude({ model: 'haiku', effort: 'low', prompt: 'p', timeoutMs: 20, spawn }), /timed out/);
  assert.strictEqual(calls[0].child.killed, true);
});

test('cancelling Claude kills the active child and prevents another launch', async () => {
  const { spawn, calls } = fakeSpawn(() => {});
  const controller = new AbortController();
  const options = { model: 'haiku', effort: 'low', prompt: 'p', spawn, signal: controller.signal };
  const run = runClaude(options);
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.strictEqual(calls[0].child.killed, true);
  await assert.rejects(runClaude(options), { name: 'AbortError' });
  assert.strictEqual(calls.length, 1);
});

test('spawn error rejects', async () => {
  const { spawn } = fakeSpawn((c) => setImmediate(() => c.emit('error', new Error('ENOENT'))));
  await assert.rejects(runClaude({ model: 'haiku', effort: 'low', prompt: 'p', spawn }), /ENOENT/);
  await assert.rejects(runClaude({ model: 'haiku', effort: 'low', prompt: 'p', spawn: () => { throw new Error('boom'); } }), /boom/);
});

const { resolveClaude } = require('../src/claude');

test('Windows resolver runs an npm claude.cmd shim as node + cli.js, an .exe directly, and gives up quietly', () => {
  const dir = 'C:/npm';
  const cli = require('path').join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const shim = { exec: () => [dir + '/claude', dir + '/claude.cmd'].join('\r\n'), read: () => String.raw`"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`, exists: (p) => p === cli };
  assert.deepEqual(resolveClaude({ platform: 'win32', ...shim }), { command: 'node', prefix: [cli] });
  assert.deepEqual(resolveClaude({ platform: 'win32', exec: () => 'C:/bin/claude.exe\r\n' }), { command: 'C:/bin/claude.exe', prefix: [] });
  assert.equal(resolveClaude({ platform: 'win32', exec: () => { throw new Error('not found'); } }), null);
  assert.equal(resolveClaude({ platform: 'linux', exec: () => { throw new Error('unused'); } }), null);
});

test('a structured request spawns the resolved command', async () => {
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify({ structured_output: { a: 1 } })); child.emit('close', 0); });
  });
  await runClaude({ model: 'haiku', effort: 'low', prompt: 'p', schema: { type: 'object' }, spawn, resolve: () => ({ command: 'node', prefix: ['cli.js'] }) });
  assert.equal(calls[0].bin, 'node');
  assert.equal(calls[0].args[0], 'cli.js');
});
