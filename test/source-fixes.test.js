'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'srcfix-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'cfg');
const { scanPeriod, redact, claudeDir } = require('../src/scan');
const { scanCodex } = require('../src/codex-activity');
const { scanCursor } = require('../src/cursor-activity');
const { scanAntigravity } = require('../src/antigravity-activity');
const { sqliteAvailable } = require('../src/sqlite-read');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* old Node */ }
const skip = !sqlite || !sqliteAvailable() ? 'node:sqlite unavailable' : false;

const workspace = path.join(home, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const from = new Date('2026-03-01T00:00:00Z'), to = new Date('2026-04-01T00:00:00Z');
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('redaction: quoted, prefixed and vendor secrets', () => {
  const secrets = [
    '"api_key": "short_secret_123"', '"password": "MyP@ss!2026"', 'db_password=secret123',
    'AIza' + 'A'.repeat(35), 'glpat-' + 'a1b2c3d4e5'.repeat(2), 'ASIA' + 'ABCDEFGH12345678',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==', '$env:FOO_BAR=hunter2', 'set FOO_BAR=hunter2'
  ];
  for (const s of secrets) {
    const out = redact(`note\n${s}`);
    assert.ok(out.includes('[redacted]'), s);
    assert.ok(!/short_secret|MyP@ss|secret123|AAAAAAAA|glpat-a1|ABCDEFGH|dXNlcj|hunter2/.test(out), `${s} -> ${out}`);
  }
  for (const s of ['the password field is empty', 'set up the api first', 'max_tokens is a limit', 'Basic configuration guide']) {
    assert.strictEqual(redact(s), s);
  }
});

test('claudeDir honours CLAUDE_CONFIG_DIR', () => {
  assert.strictEqual(claudeDir(), path.join(home, 'cfg'));
});

const assistant = (id, content, out, at) => ({
  type: 'assistant', cwd: workspace, timestamp: at, requestId: 'r1',
  message: { id, model: 'claude-x', content, usage: { input_tokens: 10, output_tokens: out } }
});

test('claude: subagents add tokens but no sessions/prompts/time; streamed lines dedupe by max output', () => {
  const dir = path.join(home, 'cfg', 'projects', 'p');
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  const user = (t, at) => ({ type: 'user', cwd: workspace, timestamp: at, message: { content: t } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), jl(
    user('main prompt here', '2026-03-10T08:00:00.000Z'),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read' }], 5, '2026-03-10T08:00:01.000Z'),
    assistant('m1', [{ type: 'tool_use', id: 't2', name: 'Edit' }], 40, '2026-03-10T08:00:02.000Z'),
    assistant('m1', [{ type: 'text', text: 'ok' }], 40, '2026-03-10T08:00:03.000Z')));
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), jl(
    user('subagent brief', '2026-03-10T09:00:00.000Z'),
    assistant('m2', [{ type: 'tool_use', id: 't3', name: 'Grep' }], 7, '2026-03-10T10:00:00.000Z')));
  const [p] = scanPeriod(from, to);
  assert.strictEqual(p.sessions, 1);
  assert.strictEqual(p.promptCount, 1);
  assert.strictEqual(p.tokens.turns, 2);
  assert.strictEqual(p.tokens.output, 47);
  assert.strictEqual(p.tokens.input, 20);
  assert.deepStrictEqual(Object.keys(p.tools).sort(), ['Edit', 'Grep', 'Read']);
  assert.ok(p.sessionSpanHours < 0.01, 'subagent time excluded');
  assert.strictEqual(p.daily['2026-03-10'], 20 + 47);
});

test('codex: id-less event/response mirrors count once', () => {
  const day = path.join(home, 'codex', '2026', '03', '10');
  fs.mkdirSync(day, { recursive: true });
  const at = '2026-03-10T08:01:00.000Z';
  fs.writeFileSync(path.join(day, 'rollout-2026-03-10T08-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), jl(
    { type: 'session_meta', timestamp: '2026-03-10T08:00:00.000Z', payload: { cwd: workspace } },
    { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'mirrored prompt' } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mirrored prompt' }] } }));
  const [p] = scanCodex(from, to, path.join(home, 'codex'));
  assert.strictEqual(p.promptCount, 1);
});

test('cursor: ISO and epoch-ms createdAt both count', { skip }, () => {
  const file = path.join(home, 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, CAST(? AS BLOB))').run(k, JSON.stringify(v));
  put('composerData:c1', { workspaceIdentifier: { uri: { fsPath: workspace } } });
  put('bubbleId:c1:a', { type: 1, createdAt: '2026-03-10T08:00:00.000Z', text: 'iso prompt' });
  put('bubbleId:c1:b', { type: 1, createdAt: Date.parse('2026-03-11T08:00:00.000Z'), text: 'numeric prompt' });
  put('bubbleId:c1:c', { type: 1, createdAt: Date.parse('2027-01-01T00:00:00Z'), text: 'out of window' });
  db.close();
  const [p] = scanCursor(from, to, file);
  assert.strictEqual(p.promptCount, 2);
});

test('antigravity: null step index -> latest prompt; window filter in SQL', { skip }, () => {
  const root = path.join(home, 'agy');
  fs.mkdirSync(root, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(root, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
    last_user_input_time TEXT, last_user_input_step_index INTEGER)`);
  db.exec('CREATE TABLE conversations_fts (conversation_id TEXT, chunk_index INTEGER, user_body TEXT, user_step_byte_offsets BLOB)');
  const ws = JSON.stringify([pathToFileURL(workspace).href]);
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('c1', 't', 'prev', 3, '2026-03-10 09:00:05.8335062+00:00', ws, '', '', 0, '2026-03-10 08:59:00.1234567+00:00', null);
  ins.run('old', 't', 'old', 3, '2025-01-10 09:00:00+00:00', ws, '', '', 0, '2025-01-10 08:59:00+00:00', 0);
  const body = 'first promptlatest prompt';
  db.prepare('INSERT INTO conversations_fts VALUES (?,?,?,?)').run('c1', 0, body, JSON.stringify([[0, 0], [2, 12]]));
  db.close();
  const [p] = scanAntigravity(from, to, root);
  assert.strictEqual(p.sessions, 1);
  assert.strictEqual(p.prompts[0].text, 'latest prompt');
});

test('codex: ignores sessions whose cwd contains claude-report-work', () => {
  const root = path.join(home, 'codex-ignore', '2026', '03', '10');
  fs.mkdirSync(root, { recursive: true });
  const workCwd = path.join(home, 'claude-report-work');
  fs.writeFileSync(path.join(root, 'rollout-2026-03-10T09-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'), jl(
    { type: 'session_meta', timestamp: '2026-03-10T09:00:00.000Z', payload: { cwd: workCwd } },
    { type: 'event_msg', timestamp: '2026-03-10T09:01:00.000Z', payload: { type: 'user_message', message: 'internal report prompt' } },
    { type: 'event_msg', timestamp: '2026-03-10T09:02:00.000Z', payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 500, output_tokens: 50 }, last_token_usage: { input_tokens: 500, output_tokens: 50 } }
    } }
  ));
  assert.deepStrictEqual(scanCodex(from, to, path.join(home, 'codex-ignore')), []);
});

test('cursor: ignores composers whose workspace path contains claude-report-work', { skip }, () => {
  const file = path.join(home, 'state-ignore.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, CAST(? AS BLOB))').run(k, JSON.stringify(v));
  const workCwd = path.join(home, 'claude-report-work');
  put('composerData:c-work', { workspaceIdentifier: { uri: { fsPath: workCwd } } });
  put('bubbleId:c-work:a', { type: 1, createdAt: '2026-03-10T08:00:00.000Z', text: 'internal prompt' });
  put('bubbleId:c-work:b', { type: 2, createdAt: '2026-03-10T08:01:00.000Z', tokenCount: { inputTokens: 100, outputTokens: 20 } });
  db.close();
  assert.deepStrictEqual(scanCursor(from, to, file), []);
});

test('antigravity: ignores conversations whose workspace path contains claude-report-work', { skip }, () => {
  const root = path.join(home, 'agy-ignore');
  fs.mkdirSync(root, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(root, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
    last_user_input_time TEXT, last_user_input_step_index INTEGER)`);
  db.exec('CREATE TABLE conversations_fts (conversation_id TEXT, chunk_index INTEGER, user_body TEXT, user_step_byte_offsets BLOB)');
  const workWs = JSON.stringify([pathToFileURL(path.join(home, 'claude-report-work')).href]);
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    'c-work', 't', 'prev', 3, '2026-03-10 09:00:05.000+00:00', workWs, '', '', 0, '2026-03-10 08:59:00.000+00:00', 0
  );
  db.prepare('INSERT INTO conversations_fts VALUES (?,?,?,?)').run('c-work', 0, 'internal prompt', JSON.stringify([[0, 0]]));
  db.close();
  assert.deepStrictEqual(scanAntigravity(from, to, root), []);
});
