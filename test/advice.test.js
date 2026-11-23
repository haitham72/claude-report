'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAdvice, ADVICE_REQUEST, TOPICS } = require('../src/advice');
const { parseOverview, generateOverview } = require('../src/overview');

const raw = {
  strength: { text: 'Goals come first.', evidence: 'Project A: the failing case was stated up front.' },
  watch: { text: 'Some asks are very short.', evidence: 'Project B: one question was asked three times.', topic: 'context' },
  habit: { text: 'Say what you already tried.', topic: 'iteration' }
};

test('advice needs all three parts and evidence on the first two; a missing or unknown topic is inferred from the fixed table', () => {
  const a = parseAdvice(raw, { prompts: 40 });
  assert.strictEqual(a.strength.text, 'Goals come first.');
  assert.strictEqual(a.watch.topic, 'context');
  assert.strictEqual(a.firstLook, false);
  assert.strictEqual(parseAdvice({ ...raw, habit: undefined }), undefined);
  assert.strictEqual(parseAdvice({ ...raw, strength: { text: 'Good.' } }), undefined);
  const guessed = parseAdvice({ ...raw, watch: { ...raw.watch, topic: 'vibes' }, habit: { text: 'Ask for a test run before closing.' } });
  assert.ok(Object.keys(TOPICS).includes(guessed.watch.topic), 'never the model\'s own topic');
  assert.strictEqual(guessed.habit.topic, 'verification');
  assert.ok(guessed.links.every((link) => Object.values(TOPICS).includes(link)), 'links only from the fixed table');
  assert.strictEqual(parseAdvice('no'), undefined);
});

test('fewer than ten prompts is a first look', () => {
  assert.strictEqual(parseAdvice(raw, { prompts: 9 }).firstLook, true);
  assert.strictEqual(parseAdvice(raw, { prompts: 10 }).firstLook, false);
});

test('links come from the fixed table, never from the model', () => {
  const a = parseAdvice({ ...raw, watch: { ...raw.watch, url: 'https://evil.example/x', links: ['https://evil.example'] } }, { prompts: 12 });
  assert.ok(a.links.length >= 1);
  for (const link of a.links) assert.match(link.url, /^https:\/\/(?:platform|code)\.claude\.com\//);
  assert.ok(!JSON.stringify(a).includes('evil.example'));
  assert.deepStrictEqual(Object.keys(TOPICS).sort(), ['context', 'examples', 'iteration', 'specificity', 'structure', 'verification']);
});

test('long advice text is cut to its word limits', () => {
  const long = Array(80).fill('word').join(' ');
  const a = parseAdvice({ ...raw, strength: { text: long, evidence: long } });
  assert.strictEqual(a.strength.text.split(' ').length, 30);
  assert.strictEqual(a.strength.evidence.split(' ').length, 25);
});

test('parseOverview keeps advice when it is valid and the cards when it is not', () => {
  const cards = { summary: 's', goal: 'g', achievement: 'a' };
  const withAdvice = parseOverview(JSON.stringify({ ...cards, advice: raw }), { prompts: 5 });
  assert.strictEqual(withAdvice.advice.firstLook, true);
  assert.deepStrictEqual(parseOverview(JSON.stringify({ ...cards, advice: { strength: raw.strength } })), cards);
});

test('the advice request is sent only when there is prompting evidence', async () => {
  let seen;
  const run = async (a) => { seen = a.prompt; return '{"summary":"s","goal":"g","achievement":"a"}'; };
  await generateOverview({ entry: { projects: [{ name: 'a', promptCount: 4 }] }, run });
  assert.ok(!seen.includes(ADVICE_REQUEST.trim()));
  await generateOverview({ entry: { projects: [{ name: 'a', promptCount: 4, promptNote: 'Short asks.' }] }, run });
  assert.ok(seen.includes('also return an "advice" key'));
  await generateOverview({ entry: { projects: [], promptingReviews: [{ project: 'a' }] }, run });
  assert.ok(seen.includes('also return an "advice" key'));
});
