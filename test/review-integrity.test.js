'use strict';

// Cost guards, evidence attribution and wording safeguards added in 0.10.5.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { runClaude } = require('../src/claude');
const { requestBudget, mapLimit, plannedRequests, DEEP_CONCURRENCY } = require('../src/request-budget');
const { deepPrompt } = require('../src/scan');
const { prepareReview, auditProject, budgetFor, projectPlan } = require('../src/deep-review');
const { scanCodex } = require('../src/codex-activity');
const { parseReport, buildProjectPrompt } = require('../src/generate');
const { buildEntry, buildDeepEntry, parseOverview } = require('../src/overview');

const prompt = (text, session = 'one', date = '2026-11-20') => deepPrompt(text, date + 'T12:00:00Z', session, 'claude');

test('a Deep run cannot fan out across depths: only the planned depth and request count run', async () => {
  const plan = Array.from({ length: 5 }, (_, i) => ({ name: 'P' + i, chunks: 1, reused: false }));
  const { limit, review } = plannedRequests(plan);
  assert.equal(review, 5);
  const seen = [];
  const guard = requestBudget({ depth: 'medium', limits: { 'deep-review': limit, overview: 1 } });
  const run = guard(async (request) => { seen.push(request.depth); return '{}'; });
  const outcomes = [];
  // The 15-run mistake: every project at every effort.
  for (const depth of ['low', 'medium', 'high']) {
    for (const project of plan) {
      outcomes.push(await run({ kind: 'deep-review', depth, label: project.name }).then(() => 'ran', () => 'refused'));
    }
  }
  assert.equal(outcomes.filter((outcome) => outcome === 'ran').length, 5);
  assert.deepEqual([...new Set(seen)], ['medium']);
  await run({ kind: 'overview' });
  await assert.rejects(run({ kind: 'overview' }), /1 overview request planned, none left/);
  await assert.rejects(run({ kind: 'project' }), /not planned for this run/);
  assert.equal(guard.used()['deep-review'], 5);
});

test('cached reviews add no requests, and each split project may use one extra', () => {
  const { review, limit } = plannedRequests([
    { chunks: 1, reused: true }, { chunks: 2, reused: false }, { chunks: 1, reused: false }
  ]);
  assert.equal(review, 3);
  assert.equal(limit, 5);
});

test('project reviews run at most three at a time and keep their order', async () => {
  let active = 0, peak = 0;
  const results = await mapLimit(Array.from({ length: 10 }, (_, i) => i), DEEP_CONCURRENCY, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return item * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
});

test('a missing Claude Code executable fails once instead of respawning without end', async () => {
  let starts = 0;
  const spawn = () => {
    starts++;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(runClaude({ model: 'haiku', effort: 'low', prompt: 'p', schema: { type: 'object' }, spawn }), /could not start/);
  assert.equal(starts, 1);
});

test('Codex subagent briefs are not counted as prompts, while their tokens still count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-subagent-'));
  const at = '2026-11-18T12:00:00Z';
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 };
  const record = (type, payload) => JSON.stringify({ type, timestamp: at, payload });
  const session = (name, meta, message) => fs.writeFileSync(path.join(root, 'rollout-' + name + '.jsonl'), [
    record('session_meta', { cwd: root, ...meta }),
    record('event_msg', { type: 'user_message', message }),
    record('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } })
  ].join('\n'));
  session('main', {}, 'Please add the export button.');
  session('child', { source: { subagent: true } }, 'You are a subagent. Implement the export button.');
  const from = new Date('2000-01-01T00:00:00Z'), to = new Date('2099-01-01T00:00:00Z');
  const [quick] = scanCodex(from, to, root);
  assert.equal(quick.promptCount, 1);
  assert.equal(quick.prompts[0].text, 'Please add the export button.');
  assert.equal(quick.sessions, 1);
  assert.equal(quick.totalTokens, 30);
  const [deep] = scanCodex(from, to, root, { deep: true });
  assert.equal(deep.promptCount, 1);
  assert.equal(deep.totalTokens, 15);
});

test('a Deep finding keeps the checked excerpt, and a split project keeps both batch summaries', async () => {
  const review = prepareReview({ name: 'Split', prompts: [
    prompt('Verify keyboard navigation after the change lands in the dialog.', 'a'),
    prompt('Explain why the export button disappears when the list is empty.', 'b')
  ] });
  const answers = [
    { summary: 'First batch checks navigation.', strengths: [{ id: 'P1', quote: 'Verify keyboard navigation after the change', text: 'Names a check.' }], opportunities: [], rewrite: '', contextNote: '' },
    { summary: 'Second batch asks for causes.', strengths: [], opportunities: [{ id: 'P2', quote: 'why the export button disappears', text: 'Name the expected state.' }], rewrite: 'Do it.', contextNote: '' }
  ];
  let call = 0;
  const run = async (request) => { assert.equal(request.depth, 'low'); return JSON.stringify(answers[call++]); };
  const plan = { ...projectPlan(review, budgetFor(8192), 'low'), chunks: [[review.rows[0]], [review.rows[1]]], split: 'session batches', fragments: 0 };
  const result = await auditProject({ review, level: 'low', plan, run, model: { model: 'haiku' }, budget: budgetFor(8192), context: 8192 });
  assert.equal(call, 2);
  assert.deepEqual(result.strengthItems, [{ id: 'P1', quote: 'Verify keyboard navigation after the change', text: 'Names a check.' }]);
  assert.equal(result.opportunityItems[0].quote, 'why the export button disappears');
  assert.match(result.summary, /First batch checks navigation\. Second batch asks for causes\./);
  assert.equal(result.batches, 2);
});

test('a finding whose excerpt is not in the prompt is dropped before it can be shown', async () => {
  const review = prepareReview({ name: 'Solo', prompts: [prompt('Please verify the parser output before merging.')] });
  const run = async () => JSON.stringify({ summary: 'Short.', strengths: [{ id: 'P1', quote: 'an invented sentence the user never wrote', text: 'Made up.' }], opportunities: [], rewrite: '', contextNote: '' });
  const result = await auditProject({ review, level: 'low', run, model: { model: 'haiku' }, budget: budgetFor(8192), context: 8192 });
  assert.deepEqual(result.strengthItems, []);
  assert.match(result.summary, /did not produce observations/);
});

test('example status is kept, validated, and a bare request carries no saved time', () => {
  const text = JSON.stringify({ project: 'A', summary: 'Work.', usedFor: [], didntWork: [], nextMonth: [], examples: [
    { task: 'Asked', status: 'requested', detail: 'd', basis: 'b', withoutAIMinutes: 120, withAIMinutes: 30 },
    { task: 'Changed', status: 'recorded', detail: 'd', basis: 'b', withoutAIMinutes: 120, withAIMinutes: 30 },
    { task: 'Guessed', status: 'done!', detail: 'd', basis: 'b', withoutAIMinutes: 60, withAIMinutes: 30 }
  ] });
  const { examples } = parseReport(text, 'A', { estimateTime: true });
  assert.equal(examples[0].status, 'requested');
  assert.equal(examples[0].withoutAI, '');
  assert.equal(examples[1].status, 'recorded');
  assert.equal(examples[1].withoutAI, '~2 h');
  assert.equal('status' in examples[2], false);
  assert.match(buildProjectPrompt({ project: 'A', prompts: [] }, { estimateTime: true }), /status is requested/);
});

test('the overview entry lists commit days apart from active days and ignores requested hours', () => {
  const project = { name: 'A', id: 'a', totalTokens: 10, daily: { '2026-11-19': 10 }, promptCount: 2,
    git: { repositories: [{ commits: [{ at: '2026-11-18T12:00:00Z' }, { at: '2026-11-18T13:00:00Z' }] }] } };
  const reports = { a: { summary: 's', usedFor: [], didntWork: [], nextMonth: [], examples: [
    { task: 'x', status: 'requested', basis: 'b', withoutAI: '4 h', withAI: '1 h' },
    { task: 'y', status: 'verified', basis: 'b', withoutAI: '2 h', withAI: '1 h' }
  ] } };
  const entry = buildEntry({ user: 'u', month: '2026-11', projects: [project], reports });
  assert.equal(entry.projects[0].activeDays, 1);
  assert.equal(entry.projects[0].commitCount, 2);
  assert.equal(entry.projects[0].firstCommitDay === entry.projects[0].firstActiveDay, false);
  assert.equal(entry.totals.estimatedHoursSaved, 1);
  assert.equal(entry.projects[0].examples[0].status, 'requested');
});

test('the synthesis sees prompting observations without prompt IDs', () => {
  const data = { user: 'u', month: '2026-11', projects: [{ name: 'A', id: 'a', tokens: 1, prompts: 1, daily: {}, report: { summary: 's', usedFor: [], examples: [], didntWork: [], nextMonth: [] },
    promptReview: { summary: 's', strengths: ['P17: Names the check.'], opportunities: ['P5: Undefined term.'], rewrite: '', contextNote: '' } }] };
  const entry = buildDeepEntry(data);
  assert.deepEqual(entry.promptingReviews[0].strengths, ['Names the check.']);
  assert.deepEqual(entry.promptingReviews[0].opportunities, ['Undefined term.']);
});

test('an overview card over its limit ends at a whole sentence', () => {
  const first = 'Shipped the export flow, fixed the cache layer, and rewrote the settings page so that every saved report now opens correctly.';
  const long = first + ' Further follow up work continues across the remaining tasks and reviews without a clear end point reached.';
  const out = parseOverview(JSON.stringify({ summary: long, goal: 'Goal.', achievement: 'Done.' }));
  assert.equal(out.summary, first);
  const runOn = parseOverview(JSON.stringify({ summary: 'word '.repeat(60), goal: 'Goal.', achievement: 'Done.' }));
  assert.match(runOn.summary, /…$/);
});
