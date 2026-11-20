'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mergeLive } = require('../src/live-merge');

const w = (pct) => ({ pct, resetsAt: 2000000000 });
const hook = { model: 'Sonnet', ctxPct: 20, updatedAt: 1, stale: false, fiveHour: w(10), sevenDay: w(20) };
const transcript = { model: 'sonnet-5-5', ctxPct: 33, updatedAt: 2, stale: false, fiveHour: null, sevenDay: null };

test('a fresh hook wins for everything', () => {
  const m = mergeLive({ hook, transcript });
  assert.strictEqual(m.model, 'Sonnet');
  assert.strictEqual(m.fiveHour.pct, 10);
  assert.strictEqual(m.source, 'hook');
});

test('without a hook the transcript gives model and context and no plan windows', () => {
  const m = mergeLive({ hook: null, transcript });
  assert.strictEqual(m.model, 'sonnet-5-5');
  assert.strictEqual(m.ctxPct, 33);
  assert.strictEqual(m.fiveHour, null);
  assert.strictEqual(m.source, 'transcript');
});

test('a stale hook yields to the transcript for model and context but keeps the plan windows', () => {
  const m = mergeLive({ hook: { ...hook, stale: true }, transcript });
  assert.strictEqual(m.model, 'sonnet-5-5');
  assert.strictEqual(m.fiveHour.pct, 10);
  assert.strictEqual(m.sevenDay.pct, 20);
});

test('nothing at all gives null', () => {
  assert.strictEqual(mergeLive({ hook: null, transcript: null }), null);
});
