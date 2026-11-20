'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSessions, ageLabel, groupOf, isUuid } = require('../src/sessions');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const ID = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const J = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const prompt = (text, extra) => Object.assign({ type: 'user', cwd: '/w/app', entrypoint: 'cli', message: { content: text } }, extra);

function env(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'projects');
  const registryDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(projectsDir, 'p'), { recursive: true });
  fs.mkdirSync(registryDir);
  const add = (id, content, ageMs = 1000) => {
    const f = path.join(projectsDir, 'p', id + '.jsonl');
    fs.writeFileSync(f, content);
    const t0 = new Date(NOW - ageMs);
    fs.utimesSync(f, t0, t0);
    return f;
  };
  const list = (o) => listSessions(Object.assign({ projectsDir, registryDir, now: NOW, projectName: (c) => 'P:' + c, isAlive: () => false }, o));
  return { projectsDir, registryDir, add, list };
}

test('title precedence: custom > ai-title > first prompt', (t) => {
  const e = env(t);
  e.add('a', J(prompt('hello there'), { type: 'ai-title', aiTitle: 'AI' }, { type: 'custom-title', customTitle: 'Mine' }));
  e.add('b', J(prompt('hello there'), { type: 'ai-title', aiTitle: 'AI' }), 2000);
  e.add('c', J(prompt('hello   there\nfriend')), 3000);
  const r = e.list();
  assert.deepStrictEqual(r.map((s) => s.title), ['Mine', 'AI', 'hello there friend']);
  assert.strictEqual(r[0].project, 'P:/w/app');
  assert.strictEqual(r[0].entrypoint, 'cli');
  assert.strictEqual(r[0].status, '');
});

test('tail of a big file gives the last ai-title', (t) => {
  const e = env(t);
  const pad = prompt('x'.repeat(2000));
  const lines = [prompt('start'), { type: 'ai-title', aiTitle: 'Old' }];
  for (let i = 0; i < 150; i++) lines.push(pad);
  lines.push({ type: 'ai-title', aiTitle: 'Middle' });
  for (let i = 0; i < 150; i++) lines.push(pad);
  lines.push({ type: 'ai-title', aiTitle: 'Newest' });
  const f = e.add('big', J(...lines));
  assert.ok(fs.statSync(f).size > 400 * 1024);
  assert.strictEqual(e.list()[0].title, 'Newest');
});

test('first prompt fallback truncates to 70 with ellipsis only when cut', (t) => {
  const e = env(t);
  e.add('long', J(prompt('a'.repeat(100))));
  e.add('exact', J(prompt('b'.repeat(70))), 2000);
  const r = e.list();
  assert.strictEqual(r[0].title, 'a'.repeat(70) + '\u2026');
  assert.strictEqual(r[1].title, 'b'.repeat(70));
});

test('non-prompt records are skipped when finding the first prompt', (t) => {
  const e = env(t);
  e.add('a', J(
    prompt('<command-name>x</command-name>'),
    prompt('Caveat: hidden'),
    prompt('meta', { isMeta: true }),
    prompt('side', { isSidechain: true }),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'r' }] } },
    { type: 'assistant', message: { content: 'nope' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'real one' }] } },
  ));
  assert.strictEqual(e.list()[0].title, 'real one');
});

test('sessions without prompt or title are skipped', (t) => {
  const e = env(t);
  e.add('a', J(prompt('<local-command>'), { type: 'assistant', message: { content: 'x' } }));
  e.add('b', J({ type: 'ai-title', aiTitle: 'Only title' }), 2000);
  assert.deepStrictEqual(e.list().map((s) => s.title), ['Only title']);
});

test('active first, status from registry, key and corrupt files ignored', (t) => {
  const e = env(t);
  e.add(ID(1), J(prompt('newest')), 1000);
  e.add(ID(2), J(prompt('old but busy')), 5000);
  e.add(ID(3), J(prompt('idle live')), 9000);
  e.add(ID(4), J(prompt('dead')), 8000);
  const reg = (pid, id, status, updatedAt) => fs.writeFileSync(path.join(e.registryDir, pid + '.json'), JSON.stringify({ pid, sessionId: id, status, updatedAt }));
  reg(10, ID(2), 'busy', NOW - 100);
  reg(11, ID(3), 'waiting', NOW - 9000);
  reg(12, ID(4), 'busy', NOW);
  fs.writeFileSync(path.join(e.registryDir, '13.json'), '{nope');
  fs.writeFileSync(path.join(e.registryDir, 'x.key'), JSON.stringify({ pid: 14, sessionId: ID(1) }));
  const r = e.list({ isAlive: (pid) => pid !== 12 });
  assert.deepStrictEqual(r.map((s) => s.id), [ID(2), ID(3), ID(1), ID(4)]);
  assert.deepStrictEqual(r.map((s) => s.status), ['busy', 'idle', '', '']);
  assert.strictEqual(r[0].updatedAt, NOW - 100);
  assert.strictEqual(r[1].updatedAt, NOW - 9000);
});

test('limit is honoured but active sessions are kept', (t) => {
  const e = env(t);
  for (let i = 1; i <= 5; i++) e.add(ID(i), J(prompt('s' + i)), i * 1000);
  fs.writeFileSync(path.join(e.registryDir, '1.json'), JSON.stringify({ pid: 1, sessionId: ID(5), status: 'idle' }));
  const r = e.list({ limit: 2, isAlive: () => true });
  assert.deepStrictEqual(r.map((s) => s.id), [ID(5), ID(1), ID(2)]);
});

test('work-dir sessions, stale files and nested subagent files are skipped', (t) => {
  const e = env(t);
  e.add('a', J(prompt('x', { cwd: '/x/claude-report-work' })));
  e.add('b', J(prompt('x', { cwd: 'C:\\x\\ide-companio-work\\y' })), 2000);
  e.add('c', J(prompt('stale')), 91 * 24 * 3600 * 1000);
  e.add('ok', J(prompt('fine')), 3000);
  const sub = path.join(e.projectsDir, 'p', 'ok', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent.jsonl'), J(prompt('sub')));
  assert.deepStrictEqual(e.list().map((s) => s.title), ['fine']);
});

test('never throws on a missing folder', () => {
  assert.deepStrictEqual(listSessions({ projectsDir: path.join(os.tmpdir(), 'nope-' + Date.now()) }), []);
});

test('ageLabel thresholds', () => {
  const a = (ms) => ageLabel(NOW - ms, NOW);
  assert.strictEqual(a(89e3), 'now');
  assert.strictEqual(a(5 * 60e3), '5m');
  assert.strictEqual(a(59 * 60e3), '59m');
  assert.strictEqual(a(4 * 3600e3), '4h');
  assert.strictEqual(a(47 * 3600e3), '47h');
  assert.strictEqual(a(3 * 86400e3), '3d');
  assert.strictEqual(a(13 * 86400e3), '13d');
  assert.strictEqual(a(14 * 86400e3), '2w');
});

test('groupOf uses local calendar days around midnight', () => {
  const now = new Date(2026, 5, 10, 0, 30).getTime();
  const g = (updatedAt, active) => groupOf({ updatedAt, active: !!active }, now);
  assert.strictEqual(g(new Date(2026, 5, 10, 0, 1).getTime()), 'Today');
  assert.strictEqual(g(new Date(2026, 5, 9, 23, 59).getTime()), 'Yesterday');
  assert.strictEqual(g(new Date(2026, 5, 9, 0, 0).getTime()), 'Yesterday');
  assert.strictEqual(g(new Date(2026, 5, 8, 23, 59).getTime()), 'Earlier');
  assert.strictEqual(g(0, true), 'Active');
});

test('isUuid', () => {
  assert.ok(isUuid('123e4567-e89b-12d3-a456-426614174000'));
  assert.ok(!isUuid('123e4567-e89b-12d3-a456-42661417400'));
  assert.ok(!isUuid('x; rm -rf /'));
  assert.ok(!isUuid(null));
});
