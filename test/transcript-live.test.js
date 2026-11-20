'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTranscriptLive, contextWindow } = require('../src/transcript-live');

const NOW = 1_800_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
const rec = (o = {}) => JSON.stringify({
  type: 'assistant', cwd: '/proj/a', sessionId: 's1', timestamp: new Date(NOW - 60000).toISOString(),
  message: { model: 'claude-sonnet-5-5-20260101', usage: { input_tokens: 10000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 10000 } }, ...o,
});
function put(dir, proj, name, lines, ageMs = 0) {
  const d = path.join(dir, proj);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, name);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const t = (NOW - ageMs) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}

test('reads model, context and shape', () => {
  const dir = tmp();
  put(dir, 'p', 'a.jsonl', [rec()]);
  const s = readTranscriptLive({ projectsDir: dir, now: NOW });
  assert.deepStrictEqual(Object.keys(s).sort(), ['ctxPct', 'cwd', 'fiveHour', 'model', 'sessionId', 'sevenDay', 'source', 'stale', 'updatedAt']);
  assert.strictEqual(s.model, 'sonnet-5-5');
  assert.strictEqual(s.ctxPct, 20);
  assert.strictEqual(s.source, 'transcript');
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.updatedAt, NOW - 60000);
});

test('freshest wins; cwd preference overrides', () => {
  const dir = tmp();
  put(dir, 'p', 'old.jsonl', [rec({ cwd: '/proj/a', sessionId: 'old' })], 5000);
  put(dir, 'q', 'new.jsonl', [rec({ cwd: '/proj/b', sessionId: 'new' })], 0);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }).sessionId, 'new');
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW, cwd: '/proj/a/' }).sessionId, 'old');
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW, cwd: '/nowhere' }).sessionId, 'new');
});

test('subagent, sidechain and own-tool transcripts are skipped', () => {
  const dir = tmp();
  put(dir, 'p/sess/subagents', 'x.jsonl', [rec({ sessionId: 'sub' })], 0);
  put(dir, 'w', 'w.jsonl', [rec({ cwd: 'C:/x/claude-report-work', sessionId: 'work' })], 100);
  put(dir, 'c', 'c.jsonl', [rec({ isSidechain: true, sessionId: 'side' })], 200);
  put(dir, 'p', 'real.jsonl', [rec({ sessionId: 'real' })], 9000);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }).sessionId, 'real');
});

test('only the tail of a big file is read', () => {
  const dir = tmp();
  const filler = rec({ message: { model: 'claude-opus-4-1-20250101', usage: { input_tokens: 1 } } });
  const lines = Array(2000).fill(filler);
  lines.push(rec({ message: { model: 'claude-opus-4-1-20250101', usage: { input_tokens: 50000 } } }));
  const f = put(dir, 'p', 'big.jsonl', lines);
  assert.ok(fs.statSync(f).size > 300 * 1024);
  const s = readTranscriptLive({ projectsDir: dir, now: NOW });
  assert.strictEqual(s.ctxPct, 25);
  assert.strictEqual(s.model, 'opus-4-1');
});

test('context window heuristic and cap', () => {
  assert.strictEqual(contextWindow('m', 150000), 200000);
  assert.strictEqual(contextWindow('m', 200001), 1000000);
  const dir = tmp();
  put(dir, 'p', 'a.jsonl', [rec({ message: { model: 'claude-opus-4-1', usage: { input_tokens: 500000 } } })]);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }).ctxPct, 50);
  const dir2 = tmp();
  put(dir2, 'p', 'b.jsonl', [rec({ message: { model: 'claude-opus-4-1', usage: { input_tokens: 2000000 } } })]);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir2, now: NOW }).ctxPct, 100);
});

test('stale after 10 minutes; garbage lines ignored', () => {
  const dir = tmp();
  put(dir, 'p', 'a.jsonl', ['not json', rec({ timestamp: new Date(NOW - 11 * 60000).toISOString() }), '{broken', '[1]']);
  const s = readTranscriptLive({ projectsDir: dir, now: NOW });
  assert.strictEqual(s.stale, true);
});

test('returns null when nothing usable', () => {
  assert.strictEqual(readTranscriptLive({ projectsDir: path.join(tmp(), 'missing'), now: NOW }), null);
  const dir = tmp();
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }), null);
  put(dir, 'p', 'a.jsonl', ['garbage', JSON.stringify({ type: 'user', cwd: '/x' })]);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }), null);
  put(dir, 'p', 'old.jsonl', [rec()], 7 * 3600 * 1000);
  assert.strictEqual(readTranscriptLive({ projectsDir: dir, now: NOW }), null);
});
