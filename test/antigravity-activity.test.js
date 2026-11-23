'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { sqliteAvailable } = require('../src/sqlite-read');
const { scanAntigravity } = require('../src/antigravity-activity');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* Node 20 */ }
const skip = !sqlite || !sqliteAvailable() ? 'node:sqlite unavailable' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
const workspace = path.join(tmp, 'ws-alpha');
fs.mkdirSync(workspace, { recursive: true });
const ws = JSON.stringify([pathToFileURL(workspace).href]);

function fixture() {
  const root = path.join(tmp, 'home');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'conversation_summaries.db');
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
    last_user_input_time TEXT, last_user_input_step_index INTEGER);
    CREATE TABLE conversations_fts (conversation_id TEXT, chunk_index INTEGER, user_step_byte_offsets TEXT, user_body TEXT);`);
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('c1', 't', 'preview one', 10, '2026-03-10 09:00:00.1234567+00:00', ws, '', '', 0, '2026-03-10 08:59:00.5+00:00', 8);
  ins.run('c2', 't', 'preview two', 4, '2026-03-11 09:00:00+00:00', ws, 'research', 'c1', 1, '2026-03-11 08:59:00+00:00', 2);
  ins.run('old', 't', 'ancient', 99, '2025-01-01 09:00:00+00:00', ws, '', '', 0, '2025-01-01 08:00:00+00:00', 0);
  ins.run('nows', 't', 'no workspace', 3, '2026-03-10 09:00:00+00:00', '[]', '', '', 0, '2026-03-10 08:00:00+00:00', 0);
  const first = 'first synthetic message\n';
  const second = 'later one with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 inside';
  db.prepare('INSERT INTO conversations_fts VALUES (?,?,?,?)')
    .run('c1', 0, JSON.stringify([[0, 0], [8, Buffer.byteLength(first)]]), first + second);
  db.close();
  return root;
}

const from = new Date('2026-03-01T00:00:00Z');
const to = new Date('2026-04-01T00:00:00Z');

test('missing root returns []', () => {
  assert.deepStrictEqual(scanAntigravity(from, to, path.join(tmp, 'nope')), []);
});

test('date filter, project from workspace URI, subagent handling', { skip }, () => {
  const out = scanAntigravity(from, to, fixture());
  assert.strictEqual(out.length, 1);
  const p = out[0];
  assert.strictEqual(p.name, 'ws-alpha');
  assert.strictEqual(p.sessions, 1);
  assert.strictEqual(p.promptCount, 1);
  assert.strictEqual(p.tokens.turns, 14);
  assert.strictEqual(p.totalTokens, 0);
  assert.strictEqual(p.entrypoints.antigravity, 0);
  assert.ok('research' in p.models);
  assert.strictEqual(scanAntigravity(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'), fixture()).length, 0);
});

test('prompts are tagged, sliced from user_body and redacted', { skip }, () => {
  const [prompt] = scanAntigravity(from, to, fixture())[0].prompts;
  assert.strictEqual(prompt.source, 'antigravity');
  assert.ok(prompt.text.startsWith('later one with key'));
  assert.ok(!prompt.text.includes('sk-ant-api03'));
  assert.ok(prompt.text.includes('[redacted]'));
  assert.ok(Number.isFinite(+new Date(prompt.at)));
});

test('identifyProjects adds id and location', { skip }, () => {
  const [p] = scanAntigravity(from, to, fixture(), { identifyProjects: true });
  assert.match(p.id, /^[0-9a-f]{64}$/);
  assert.ok(p.location);
});
