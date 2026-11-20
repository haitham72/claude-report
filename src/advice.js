'use strict';

// Prompting advice for the overview: one strength, one thing to watch and one habit to try.
// Links come from this fixed table, never from model output, so a report cannot carry an invented address.
const GUIDE = { title: 'Prompting best practices', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices' };
const CODE = { title: 'Best practices for Claude Code', url: 'https://code.claude.com/docs/en/best-practices' };
const TOPICS = { context: GUIDE, specificity: GUIDE, examples: GUIDE, structure: GUIDE, iteration: CODE, verification: CODE };
const WORDS = { text: 30, evidence: 25 };
// Below this many prompts the advice is a first look at a few messages, not a pattern.
const FIRST_LOOK_BELOW = 10;

const clip = (value, words) => {
  const w = String(value || '').trim().split(/\s+/).filter(Boolean);
  return w.length > words ? w.slice(0, words).join(' ') + '…' : w.join(' ');
};

function item(raw, { evidence = true, topic = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clip(raw.text, WORDS.text);
  if (!text) return null;
  const out = { text };
  if (evidence) {
    const proof = clip(raw.evidence, WORDS.evidence);
    if (!proof) return null;
    out.evidence = proof;
  }
  if (topic) {
    if (!Object.hasOwn(TOPICS, raw.topic)) return null;
    out.topic = raw.topic;
  }
  return out;
}

// Returns undefined unless all three parts are supported, so a thin answer never shows half a card.
function parseAdvice(raw, { prompts = 0 } = {}) {
  if (!raw || typeof raw !== 'object') return undefined;
  const strength = item(raw.strength);
  const watch = item(raw.watch, { topic: true });
  const habit = item(raw.habit, { evidence: false, topic: true });
  if (!strength || !watch || !habit) return undefined;
  const links = [...new Set([watch.topic, habit.topic].map((topic) => TOPICS[topic]))];
  return { strength, watch, habit, links, firstLook: prompts < FIRST_LOOK_BELOW, prompts };
}

const ADVICE_REQUEST = '\n\nAlso return advice: {"strength":{"text":"","evidence":""},"watch":{"text":"","evidence":"","topic":""},"habit":{"text":"","topic":""}}. ' +
  'It is advice on how the person writes prompts, drawn only from the promptNote fields or promptingReviews in the data. ' +
  'Give one strength, one thing to watch and one habit to try that follows from the thing to watch. ' +
  `Each text is at most ${WORDS.text} words and each evidence at most ${WORDS.evidence} words, naming the project and paraphrasing what was seen, never quoting. ` +
  `topic is one of ${Object.keys(TOPICS).join(', ')}. ` +
  'Be kind and specific, give no scores or grades, and do not blame the person for what the AI did. Leave advice out if the data does not support all three parts.';

module.exports = { parseAdvice, ADVICE_REQUEST, FIRST_LOOK_BELOW, TOPICS };
