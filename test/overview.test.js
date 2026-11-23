'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEntry, parseOverview, generateOverview } = require('../src/overview');

const projects = [{ name: 'a', totalTokens: 100 }, { name: 'b', totalTokens: 50 }];
const reports = { a: { summary: 's', examples: [{ task: 't', withoutAI: '~2 h', withAI: '~30 min' }], didntWork: [], nextMonth: ['n'] } };

test('buildEntry totals the estimated hours and leaves out unreported projects', () => {
  const e = buildEntry({ user: 'sam', month: '2026-11', projects, reports });
  assert.strictEqual(e.projects.length, 1);
  assert.strictEqual(e.totals.estimatedHoursSaved, 1.5);
  assert.strictEqual(e.totals.projects, 2);
  assert.ok(!JSON.stringify(e).includes('prompts'));
});

test('overview inputs prioritize sustained activity over a larger single-day project', () => {
  const entry = buildEntry({ month: '2026-11', reports: { launch: reports.a, sustained: reports.a }, projects: [
    { id: 'launch', name: 'Launch', totalTokens: 200, promptCount: 6, daily: { '2026-11-19': 200 } },
    { id: 'sustained', name: 'Sustained', totalTokens: 100, promptCount: 2, daily: { '2026-11-03': 30, '2026-11-14': 70 } }
  ] });
  assert.deepStrictEqual(entry.projects.map((project) => project.name), ['Sustained', 'Launch']);
  assert.strictEqual(entry.projects[0].activeDays, 2);
  assert.strictEqual(entry.projects[0].firstActiveDay, '2026-11-03');
  assert.strictEqual(entry.projects[0].lastActiveDay, '2026-11-14');
  assert.strictEqual(entry.projects[0].promptCount, 2);
});

test('parseOverview accepts fenced JSON, trims to the word limits, rejects empties', () => {
  const long = Array(60).fill('word').join(' ');
  const o = parseOverview('```json\n' + JSON.stringify({ summary: long, goal: 'g', achievement: 'a' }) + '\n```');
  assert.strictEqual(o.summary.split(' ').length, 30);
  assert.strictEqual(parseOverview('{"summary":"x","goal":"","achievement":"y"}'), null);
  assert.strictEqual(parseOverview('no json'), null);
});

test('generateOverview sends the skill text and the entry, and returns null on failure', async () => {
  let seen;
  const ok = await generateOverview({ entry: { x: 1 }, run: async (a) => { seen = a; return '{"summary":"s","goal":"g","achievement":"a"}'; } });
  assert.deepStrictEqual(ok, { summary: 's', goal: 'g', achievement: 'a' });
  assert.strictEqual(seen.model, 'sonnet');
  assert.strictEqual(seen.effort, 'high');
  assert.ok(seen.prompt.includes('## Exit') && seen.prompt.includes('"x":1'));
  assert.strictEqual(await generateOverview({ entry: {}, run: async () => { throw new Error('boom'); } }), null);
});

test('generateOverview forwards and propagates cancellation', async () => {
  const controller = new AbortController();
  await assert.rejects(generateOverview({ entry: {}, signal: controller.signal, run: async ({ signal }) => {
    assert.strictEqual(signal, controller.signal);
    controller.abort();
    return '{"summary":"s","goal":"g","achievement":"a"}';
  } }), { name: 'AbortError' });
});

test('parseOverview survives prose braces around the JSON', () => {
  const j = JSON.stringify({ summary: 's', goal: 'g', achievement: 'a' });
  assert.strictEqual(parseOverview('Here {is} your result: ' + j + ' and {done}').summary, 's');
});

test('turn-only days count as active days', () => {
  const e = buildEntry({ month: '2026-11', reports: { c: reports.a }, projects: [{ id: 'c', name: 'C', totalTokens: 0, promptCount: 0, daily: {}, dailyTurns: { '2026-11-03': 2, '2026-11-04': 1 } }] });
  assert.strictEqual(e.projects[0].activeDays, 2);
});
