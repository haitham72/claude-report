'use strict';

const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/generate');

const good = (name, extra = {}) => ({
  project: name,
  summary: 'Built things.',
  usedFor: ['a'],
  examples: [{ task: 'Do x', withoutAI: '~4 h', withAI: '~45 min', basis: 'Estimate.' }],
  didntWork: [],
  nextMonth: ['b'],
  ...extra
});

const proj = (name, n) => ({
  name,
  totalTokens: 100,
  sessions: 2,
  promptCount: n,
  prompts: Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(), text: `prompt number ${i} with enough text`
  }))
});

test('sliceProject drops short prompts, keeps order, samples evenly', () => {
  const p = proj('a', 200);
  p.prompts.reverse();
  p.prompts.splice(3, 0, { at: 'x', text: 'ok' });
  const s = g.sliceProject(p, { maxPrompts: 20 });
  assert.strictEqual(s.prompts.length, 20);
  assert.ok(s.prompts.every((x) => x.text.length >= 12));
  const idx = s.prompts.map((x) => +/number (\d+)/.exec(x.text)[1]);
  assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b));
  assert.ok(idx[19] > 150);
  assert.strictEqual(s.project, 'a');
  assert.strictEqual(g.sliceProject(proj('b', 5)).prompts.length, 5);
});

test('buildProjectPrompt states the limits and carries the slice', () => {
  const t = g.buildProjectPrompt(g.sliceProject(proj('a', 5)));
  assert.match(t, /invent nothing/i);
  assert.match(t, new RegExp(`at most ${g.LIMITS.summaryWords} words`));
  assert.match(t, /prompt number 0/);
});

test('prompt sampling keeps interruptions separate from the prompt budget', () => {
  const p = proj('a', 75);
  p.interruptions = [{ at: '2026-11-01T02:00:00Z', source: 'claude' }];
  const slice = g.sliceProject(p, { maxPrompts: 5 });
  assert.strictEqual(slice.prompts.length, 5);
  assert.deepStrictEqual(slice.interruptions, p.interruptions);
  assert.match(g.buildProjectPrompt(slice), /"interruptions":\[/);
});

test('parseReport handles fences, prose, garbage', () => {
  const j = JSON.stringify(good('wrong'));
  assert.strictEqual(g.parseReport('```json\n' + j + '\n```', 'p').project, 'p');
  assert.strictEqual(g.parseReport('Here you go: ' + j + ' hope it helps {', 'p').summary, 'Built things.');
  assert.strictEqual(g.parseReport('no json at all', 'p'), null);
  assert.strictEqual(g.parseReport('{"summary": "x"}', 'p'), null);
  assert.strictEqual(g.parseReport(undefined, 'p'), null);
  const r = g.parseReport('{"summary":"s","examples":[{"task":"t"}]}', 'p');
  assert.deepStrictEqual(r.usedFor, []);
  assert.strictEqual(r.examples[0].withAI, '');
});

test('time estimates are opt-in and accept only valid minute pairs', async () => {
  const answer = good('p', { examples: [
    { task: 'Capture reference animations', basis: 'Documented interactions', withoutAIMinutes: 960, withAIMinutes: 120 },
    { task: 'Reviewed an open question', withoutAIMinutes: null, withAIMinutes: 30 },
    { task: 'Ignore invalid durations', withoutAIMinutes: -2, withAIMinutes: '20' }
  ] });
  const baseline = g.parseReport(JSON.stringify(answer), 'p');
  assert.equal(baseline.examples[0].withoutAI, '');
  const result = await g.generateReports({
    projects: [proj('p', 2)], estimateTime: true, run: async (request) => {
      assert.equal(request.estimateTime, true);
      assert.match(request.prompt, /withoutAIMinutes and withAIMinutes/);
      return JSON.stringify(answer);
    }
  });
  const [valid, missing, malformed] = result.reports.p.examples;
  assert.equal(valid.withoutAI, '~2 days');
  assert.equal(valid.withAI, '~2 h');
  assert.equal(valid.timeSource, 'estimated');
  assert.equal(missing.withAI, '');
  assert.equal(malformed.withoutAI, '');
});

test('parseReport truncates over-long fields', () => {
  const w = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
  const r = g.parseReport(JSON.stringify(good('p', {
    summary: '  ' + w(40) + ' ',
    usedFor: Array(g.LIMITS.usedFor + 1).fill(w(40)),
    didntWork: Array(g.LIMITS.didntWork + 1).fill('Specific correction'),
    examples: Array(g.LIMITS.examples + 1).fill({ task: w(30), detail: w(60), withoutAI: '~1 h', withAI: '~5 min', basis: w(40) })
  })), 'p');
  assert.strictEqual(r.summary.split(' ').length, g.LIMITS.summaryWords);
  assert.ok(r.summary.endsWith('…'));
  assert.strictEqual(r.usedFor.length, g.LIMITS.usedFor);
  assert.strictEqual(r.usedFor[0].split(' ').length, g.LIMITS.itemWords);
  assert.strictEqual(r.didntWork.length, g.LIMITS.didntWork);
  assert.strictEqual(r.examples.length, g.LIMITS.examples);
  assert.strictEqual(r.examples[0].detail.split(' ').length, g.LIMITS.detailWords);
  assert.strictEqual(r.examples[0].basis.split(' ').length, g.LIMITS.basisWords);
  assert.strictEqual(g.parseReport(JSON.stringify(good('p')), 'p').summary, 'Built things.');
});

test('expanded length adapts to evidence while preserving the concise summary', () => {
  const project = proj('long', 60);
  const slice = g.sliceProject(project);
  assert.match(g.buildProjectPrompt(slice, { previousWords: 138 }), /Aim for about 235 words/);
  assert.doesNotMatch(g.buildProjectPrompt(g.sliceProject(proj('short', 2))), /Aim for about/);
  assert.equal(g.expandedProjectWords(good('p', {
    examples: [{ task: 'Add chart', detail: 'Show reset windows', basis: 'One prompt' }]
  })), 9);
});

test('a thin draft with enough evidence gets a single expansion pass', async () => {
  const project = proj('p', 60);
  let requests = 0;
  const { reports } = await g.generateReports({ projects: [project], models: { project: {}, finalizer: null }, run: async ({ prompt }) => {
    requests++;
    if (requests === 1) return JSON.stringify(good('p'));
    assert.match(prompt, /Revise the first draft/);
    return JSON.stringify(good('p', { examples: [{ task: 'Do x', detail: 'Covered the dated request and the constraint it set.' }] }));
  } });
  assert.strictEqual(requests, 2);
  assert.match(reports.p.examples[0].detail, /dated request/);
});

test('concurrency never exceeds the limit', async () => {
  let active = 0;
  let peak = 0;
  const run = async ({ prompt }) => {
    if (prompt.includes('Tighten')) throw new Error('skip');
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return JSON.stringify(good('x'));
  };
  const projects = Array.from({ length: 8 }, (_, i) => proj('p' + i, 6));
  const res = await g.generateReports({ projects, run, concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.strictEqual(Object.keys(res.reports).length, 8);
});

test('one failure does not abort the others; minPrompts skips', async () => {
  const events = [];
  const run = async ({ prompt }) => {
    if (prompt.includes('Tighten')) throw new Error('no finalizer');
    if (prompt.includes('"project":"bad"')) throw new Error('model down');
    if (prompt.includes('"project":"junk"')) return 'garbage';
    return JSON.stringify(good('x'));
  };
  const res = await g.generateReports({
    projects: [proj('ok', 6), proj('bad', 6), proj('junk', 6), proj('tiny', 0)],
    run,
    onProgress: (e) => events.push(e)
  });
  assert.deepStrictEqual(Object.keys(res.reports), ['ok']);
  assert.deepStrictEqual(res.failed.sort(), ['bad', 'junk']);
  assert.strictEqual(res.usedFinalizer, false);
  assert.deepStrictEqual(events.filter((e) => e.project === 'tiny').map((e) => e.status), ['skipped']);
  assert.deepStrictEqual(events.filter((e) => e.project === 'ok').map((e) => e.status), ['queued', 'gathering', 'working', 'done']);
  assert.ok(events.some((e) => e.project === 'bad' && e.status === 'failed' && /model down/.test(e.error)));
  assert.ok(events.some((e) => e.stage === 'finalizing'));
});

test('finalizer success replaces the reports', async () => {
  const calls = [];
  const run = async ({ model, prompt }) => {
    calls.push(model);
    if (prompt.includes('Tighten')) return JSON.stringify([good('a', { summary: 'Tight a.' }), good('b', { summary: 'Tight b.' })]);
    return JSON.stringify(good('x'));
  };
  const res = await g.generateReports({ projects: [proj('a', 5), proj('b', 5)], run });
  assert.strictEqual(res.usedFinalizer, true);
  assert.strictEqual(res.reports.a.summary, 'Tight a.');
  assert.strictEqual(calls.filter((m) => m === 'sonnet').length, 1);
});

test('finalizer garbage or wrong project set falls back', async () => {
  for (const reply of ['nope', JSON.stringify([good('a')]), JSON.stringify([good('a'), good('zzz')])]) {
    const run = async ({ prompt }) => (prompt.includes('Tighten') ? reply : JSON.stringify(good('x')));
    const res = await g.generateReports({ projects: [proj('a', 5), proj('b', 5)], run });
    assert.strictEqual(res.usedFinalizer, false);
    assert.strictEqual(res.reports.a.summary, 'Built things.');
    assert.strictEqual(res.reports.b.project, 'b');
  }
  const res = await g.generateReports({ projects: [proj('a', 5)], run: async () => JSON.stringify(good('x')), models: { project: { model: 'haiku', effort: 'low' }, finalizer: null } });
  assert.strictEqual(res.usedFinalizer, false);
});

test('a prompt note is kept, cut to its word limit, and left out when empty', () => {
  const long = Array(60).fill('word').join(' ');
  const kept = g.parseReport(JSON.stringify(good('a', { promptNote: long })), 'a');
  assert.strictEqual(kept.promptNote.split(' ').length, 24);
  assert.ok(!('promptNote' in g.parseReport(JSON.stringify(good('a', { promptNote: '  ' })), 'a')));
  assert.ok(!('promptNote' in g.parseReport(JSON.stringify(good('a')), 'a')));
});
