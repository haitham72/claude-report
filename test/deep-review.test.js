'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepPrompt, stripDeepContext } = require('../src/scan');
const { hunks } = require('../src/deep-git');
const { tokens, budgetFor, prepareReview, planReview, auditProject } = require('../src/deep-review');
const { reviewCache, selectInlineFiles, planProjectReview, runProjectReview } = require('../src/deep-stages');

const prompt = (text, date = '2026-11-20', session = 'fixture') => deepPrompt(text, date + 'T12:00:00Z', session, 'codex');

test('a 1,000-word message is redacted and stays intact when it fits the selected context', () => {
  const message = prompt('Contact team@example.test before reviewing ' + 'word '.repeat(1000) + 'and verify the final requirement.');
  assert.ok(message.words > 1000);
  assert.doesNotMatch(message.text, /team@example/);
  const review = prepareReview({ name: 'Sample', prompts: [message] });
  const plan = planReview(review, budgetFor(13312));
  assert.equal(plan.chunks.length, 1);
  assert.match(plan.chunks[0][0].text, /verify the final requirement\.$/);
  assert.equal(plan.chunks[0][0].text, message.text);
});

test('the Deep planner packs whole sessions and splits oversized messages without deleting their tails', () => {
  const review = prepareReview({ name: 'Large', prompts: [
    prompt('Context '.repeat(230), '2026-11-02', 'first'),
    prompt('Smaller '.repeat(140), '2026-11-03', 'second')
  ] });
  const plan = planReview(review, 420);
  assert.equal(plan.split, 'session batches');
  assert.ok(plan.chunks.every((chunk) => tokens(chunk) <= 420));
  for (const row of review.rows) {
    assert.equal(plan.chunks.flat().filter((part) => part.id === row.id).map((part) => part.text).join(''), row.text);
  }
});

test('injected context is removed while a real prompt after it is retained', () => {
  const text = '<browser_instruction>Tool setup</browser_instruction>\n<ide_opened_file>path</ide_opened_file>\nCheck focus in this dialog.';
  assert.equal(stripDeepContext(text), 'Check focus in this dialog.');
  assert.equal(stripDeepContext('<browser_instruction>Tool setup'), '');
  assert.equal(stripDeepContext('<task>Check focus</task>'), '<task>Check focus</task>');
});

test('review checks excerpts against supplied prompts and avoids an extra condensation call', async () => {
  const review = prepareReview({ name: 'Sample', prompts: [
    prompt('RAW_DOCUMENT ' + 'text '.repeat(550)),
    prompt('Verify keyboard navigation and record which focus transitions fail.', '2026-11-21', 'second')
  ] });
  const requests = [];
  const result = await auditProject({
    review, model: { model: 'sonnet', effort: 'medium' }, budget: 3200,
    run: async ({ kind, prompt }) => {
      const payload = JSON.parse(prompt.split('Evidence JSON:\n').at(-1));
      requests.push({ kind, payload });
      return JSON.stringify({ summary: 'P2 supplied a concrete check.', strengths: [
        { id: 'P1', quote: '“Verify keyboard navigation”', text: 'Identifies keyboard navigation.' },
        { id: 'P2', quote: 'Specify database migrations', text: 'Invents evidence.' }
      ], opportunities: [], rewrite: 'Verify that Tab follows the visual order.' });
    }
  });
  assert.deepEqual(requests.map(({ kind }) => kind), ['deep-review']);
  assert.match(requests[0].payload.rows[0].text, /RAW_DOCUMENT/);
  assert.deepEqual(result.strengths, ['P2: Identifies keyboard navigation.']);
  assert.equal(result.references[0].session, 'S2');
});

test('each depth uses one evidence bundle and matching reviews are reused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-deep-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const review = prepareReview({ id: 'project-id', name: 'Sample', prompts: [prompt('Verify keyboard navigation in dialog.js.')] }, {
    context: [{ file: 'README.md', text: 'Keyboard-first components.' }],
    changes: [{ at: '2026-11-20T12:00:00Z', file: 'dialog.js', ref: 'commit' }]
  });
  const payloads = [];
  const run = async ({ kind, prompt }) => {
    assert.equal(kind, 'deep-review');
    payloads.push(JSON.parse(prompt.split('Evidence JSON:\n').at(-1)));
    return JSON.stringify({ summary: 'Review', contextNote: 'The documentation explains the constraint.',
      strengths: [{ id: 'P1', quote: 'Verify keyboard navigation', text: 'Names an accessibility check.' }], opportunities: [] });
  };
  let line = '+focusNext(current);';
  assert.deepEqual(selectInlineFiles(review), ['dialog.js']);
  const context = 8192, budget = budgetFor(context), cache = reviewCache(dir, 'same scope');
  const call = (level) => {
    const inline = level === 'high' ? { changes: [{ at: '2026-11-20T12:00:00Z', file: 'dialog.js', ref: 'working tree',
      hunks: [{ range: '-1 +1', lines: line }] }] } : {};
    const prepared = planProjectReview({ review, level, inline, budget, context, cache });
    return runProjectReview({ review, level, prepared, run, model: { model: 'haiku' }, context, budget, cache });
  };
  await call('low');
  await call('medium');
  const high = await call('high');
  assert.deepEqual(payloads.map(({ depth }) => depth), ['low', 'medium', 'high']);
  assert.equal(payloads[0].projectEvidence, undefined);
  assert.equal(payloads[1].projectEvidence.documents[0].file, 'README.md');
  assert.deepEqual(payloads[1].projectEvidence.changedLines, []);
  assert.equal(payloads[2].projectEvidence.changedLines[0].lines, line);
  assert.equal(payloads[2].rows[0].text, review.rows[0].text);
  assert.deepEqual(high.changedFiles, [{ file: 'dialog.js', ranges: ['-1 +1'] }]);
  assert.equal((await call('high')).reused, true);
  line = '+focusNext(enabled);';
  await call('high');
  review.git.context[0].text = 'Keyboard-first components with trapped modal focus.';
  await call('high');
  assert.deepEqual(payloads.map(({ depth }) => depth), ['low', 'medium', 'high', 'high', 'high']);
  for (const file of fs.readdirSync(path.join(dir, 'deep-review-cache'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'deep-review-cache', file), 'utf8'), /focusNext|Verify keyboard navigation in dialog/);
  }
});

test('oversized evidence uses only the planned same-depth batches', async () => {
  const review = prepareReview({ name: 'Large', prompts: [
    prompt('Verify keyboard movement. ' + 'Details '.repeat(210), '2026-11-02', 'first'),
    prompt('Verify focus after close. ' + 'Details '.repeat(210), '2026-11-03', 'second')
  ] });
  const calls = [];
  const result = await auditProject({ review, level: 'high', budget: 780, model: { model: 'haiku' }, run: async ({ kind, prompt }) => {
    assert.equal(kind, 'deep-review');
    const payload = JSON.parse(prompt.split('Evidence JSON:\n').at(-1));
    calls.push(payload);
    const row = payload.rows[0];
    return JSON.stringify({ summary: 'Review', strengths: [{ id: row.id, quote: row.text.slice(0, 23).trim(), text: 'Uses specific behavior.' }] });
  } });
  assert.equal(result.batches, 2);
  assert.deepEqual(calls.map(({ depth }) => depth), ['high', 'high']);
  assert.equal(result.references.length, 2);
});

test('diff line ranges stay visible in Medium and High includes only redacted changes', () => {
  const patch = [
    '@@ -4,2 +4,2 @@', '-old behavior', '+new behavior',
    '+owner@example.test', '+AWS_SECRET_ACCESS_KEY=private-irrelevant-value', ''
  ].join('\n');
  assert.deepEqual(hunks(patch, 'medium'), [{ range: '-4,2 +4,2' }]);
  const [high] = hunks(patch, 'high');
  assert.match(high.lines, /-old behavior\n\+new behavior/);
  assert.doesNotMatch(high.lines, /owner@example|private-irrelevant-value/);
});
