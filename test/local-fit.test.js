'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickModel, fitAdvice, fittingModels } = require('../src/local-fit');
const lm = require('../src/local-models');

const GB = 1e9;
const gpu = { name: 'RTX', totalMiB: 16384, freeMiB: 8300 };
const models = [
  { id: 'big-9b', sizeBytes: 9.7 * GB, reportContext: 0 },
  { id: 'mid-6b', sizeBytes: 6 * GB, reportContext: 10240 },
  { id: 'small-4b', sizeBytes: 3.9 * GB, reportContext: 65536 },
  { id: 'tiny-1b', sizeBytes: 1 * GB, reportContext: 131072 },
];

test('auto-pick takes the loaded model, else the largest comfortable fit', () => {
  assert.strictEqual(pickModel(models).id, 'small-4b');
  assert.strictEqual(pickModel([...models, { id: 'x', state: 'loaded' }]).id, 'x');
  assert.strictEqual(pickModel(models, 'big-9b').id, 'big-9b');
  assert.strictEqual(pickModel(models, 'missing'), null);
  assert.deepStrictEqual(fittingModels(models).map((m) => m.id), ['small-4b', 'tiny-1b', 'mid-6b']);
  // Nothing fits: the smallest known model, so the run can still try.
  assert.strictEqual(pickModel([{ id: 'a', sizeBytes: 9 * GB, reportContext: 0 }, { id: 'b', sizeBytes: 5 * GB, reportContext: 0 }]).id, 'b');
});

test('advice: spill when the weights do not fit, tight when context is short, silent otherwise', () => {
  const spill = fitAdvice(models[0], gpu, models);
  assert.strictEqual(spill.kind, 'spill');
  assert.match(spill.message, /8\.1 GB of 16 GB GPU memory is free\. big-9b needs about 9\.7 GB/);
  assert.strictEqual(spill.alt.id, 'small-4b');
  const tight = fitAdvice(models[1], gpu, models);
  assert.strictEqual(tight.kind, 'tight');
  assert.match(tight.message, /limited to 10k tokens/);
  assert.strictEqual(fitAdvice(models[2], gpu, models), null);
  assert.strictEqual(fitAdvice({ ...models[0], state: 'loaded' }, gpu, models), null);
  assert.strictEqual(fitAdvice(models[0], null, models), null, 'no NVIDIA card: nothing to measure, no prompt');
  assert.strictEqual(fitAdvice({ id: 'u', reportContext: null }, gpu, models), null);
});

test('startEngine runs `lms server start` when LM Studio is down, then waits for it', async () => {
  let up = false;
  const calls = [];
  const fetchImpl = async () => { if (!up) throw new Error('down'); return { ok: true, json: async () => ({}) }; };
  const exec = async (cmd, args) => { calls.push(args.join(' ')); up = true; return ''; };
  assert.strictEqual(await lm.startEngine('lmstudio', { exec, fetchImpl, pollMs: 1 }), true);
  assert.deepStrictEqual(calls, ['server start']);
  // Already up: nothing is started.
  calls.length = 0;
  assert.strictEqual(await lm.startEngine('lmstudio', { exec, fetchImpl, pollMs: 1 }), true);
  assert.deepStrictEqual(calls, []);
});

// Never touch the real machine: no LM Studio app on this fake disk, and spawn is recorded, not run.
const noApp = { statSync() { throw new Error('ENOENT'); } };
const fakeSpawn = (log) => (cmd, args) => { log.push([cmd, ...args].join(' ')); return { on() {}, unref() {} }; };

test('startEngine gives up when no lms binary works or the server never answers', async () => {
  const down = async () => { throw new Error('down'); };
  const spawned = [];
  assert.strictEqual(await lm.startEngine('lmstudio', { exec: async () => { throw new Error('ENOENT'); }, fetchImpl: down, fsImpl: noApp, spawn: fakeSpawn(spawned), pollMs: 1, waitMs: 20 }), false);
  assert.strictEqual(await lm.startEngine('lmstudio', { exec: async () => '', fetchImpl: down, fsImpl: noApp, spawn: fakeSpawn(spawned), waitMs: 20, pollMs: 5 }), false);
  assert.deepStrictEqual(spawned, [], 'no app on disk: nothing launched');
  const ollama = [];
  assert.strictEqual(await lm.startEngine('ollama', { spawn: fakeSpawn(ollama), fetchImpl: down, waitMs: 20, pollMs: 5 }), false);
  assert.deepStrictEqual(ollama, ['ollama serve']);
});

test('when lms cannot wake the service, startEngine opens the LM Studio app and asks again', async () => {
  let up = false;
  const execs = [];
  const spawned = [];
  const fetchImpl = async () => { if (!up) throw new Error('down'); return { ok: true, json: async () => ({}) }; };
  const exec = async (cmd, args) => { execs.push(args.join(' ')); if (spawned.length) up = true; return ''; };
  const hasApp = { statSync: () => ({ isFile: () => true, isDirectory: () => false }) };
  assert.strictEqual(await lm.startEngine('lmstudio', { exec, fetchImpl, fsImpl: hasApp, spawn: fakeSpawn(spawned), waitMs: 50, pollMs: 5 }), true);
  assert.strictEqual(spawned.length, 1);
  assert.ok(execs.length >= 2 && execs.every((a) => a === 'server start'));
});
