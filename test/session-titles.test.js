'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// scan.js reads ~/.claude/projects at load, so point the home at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { scanPeriod } = require('../src/scan');
const { scanCodex, mergeProjects } = require('../src/codex-activity');
const { scanCursor } = require('../src/cursor-activity');
const { scanAntigravity } = require('../src/antigravity-activity');
const { sqliteAvailable } = require('../src/sqlite-read');
const g = require('../src/generate');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* Node 20 */ }
const skip = !sqlite || !sqliteAvailable() ? 'node:sqlite unavailable' : false;

const workspace = path.join(home, 'ws-titles');
fs.mkdirSync(workspace, { recursive: true });
const from = new Date('2026-03-01T00:00:00Z'), to = new Date('2026-04-01T00:00:00Z');
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('claude: custom title beats ai-title, redacted and capped', () => {
  const dir = path.join(home, '.claude', 'projects', 'p1');
  fs.mkdirSync(dir, { recursive: true });
  const user = { type: 'user', cwd: workspace, timestamp: '2026-03-10T08:00:00.000Z', message: { content: 'build the thing please' } };
  fs.writeFileSync(path.join(dir, 'a.jsonl'), jl(user, { type: 'ai-title', aiTitle: 'AI title' }, { type: 'custom-title', customTitle: 'My ' + 'word '.repeat(60) }));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), jl({ ...user, timestamp: '2026-03-11T08:00:00.000Z' }, { type: 'ai-title', aiTitle: 'Fix key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456' }));
  fs.writeFileSync(path.join(dir, 'c.jsonl'), jl({ ...user, timestamp: '2026-03-12T08:00:00.000Z' }, { type: 'ai-title', aiTitle: 'Edit .env now' }));
  const [p] = scanPeriod(from, to);
  assert.strictEqual(p.titles.length, 2);
  assert.ok(p.titles[0].text.startsWith('My word') && p.titles[0].text.length <= 120);
  assert.ok(p.titles.every((t) => t.source === 'claude' && /^2026-03-1/.test(t.at)));
  assert.ok(p.titles[1].text.includes('[redacted]') && !p.titles[1].text.includes('sk-ant'));
  assert.deepStrictEqual(scanPeriod(from, to, { deep: true })[0].titles, []);
});

test('codex: thread_name maps to its rollout by session id', () => {
  const codex = path.join(home, 'codex');
  const day = path.join(codex, 'sessions', '2026', '03', '10');
  fs.mkdirSync(day, { recursive: true });
  const id = '019e24bc-c4cb-7e33-b5ed-00df1ab07d07';
  const msg = (type, payload, timestamp) => ({ type, timestamp, payload });
  fs.writeFileSync(path.join(day, `rollout-2026-03-10T08-00-00-${id}.jsonl`), jl(
    msg('session_meta', { cwd: workspace }, '2026-03-10T08:00:00.000Z'),
    msg('event_msg', { type: 'user_message', message: 'do the codex thing' }, '2026-03-10T08:01:00.000Z')));
  fs.writeFileSync(path.join(codex, 'session_index.jsonl'), jl({ id, thread_name: 'Codex thread', updated_at: '2026-03-10T09:00:00Z' }, { id: 'other', thread_name: 'Unmatched' }));
  const [p] = scanCodex(from, to, path.join(codex, 'sessions'));
  assert.deepStrictEqual(p.titles, [{ at: '2026-03-10T08:01:00.000Z', text: 'Codex thread', source: 'codex' }]);
  assert.deepStrictEqual(scanCodex(from, to, path.join(codex, 'sessions'), { deep: true })[0].titles, []);
});

test('cursor: composer name becomes a title', { skip }, () => {
  const file = path.join(home, 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, CAST(? AS BLOB))').run(k, JSON.stringify(v));
  put('composerData:c1', { name: 'Cursor chat', workspaceIdentifier: { uri: { fsPath: workspace } } });
  put('bubbleId:c1:u1', { type: 1, createdAt: '2026-03-10T08:00:00.000Z', text: 'hello cursor' });
  db.close();
  const [p] = scanCursor(from, to, file);
  assert.deepStrictEqual(p.titles, [{ at: '2026-03-10T08:00:00.000Z', text: 'Cursor chat', source: 'cursor' }]);
});

test('antigravity: title, falling back to preview', { skip }, () => {
  const root = path.join(home, 'agy');
  fs.mkdirSync(root, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(root, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
    last_user_input_time TEXT, last_user_input_step_index INTEGER)`);
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const ws = JSON.stringify([pathToFileURL(workspace).href]);
  ins.run('c1', 'Real title', 'prev', 1, '2026-03-10 09:00:00+00:00', ws, '', '', 0, '2026-03-10 08:59:00+00:00', 0);
  ins.run('c2', '', 'Preview\nfallback', 1, '2026-03-11 09:00:00+00:00', ws, '', '', 0, '2026-03-11 08:59:00+00:00', 0);
  db.close();
  const [p] = scanAntigravity(from, to, root);
  assert.deepStrictEqual(p.titles.map((t) => t.text), ['Real title', 'Preview fallback']);
  assert.ok(p.titles.every((t) => t.source === 'antigravity'));
});

test('mergeProjects concatenates, sorts and dedupes titles', () => {
  const t = (at, text, source) => ({ at, text, source });
  const a = { name: 'x', titles: [t('2026-03-12', 'Same', 'claude'), t('2026-03-10', 'First', 'claude')] };
  const b = { name: 'x', titles: [t('2026-03-11', 'Same', 'codex'), t('2026-03-13', 'Last', 'codex')] };
  const [m] = mergeProjects([a], [b], [{ name: 'x' }]);
  assert.deepStrictEqual(m.titles.map((x) => x.text), ['First', 'Same', 'Last']);
  assert.strictEqual(m.titles[1].source, 'codex');
});

const withTitles = (n, prompts = 5) => ({
  name: 'p', sessions: 1, totalTokens: 1,
  titles: Array.from({ length: n }, (_, i) => ({ at: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(), text: `title ${i} about work`, source: 'claude' })),
  prompts: Array.from({ length: prompts }, (_, i) => ({ at: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(), text: `prompt ${i} `.padEnd(2000, 'z') }))
});

test('prompt carries a Session titles list, newest first, within maxChars', () => {
  const slice = g.sliceProject(withTitles(50), { maxChars: 11000 });
  assert.strictEqual(slice.titles.length, 30);
  assert.ok(slice.titles[0].endsWith('title 49 about work'));
  const keys = Object.keys(slice);
  assert.ok(keys.indexOf('titles') < keys.indexOf('prompts'));
  assert.match(g.buildProjectPrompt(slice), /for orientation only/);
  const size = (s) => (s.titles || []).join('').length + s.prompts.reduce((n, p) => n + p.text.length, 0);
  assert.ok(size(slice) <= 11000);
  const tight = g.sliceProject(withTitles(50), { maxChars: 600 });
  assert.ok((tight.titles || []).length < 30 && size(tight) <= 600);
  assert.strictEqual(g.sliceProject(withTitles(0)).titles, undefined);
});

test('a title is never quotable evidence', () => {
  // Titles are only collected outside deep mode, and quote matching reads deep prompt rows only.
  const slice = g.sliceProject(withTitles(3));
  const quotable = slice.prompts.map((p) => p.text).join('\n');
  assert.ok(slice.titles.every((t) => !quotable.includes(t.slice(11))));
});
