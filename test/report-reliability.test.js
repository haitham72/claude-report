'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareLocal, REPORT_SYSTEM_PROMPT } = require('../src/local-report');
const { collectGit, summarizeGit } = require('../src/git-evidence');
const { generateReports } = require('../src/generate');
const { listReports, saveRun, reportDir, loadRun, setReportArchived, recordReportExport, getReportExport,
  deleteReportExport, deleteReportRun } = require('../src/report-store');
const { applyTimeEvidence } = require('../src/time-evidence');
const { scanCodex, mergeProjects } = require('../src/codex-activity');

test('Local waits for the model, uses its Low setting, and sends all three phases to localhost', async () => {
  const requests = [];
  const mock = async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ url, body });
    const value = url.endsWith('/load')
      ? { status: 'loaded', instance_id: 'loaded-identifier' }
      : { output: [{ type: 'reasoning', content: 'hidden' }, { type: 'message', content: '{}' }] };
    return { ok: true, json: async () => value };
  };
  const run = await prepareLocal({ engine: 'lmstudio', model: 'sample', native: true, thinking: true, reasoning: ['off', 'low'] }, { fetchImpl: mock });
  for (const kind of ['project', 'finalizer', 'overview']) assert.equal(await run({ kind, prompt: 'x' }), '{}');
  assert.equal(requests.length, 4);
  assert.match(requests[0].url, /127\.0\.0\.1:1234\/api\/v1\/models\/load$/);
  assert(requests.slice(1).every(({ url, body }) => url.endsWith('/api/v1/chat') && body.model === 'loaded-identifier' && body.reasoning === 'low' && body.system_prompt === REPORT_SYSTEM_PROMPT && body.store === false));
});

test('local model loads use the budgeted context and reuse the context of a loaded instance', async () => {
  const target = { engine: 'lmstudio', model: 'sample', native: true, reasoning: [] };
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push(JSON.parse(request.body));
    return { ok: true, json: async () => url.endsWith('/load')
      ? { status: 'loaded', instance_id: 'new-instance' }
      : { output: [{ type: 'message', content: '{}' }] } };
  };
  const fresh = await prepareLocal({ ...target, reportContext: 13312 }, { fetchImpl });
  assert.equal(fresh.context, 13312);
  assert.equal(calls[0].context_length, 13312);
  const loaded = await prepareLocal({ ...target, instanceId: 'existing', loadedContext: 8192, reportContext: 0 }, { fetchImpl });
  assert.equal(loaded.context, 8192);
  await loaded({ kind: 'project', prompt: 'fixture' });
  assert.equal(calls[1].model, 'existing');
  await assert.rejects(prepareLocal({ ...target, reportContext: 0 }, { fetchImpl }), /90% GPU memory budget/);
  assert.equal(calls.length, 2);
});

test('Local shrinks a prompt on invalid output and shows cause for persistent failure', async () => {
  const calls = [];
  const events = [];
  const prompts = Array.from({ length: 20 }, (_, i) => ({ at: '2026-11-18', text: 'Sufficient detail for prompt ' + i }));
  const projects = ['a', 'b'].map((name) => ({ name, prompts }));
  const result = await generateReports({
    projects, concurrency: 1, local: true, models: { project: { model: 'local' }, finalizer: null },
    run: async ({ prompt }) => {
      calls.push(prompt);
      if (prompt.includes('"project":"b"')) throw new Error('Local server HTTP 503');
      return calls.length === 1 ? 'bad json' : '{"summary":"Worked on a.","examples":[{"task":"Sample","withoutAI":"3 days","withAI":"1 day"}]}';
    },
    onProgress: (event) => events.push(event)
  });
  assert.equal(calls.length, 3);
  assert(calls[1].length < calls[0].length);
  assert.deepEqual(result.failures, [{ project: 'b', error: 'Local server HTTP 503' }]);
  assert(events.some((event) => event.status === 'failed' && event.error === 'Local server HTTP 503'));
  assert.equal(result.reports.a.examples[0].withAI, '');
  applyTimeEvidence(result.reports, { a: [{ task: 'Sample', spent: 2, baseline: null }] });
  assert.equal(result.reports.a.examples[0].withAI, '2 h');
  assert.equal(result.reports.a.examples[0].withoutAI, '');
});

test('saving again preserves the first run and reads legacy months alongside both', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runs-'));
  const month = '2026-11';
  const data = { month, projects: [{ name: 'sample', report: {} }] };
  const dir = reportDir(home, month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'report.html'), 'legacy');

  const now = new Date(2026, 10, 18, 16, 35, 15, 123);
  const first = saveRun(home, data, {}, 'one', now);
  const second = saveRun(home, { ...data, failures: [{ project: 'other', error: 'timed out' }] }, {}, 'two', now);
  assert.notEqual(first, second);
  assert.deepEqual(listReports(home).map((report) => [report.run, report.partial]), [[second, true], [first, false], ['', false]]);
  assert.equal(fs.readFileSync(path.join(reportDir(home, month, first), 'report.html'), 'utf8'), 'one');
  assert.throws(() => reportDir(home, month, '../report'), /Invalid report reference/);
});

test('archives individual runs and keeps private revision data out of the report payload and history list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-history-'));
  const data = { month: '2026-11', projects: [] };
  const parentRun = saveRun(home, data, {}, 'original');
  const metadata = { parentRun, provider: 'local', events: [{ message: 'Private diagnostic detail' }] };
  const evidence = { sample: [{ text: 'Redacted evidence' }] };
  const run = saveRun(home, data, {}, 'edited', new Date(), { metadata, evidence });
  setReportArchived(home, data.month, parentRun, true);

  assert.deepEqual(listReports(home).map((entry) => entry.run), [run]);
  const history = listReports(home, { includeArchived: true });
  assert.equal(history.find((entry) => entry.run === parentRun).archived, true);
  assert.deepEqual(history.find((entry) => entry.run === run).metadata, { parentRun, provider: 'local' });
  assert.deepEqual(loadRun(home, data.month, run), { data, reports: {}, metadata, evidence, archived: false, exports: [] });

  setReportArchived(home, data.month, parentRun, false);
  assert.equal(listReports(home).length, 2);
});

test('tracks saved copies by ID and preserves a replacement at the same export path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-copies-'));
  const data = { month: '2026-11', projects: [] };
  const run = saveRun(home, data, {}, 'original');
  const exported = path.join(home, 'Report_11-18-2026_12-00-00_sample.pdf');
  fs.writeFileSync(exported, 'copy');
  const first = recordReportExport(home, data.month, run, exported);
  assert.deepEqual(getReportExport(home, data.month, run, first.id), first);
  assert.equal(listReports(home)[0].exports[0].format, 'pdf');
  assert.throws(() => getReportExport(home, data.month, run, exported), /not found/);

  fs.unlinkSync(exported);
  fs.writeFileSync(exported, 'replacement');
  const trash = async (file) => fs.unlinkSync(file);
  assert.equal(getReportExport(home, data.month, run, first.id).missing, true);
  assert.equal((await deleteReportExport(home, data.month, run, first.id, trash)).deleted, false);
  assert.equal(fs.readFileSync(exported, 'utf8'), 'replacement');

  const second = recordReportExport(home, data.month, run, exported);
  await assert.rejects(deleteReportExport(home, data.month, run, second.id, async () => { throw new Error('trash unavailable'); }), /trash unavailable/);
  assert.equal(getReportExport(home, data.month, run, second.id).missing, false);
  assert.equal((await deleteReportExport(home, data.month, run, second.id, trash)).deleted, true);
  assert.deepEqual(listReports(home)[0].exports, []);
  assert.equal(fs.existsSync(exported), false);
});

test('trashes the legacy report and its private attachment while retaining new runs and exported copies', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-delete-'));
  const data = { month: '2026-11', projects: [] };
  const monthDir = reportDir(home, data.month);
  const run = saveRun(home, data, {}, 'new');
  fs.writeFileSync(path.join(monthDir, 'report.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(monthDir, 'report.html'), 'legacy');
  const attachment = path.join(monthDir, 'Report_11-18-2026_12-00-00_sample.html');
  fs.writeFileSync(attachment, 'attachment');
  const exported = path.join(monthDir, 'Report_11-18-2026_12-00-00_sample-2.html');
  fs.writeFileSync(exported, 'saved copy');
  recordReportExport(home, data.month, '', exported);
  const unrelated = path.join(monthDir, 'session.jsonl');
  fs.writeFileSync(unrelated, 'original');
  const trash = async (dir) => {
    assert.equal(path.dirname(dir), monthDir);
    assert.match(path.basename(dir), /^\.deleted-report-/);
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  };

  await assert.rejects(deleteReportRun(home, data.month, '', async () => { throw new Error('trash unavailable'); }), /trash unavailable/);
  assert.equal(listReports(home).length, 2);
  await deleteReportRun(home, data.month, '', trash);
  assert.deepEqual(listReports(home).map((entry) => entry.run), [run]);
  assert.equal(fs.existsSync(attachment), false);
  assert.equal(fs.readFileSync(exported, 'utf8'), 'saved copy');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'original');
});

test('Git evidence reads all refs, filters dates and authors, and keeps commits separate from estimates', () => {
  const args = [];
  const stamp = '2026-11-18T12:00:00Z';
  const me = 'me@example.test';
  const spawn = (git, command) => {
    args.push([git, ...command]);
    if (command.includes('config')) return { status: 0, stdout: me + '\n' };
    return { status: 0, stdout: [
      ['a'.repeat(40), stamp, stamp, me, 'Add feature'],
      ['b'.repeat(40), '2026-12-01T00:00:00Z', stamp, me, 'Later'],
      ['c'.repeat(40), stamp, stamp, 'teammate@example.test', 'Teammate change']
    ].map((fields) => fields.join('\t')).join('\n') };
  };
  const evidence = collectGit([
    { name: 'sample', repositories: [path.join(os.tmpdir(), 'repo'), path.join(os.tmpdir(), 'repo')] },
    { name: 'without git' }
  ], '2026-11', new Date('2026-11-20T00:00:00Z'), spawn);
  assert.equal(args.filter((call) => call.includes('log')).length, 1);
  assert(args.find((call) => call.includes('log')).includes('--all'));
  assert.equal(evidence.sample.count, 1);
  assert.equal(evidence.sample.first, stamp);
  assert.equal(evidence['without git'].count, 0);
  assert.equal(summarizeGit(evidence.sample).commits[0].subject, 'Add feature');
});

test('Git evidence marks unknown authors and keeps every commit rather than guessing', () => {
  const stamp = '2026-11-18T12:00:00Z';
  const spawn = (git, command) => command.includes('config') ? { status: 1, stdout: '' }
    : { status: 0, stdout: ['a'.repeat(40), stamp, stamp, 'someone@example.test', 'Change'].join('\t') };
  const evidence = collectGit([{ name: 'sample', repositories: [path.join(os.tmpdir(), 'repo')] }], '2026-11', new Date('2026-11-20T00:00:00Z'), spawn);
  assert.equal(evidence.sample.count, 1);
  assert.equal(evidence.sample.repositories[0].authorUnknown, true);
});

test('Codex counts redacted user activity and ignores repeated token snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-codex-'));
  const date = new Date('2026-11-18T12:00:00Z');
  const at = date.toISOString();
  const usage = { input_tokens: 14, cached_input_tokens: 4, output_tokens: 4 };
  const record = (type, payload) => ({ type, timestamp: at, payload });
  const events = [
    record('session_meta', { cwd: root }),
    record('turn_context', { model: 'sample' }),
    record('event_msg', { type: 'user_message', message: 'Please write a test for this feature.' }),
    record('event_msg', { type: 'user_message', message: 'Inspect the .env settings' }),
    ...[1, 2].map(() => record('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } }))
  ];
  fs.writeFileSync(path.join(root, 'rollout-fixture.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
  const rows = scanCodex(new Date('2000-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'), root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalTokens, 18);
  assert.equal(rows[0].prompts.length, 1);
  assert.equal(rows[0].prompts[0].source, 'codex');
  assert.equal(mergeProjects(rows, rows)[0].totalTokens, 36);
});

test('Codex reads newer user response items and counts mirrored prompts once per turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-codex-response-'));
  const at = '2026-11-18T12:00:00Z';
  const record = (type, payload) => ({ type, timestamp: at, payload });
  const input = 'Review the settings screen layout.';
  const response = (turn) => record('response_item', {
    type: 'message', role: 'user',
    content: [
      { type: 'input_text', text: 'Automatically supplied context' },
      { type: 'input_text', text: input }
    ],
    internal_chat_message_metadata_passthrough: {
      turn_id: turn,
      content_item_kinds: ['environments.environment_context', 'user.text'],
      content_item_metadata: [{ provenance: { type: 'harness' } }, { provenance: { type: 'user' } }]
    }
  });
  const events = [
    record('session_meta', { cwd: root }),
    record('event_msg', { type: 'task_started', turn_id: 'first' }),
    response('first'),
    record('event_msg', { type: 'user_message', message: input }),
    record('event_msg', { type: 'task_started', turn_id: 'second' }),
    response('second'),
    record('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>Automatic context</environment_context>' }]
    })
  ];
  fs.writeFileSync(path.join(root, 'rollout-fixture.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
  const [project] = scanCodex(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'), root, { identifyProjects: true });
  assert.equal(project.promptCount, 2);
  assert.deepEqual(project.prompts.map(({ text }) => text), [input, input]);
});
