'use strict';

// Runs one prompt on a model served from this computer: LM Studio (port 1234) or Ollama (port 11434),
// both through their OpenAI-compatible endpoint. Nothing here leaves localhost.
const ENGINES = {
  lmstudio: { name: 'LM Studio', base: 'http://127.0.0.1:1234' },
  ollama: { name: 'Ollama', base: 'http://127.0.0.1:11434' }
};

const str = { type: 'string' };
// The shape of one project report. Small models follow a schema far more reliably than a prose request.
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    project: str,
    summary: str,
    usedFor: { type: 'array', items: str },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: str, detail: str, basis: str },
        required: ['task', 'detail', 'basis'],
        additionalProperties: false
      }
    },
    didntWork: { type: 'array', items: str },
    nextMonth: { type: 'array', items: str },
    promptNote: str
  },
  required: ['project', 'summary', 'usedFor', 'examples', 'didntWork', 'nextMonth'],
  additionalProperties: false
};

const exampleSchema = REPORT_SCHEMA.properties.examples.items;
const estimate = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] };
const REPORT_ESTIMATE_SCHEMA = {
  ...REPORT_SCHEMA, properties: {
    ...REPORT_SCHEMA.properties,
    examples: { type: 'array', items: {
      ...exampleSchema, properties: { ...exampleSchema.properties, withoutAIMinutes: estimate, withAIMinutes: estimate },
      required: [...exampleSchema.required, 'withoutAIMinutes', 'withAIMinutes']
    } }
  }
};

// Reasoning models put their thinking in <think> tags; only the answer is wanted.
const stripThinking = (text) => String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// run: ({ prompt }) => text. A server that rejects the schema (HTTP 400) gets the same request without it.
async function runLocal({ engine = 'lmstudio', baseUrl, model, prompt, systemPrompt, signal, maxTokens = 4000, timeoutMs = 300000, schema = REPORT_SCHEMA, fetchImpl = globalThis.fetch }) {
  signal?.throwIfAborted();
  if (!model) throw new Error('local model: no model chosen');
  const info = ENGINES[engine];
  if (!info && !baseUrl) throw new Error(`local model: unknown engine "${engine}"`);
  const base = String(baseUrl || info.base).replace(/\/+$/, '');

  async function call(withSchema, budget, thinkingOff) {
    signal?.throwIfAborted();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const body = {
        model,
        messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: budget,
        stream: false
      };
      // Thinking is never wanted here. LM Studio already skips it while a schema is enforced; these ask for it explicitly.
      if (thinkingOff) { body.reasoning_effort = 'none'; body.chat_template_kwargs = { enable_thinking: false }; }
      if (withSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'report', strict: true, schema } };
      const res = await fetchImpl(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      ctl.signal.throwIfAborted();
      if (!res.ok) {
        const e = new Error(`local model: HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const choice = JSON.parse(text).choices?.[0];
      const reply = choice?.message?.content;
      // A thinking model can spend the whole budget before it writes the answer, or a small one can ramble.
      if (choice?.finish_reason === 'length') {
        const e = new Error('local model: ran out of tokens');
        e.code = 'length';
        throw e;
      }
      if (typeof reply !== 'string' || !stripThinking(reply)) throw new Error('local model: empty reply');
      return stripThinking(reply);
    } catch (e) {
      signal?.throwIfAborted();
      if (ctl.signal.aborted || e.name === 'AbortError') throw new Error(`local model: timed out after ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Out of tokens: once more with twice the budget.
  const attempt = async (withSchema, thinkingOff) => {
    try {
      return await call(withSchema, maxTokens, thinkingOff);
    } catch (e) {
      if (e.code === 'length') return call(withSchema, maxTokens * 2, thinkingOff);
      throw e;
    }
  };
  // A server that rejects a request (HTTP 400) gets a plainer one: first without the thinking flags, then without the schema.
  const plans = schema ? [[true, true], [true, false], [false, false]] : [[false, true], [false, false]];
  let last;
  for (const [withSchema, thinkingOff] of plans) {
    try {
      return await attempt(withSchema, thinkingOff);
    } catch (e) {
      last = e;
      if (e.status !== 400) throw e;
    }
  }
  throw last;
}

module.exports = { runLocal, stripThinking, ENGINES, REPORT_SCHEMA, REPORT_ESTIMATE_SCHEMA };
