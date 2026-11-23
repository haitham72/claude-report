'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanCursor } = require('../src/cursor-activity');
const { sqliteAvailable } = require('../src/sqlite-read');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* Node 20 */ }
const skip = !sqlite || !sqliteAvailable();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
const proj = path.join(dir, 'My App');
fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
const fileUri = 'file:///' + proj.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? encodeURIComponent(s) : encodeURIComponent(s))).join('/').replace(/^\/+/, '');

function fixture() {
  const file = path.join(dir, 'state.vscdb');
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, CAST(? AS BLOB))').run(k, JSON.stringify(v));
  const ws = { uri: { fsPath: proj } };
  put('composerData:main', { composerId: 'main', createdAt: Date.UTC(2026, 4, 10), modelConfig: { modelName: 'model-x' }, workspaceIdentifier: ws, subagentComposerIds: ['kid'] });
  put('composerData:kid', { composerId: 'kid', modelConfig: { modelName: 'model-y' }, workspaceIdentifier: ws, subagentInfo: { parentComposerId: 'main' } });
  put('composerData:bon', { composerId: 'bon', isBestOfNSubcomposer: true, workspaceIdentifier: ws });
  put('composerData:old', { composerId: 'old', workspaceIdentifier: ws });
  put('composerData:nows', { composerId: 'nows' });
  const b = (c, id, type, at, extra = {}) => put(`bubbleId:${c}:${id}`, { bubbleId: id, type, createdAt: at, tokenCount: { inputTokens: 0, outputTokens: 0 }, ...extra });
  b('main', 'u1', 1, '2026-05-10T08:00:00.000Z', { text: 'add a login page, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456' });
  b('main', 'a1', 2, '2026-05-10T08:01:00.000Z', { tokenCount: { inputTokens: 100, outputTokens: 40 } });
  b('main', 'a2', 2, '2026-05-10T08:02:00.000Z', { tokenCount: { inputTokens: 10, outputTokens: 5 } });
  b('main', 'a3', 2, '2026-05-10T08:03:00.000Z');
  b('kid', 'k1', 1, '2026-05-10T08:04:00.000Z', { text: 'subagent brief' });
  b('kid', 'k2', 2, '2026-05-10T08:05:00.000Z', { tokenCount: { inputTokens: 7, outputTokens: 3 } });
  b('bon', 'n1', 1, '2026-05-10T08:06:00.000Z', { text: 'best of n brief' });
  b('old', 'o1', 1, '2026-01-01T08:00:00.000Z', { text: 'out of range prompt' });
  b('nows', 'w1', 1, '2026-05-10T09:00:00.000Z', { text: 'no workspace', workspaceUris: [fileUri] });
  db.close();
  return file;
}

const from = new Date('2026-05-01T00:00:00Z'), to = new Date('2026-06-01T00:00:00Z');

test('aggregates a project from composer workspace; subcomposers add no sessions or prompts', { skip }, () => {
  const out = scanCursor(from, to, fixture(), { identifyProjects: true });
  assert.strictEqual(out.length, 1);
  const p = out[0];
  assert.strictEqual(p.name, 'My App');
  assert.ok(p.id);
  assert.strictEqual(p.sessions, 2); // main + the bubble-URI fallback composer; kid and bon excluded
  assert.strictEqual(p.promptCount, 2); // main u1 + nows w1
  assert.ok(p.prompts.every((x) => x.source === 'cursor'));
  assert.strictEqual(p.tokens.turns, 4); // 3 main + kid (its tokens still count)
  assert.strictEqual(p.tokens.input, 117);
  assert.strictEqual(p.tokens.output, 48);
  assert.strictEqual(p.totalTokens, 165);
  assert.strictEqual(p.entrypoints.cursor, 165);
  assert.strictEqual(p.models['model-x'], 155);
  assert.strictEqual(p.models['model-y'], 10);
  assert.strictEqual(Object.values(p.dailyTurns).reduce((a, b) => a + b, 0), 4);
  assert.strictEqual(p.hours.reduce((a, b) => a + b, 0), 2);
});

test('date window excludes out-of-range bubbles', { skip }, () => {
  const file = fixture();
  assert.deepStrictEqual(scanCursor(new Date('2027-01-01Z'), new Date('2027-02-01Z'), file), []);
  const jan = scanCursor(new Date('2026-01-01Z'), new Date('2026-02-01Z'), file);
  assert.strictEqual(jan[0].promptCount, 1);
  assert.strictEqual(jan[0].totalTokens, 0);
});

test('prompts are redacted and non-identified runs have no id', { skip }, () => {
  const out = scanCursor(from, to, fixture());
  const text = out[0].prompts.map((x) => x.text).join('\n');
  assert.ok(!text.includes('sk-ant-api03'));
  assert.strictEqual(out[0].id, undefined);
});

test('missing or unreadable file returns []', () => {
  assert.deepStrictEqual(scanCursor(from, to, path.join(dir, 'nope.vscdb')), []);
  const junk = path.join(dir, 'junk.vscdb');
  fs.writeFileSync(junk, 'not a database');
  assert.deepStrictEqual(scanCursor(from, to, junk), []);
});
