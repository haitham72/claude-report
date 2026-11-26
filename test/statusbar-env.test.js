'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { statusItems, bar, levelColor, MAX_ITEMS } = require('../src/statusbar');
const { isEnvLeak, redact, scrubDeep } = require('../src/scan');

const cmd = { open: 'open', connect: 'connect' };
const live = { model: 'Sonnet', ctxPct: 23, fiveHour: { pct: 16, resetsAt: 2000000000 }, sevenDay: { pct: 28, resetsAt: 2000000000 }, stale: false };

test('bar fills proportionally to pct', () => {
  assert.deepStrictEqual([0, 16, 40, 60, 100].map(bar), ['░░░░░', '█░░░░', '██░░░', '███░░', '█████']);
  assert.strictEqual(bar(999).length, 5);
  assert.strictEqual(bar(-5).length, 5);
  assert.deepStrictEqual([10, 50, 79, 80].map(levelColor), ['#34c759', '#ff9f0a', '#ff9f0a', '#ff453a']);
});

test('connected: model, a bar and label per window, then context', () => {
  const items = statusItems(live, cmd);
  assert.deepStrictEqual(items.map((i) => i.text), ['Sonnet', '█░░░░', '5h 16%', '█░░░░', '7d 28%', 'ctx 23%']);
  assert.ok(items.length <= MAX_ITEMS);
  assert.strictEqual(items[1].color, '#34c759');
  assert.ok(items.every((i) => i.command === 'open'));
});

test('missing windows and a stale reading degrade quietly', () => {
  const items = statusItems({ model: 'Haiku', ctxPct: null, fiveHour: null, sevenDay: null, stale: true }, cmd);
  assert.deepStrictEqual(items.map((i) => i.text), ['$(clock) Haiku']);
});

test('not connected shows one item that connects', () => {
  const items = statusItems(null, cmd);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].command, 'connect');
});

test('prompts that name a .env file or paste env lines are blocked', () => {
  assert.ok(isEnvLeak('why does it fail, I put the key in .env.local'));
  assert.ok(isEnvLeak('cat .env'));
  assert.ok(isEnvLeak('DATABASE_URL=postgres://x\nOPENAI_KEY=abc'));
  assert.ok(!isEnvLeak('the environment variable setup is done'));
  assert.ok(!isEnvLeak('set MODE=fast once'));
});

test('redact and scrubDeep remove env files and lines from any text', () => {
  assert.ok(!/\.env/.test(redact('open .env.production and check')));
  assert.ok(!/SECRET_NAME/.test(redact('export SECRET_NAME=value123')));
  const clean = scrubDeep({ summary: 'edited .env.local', list: ['API_URL=https://x'], n: 3 });
  assert.ok(!/\.env/.test(clean.summary) && !/API_URL/.test(clean.list[0]));
  assert.strictEqual(clean.n, 3);
});
