'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runLocal, stripThinking, REPORT_SCHEMA } = require('../src/local-llm');
const { prepareLocal } = require('../src/local-report');

const reply = (content) => ({ choices: [{ message: { content } }] });
const fakeFetch = (handler) => async (url, init) => {
  const body = JSON.parse(init.body);
  const out = await handler(url, body);
  return { ok: out.status === undefined, status: out.status || 200, text: async () => JSON.stringify(out.json || {}) };
};

test('sends the prompt to the chosen model on the engine port, with the report schema', async () => {
  let seen;
  const out = await runLocal({ engine: 'lmstudio', model: 'qwen/qwen3-4b-2507', prompt: 'hello', fetchImpl: fakeFetch((url, body) => { seen = { url, body }; return { json: reply('{"ok":1}') }; }) });
  assert.strictEqual(out, '{"ok":1}');
  assert.strictEqual(seen.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.strictEqual(seen.body.model, 'qwen/qwen3-4b-2507');
  assert.deepStrictEqual(seen.body.response_format.json_schema.schema, REPORT_SCHEMA);
});

test('Ollama uses its own port', async () => {
  let url;
  await runLocal({ engine: 'ollama', model: 'm', prompt: 'p', fetchImpl: fakeFetch((u) => { url = u; return { json: reply('x') }; }) });
  assert.strictEqual(url, 'http://127.0.0.1:11434/v1/chat/completions');
});

test('a server that rejects the schema gets the same request without it', async () => {
  const bodies = [];
  const out = await runLocal({ model: 'm', prompt: 'p', fetchImpl: fakeFetch((_u, b) => { bodies.push(b); return b.response_format ? { status: 400, json: {} } : { json: reply('plain') }; }) });
  assert.strictEqual(out, 'plain');
  assert.strictEqual(bodies.length, 3);
  assert.ok(!bodies[2].response_format);
});

test('thinking blocks are removed and empty or failed replies are errors', async () => {
  assert.strictEqual(stripThinking('<think>hmm</think>\n{"a":1}'), '{"a":1}');
  await assert.rejects(runLocal({ model: 'm', prompt: 'p', fetchImpl: fakeFetch(() => ({ json: reply('<think>only</think>') })) }), /empty reply/);
  await assert.rejects(runLocal({ model: 'm', prompt: 'p', fetchImpl: fakeFetch(() => ({ status: 500, json: {} })) }), /HTTP 500/);
  await assert.rejects(runLocal({ prompt: 'p' }), /no model chosen/);
});

test('a slow server times out', async () => {
  const slow = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(runLocal({ model: 'm', prompt: 'p', timeoutMs: 20, schema: null, fetchImpl: slow }), /timed out/);
});

test('cancelling a local request aborts the fetch without retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  const run = runLocal({ model: 'm', prompt: 'p', signal: controller.signal, fetchImpl: (_url, request) => {
    calls++;
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
  } });
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.strictEqual(calls, 1);
});

test('cancelling the native LM Studio route aborts model loading and chat', async () => {
  const target = { engine: 'lmstudio', model: 'm', native: true };
  const urls = [];
  const fetchImpl = (url, { signal }) => {
    urls.push(url);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };

  const loading = new AbortController();
  const pending = prepareLocal(target, { fetchImpl, signal: loading.signal });
  loading.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  const chat = new AbortController();
  const run = await prepareLocal({ ...target, instanceId: 'ready' }, { fetchImpl, signal: chat.signal });
  const message = run({ prompt: 'p', kind: 'project' });
  chat.abort();
  await assert.rejects(message, { name: 'AbortError' });
  assert.deepStrictEqual(urls.map((url) => new URL(url).pathname), ['/api/v1/models/load', '/api/v1/chat']);
});

test('a reply cut off by the token limit is retried once with twice the budget', async () => {
  const budgets = [];
  const out = await runLocal({ model: 'm', prompt: 'p', maxTokens: 100, fetchImpl: async (_u, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.max_tokens);
    const cut = budgets.length === 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: cut ? 'length' : 'stop', message: { content: cut ? '{"a":' : '{"a":1}' } }] }) };
  } });
  assert.strictEqual(out, '{"a":1}');
  assert.deepStrictEqual(budgets, [100, 200]);
});

test('still cut off after the retry is an error', async () => {
  await assert.rejects(runLocal({ model: 'm', prompt: 'p', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) }) }), /ran out of tokens/);
});

test('every request asks for thinking off, and a server that rejects those flags still gets the schema', async () => {
  const bodies = [];
  const out = await runLocal({ model: 'm', prompt: 'p', fetchImpl: fakeFetch((_u, b) => { bodies.push(b); return b.reasoning_effort ? { status: 400, json: {} } : { json: reply('ok') }; }) });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(bodies[0].reasoning_effort, 'none');
  assert.deepStrictEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
  assert.ok(bodies[1].response_format && !bodies[1].reasoning_effort, 'second try keeps the schema, drops the flags');
});
