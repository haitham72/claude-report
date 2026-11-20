'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lm = require('../src/local-models');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function str(s) { const t = Buffer.from(s); return Buffer.concat([u64(t.length), t]); }

function ggufBuffer(kvs) {
  const parts = [Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length)];
  for (const [k, t, v] of kvs) {
    parts.push(str(k), u32(t));
    if (t === 8) parts.push(str(v));
    else if (t === 4) parts.push(u32(v));
    else if (t === 9) {
      parts.push(u32(v.t), u64(v.items.length));
      for (const x of v.items) parts.push(v.t === 8 ? str(x) : u32(x));
    }
  }
  return Buffer.concat(parts);
}

function tmpGguf(kvs) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-')), 'm.gguf');
  fs.writeFileSync(f, ggufBuffer(kvs));
  return f;
}

const qwen3 = [
  ['general.architecture', 8, 'qwen3'],
  ['tokenizer.junk', 9, { t: 8, items: ['a', 'bb'] }],
  ['qwen3.block_count', 4, 36],
  ['qwen3.attention.head_count_kv', 4, 8],
  ['qwen3.attention.head_count', 4, 32],
  ['qwen3.attention.key_length', 4, 128],
  ['qwen3.embedding_length', 4, 2560],
  ['qwen3.context_length', 4, 262144],
  ['after', 8, 'never read'],
];

test('readGgufMeta parses header with strings and arrays', () => {
  const m = lm.readGgufMeta(tmpGguf(qwen3));
  assert.ok(m.fileSize > 100);
  assert.deepStrictEqual({ ...m, fileSize: 0 }, { arch: 'qwen3', blockCount: 36, headCountKv: 8, headCount: 32,
    keyLength: 128, valueLength: null, embeddingLength: 2560, contextLength: 262144, fileSize: 0 });
});

test('readGgufMeta: kv array uses max, key_length falls back, bad files give null', () => {
  const f = tmpGguf([['general.architecture', 8, 'x'], ['x.block_count', 4, 4],
    ['x.attention.head_count_kv', 9, { t: 4, items: [0, 2, 4, 0] }], ['x.attention.head_count', 4, 8],
    ['x.embedding_length', 4, 512]]);
  const m = lm.readGgufMeta(f);
  assert.strictEqual(m.headCountKv, 4);
  assert.strictEqual(m.keyLength, 64);
  const bad = path.join(path.dirname(f), 'bad.gguf');
  fs.writeFileSync(bad, 'nope-not-gguf-nope-not-gguf');
  assert.strictEqual(lm.readGgufMeta(bad), null);
  assert.strictEqual(lm.readGgufMeta(path.join(path.dirname(f), 'missing')), null);
});

test('kvBytesPerToken for Qwen3-4B', () => {
  assert.strictEqual(lm.kvBytesPerToken({ blockCount: 36, headCountKv: 8, keyLength: 128 }), 147456);
  assert.strictEqual(lm.kvBytesPerToken({}), null);
});

test('maxContextOnGpu fits, clamps, rounds to 1024', () => {
  const gpu = { totalMiB: 16376, freeMiB: 1989 };
  const r = lm.maxContextOnGpu({ gpu, weightsBytes: 2.5e9, kvPerToken: 147456, modelMaxContext: 262144 });
  assert.ok(r.atCapacity > 90000 && r.atCapacity < 110000, String(r.atCapacity));
  assert.strictEqual(r.atCapacity % 1024, 0);
  assert.strictEqual(lm.maxContextOnGpu({ gpu, weightsBytes: 2.5e9, kvPerToken: 147456, modelMaxContext: 32768 }).atCapacity, 32768);
  assert.strictEqual(r.atFreeNow, 0);
  assert.deepStrictEqual(lm.maxContextOnGpu({ gpu: null }), { atCapacity: null, atFreeNow: null });
});

test('the report context reserves ten percent of the total GPU before spending free VRAM', () => {
  const gpu = { totalMiB: 16000, freeMiB: 14000 };
  const fit = lm.maxContextOnGpu({
    gpu, weightsBytes: 9600 * 1024 ** 2, overheadMiB: 1200, kvPerToken: 128 * 1024,
    modelMaxContext: 262144, memoryFraction: 0.9
  });
  assert.deepStrictEqual(fit, { atCapacity: 28672, atFreeNow: 12288 });
});

test('gpuInfo parses injected nvidia-smi output and never throws', async () => {
  const g = await lm.gpuInfo({ run: async () => 'NVIDIA GeForce RTX 4080, 16376, 14062, 1989\n' });
  assert.deepStrictEqual(g, { name: 'NVIDIA GeForce RTX 4080', totalMiB: 16376, usedMiB: 14062, freeMiB: 1989 });
  assert.strictEqual(await lm.gpuInfo({ run: async () => { throw new Error('ENOENT'); } }), null);
  assert.strictEqual(await lm.gpuInfo({ run: async () => 'garbage' }), null);
});

const json = (o) => ({ ok: true, json: async () => o });

test('detectEngines lists both, one up one down', async () => {
  const fetchImpl = async (u) => { if (u.includes(':1234')) return json({ data: [] }); throw new Error('ECONNREFUSED'); };
  const r = await lm.detectEngines({ fetchImpl });
  assert.deepStrictEqual(r.map((e) => [e.engine, e.running]), [['lmstudio', true], ['ollama', false]]);
});

test('listModels LM Studio: skips embeddings, sorts loaded first, uses lms size and GGUF', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lmh-'));
  const dir = path.join(home, '.lmstudio', 'models', 'qwen', 'q');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'qwen3-4b-2507.gguf'), ggufBuffer(qwen3));
  const origHome = os.homedir;
  os.homedir = () => home;
  try {
    const fetchImpl = async () => json({ data: [
      { id: 'big/model', type: 'llm', arch: 'qwen3', quantization: 'Q8', state: 'not-loaded', max_context_length: 8192 },
      { id: 'embed/x', type: 'embeddings', state: 'not-loaded' },
      { id: 'qwen/qwen3-4b-2507', type: 'llm', publisher: 'qwen', arch: 'qwen3', quantization: 'Q4_K_M', state: 'loaded',
        max_context_length: 262144, loaded_context_length: 110857 }] });
    const exec = async () => JSON.stringify([{ modelKey: 'qwen/qwen3-4b-2507', path: 'qwen/q/qwen3-4b-2507.gguf',
      sizeBytes: 2.5e9, paramsString: '4B' }]);
    const gpu = { name: 'g', totalMiB: 16376, usedMiB: 14062, freeMiB: 1989 };
    const r = await lm.listModels({ engine: 'lmstudio', fetchImpl, gpu, exec });
    assert.deepStrictEqual(r.map((m) => m.id), ['qwen/qwen3-4b-2507', 'big/model']);
    assert.strictEqual(r[0].state, 'loaded');
    assert.strictEqual(r[0].estimated, false);
    assert.ok(r[0].maxOnGpu > 90000);
    assert.ok(r[0].maxOnGpuNow > 0 && r[0].maxOnGpuNow < r[0].maxOnGpu);
    assert.strictEqual(r[1].maxOnGpu, null);
    assert.strictEqual(r[1].estimated, true);
  } finally { os.homedir = origHome; }
});

test('listModels Ollama via /api/show; down server gives []', async () => {
  const info = { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count_kv': 8,
    'llama.attention.head_count': 32, 'llama.embedding_length': 4096, 'llama.context_length': 131072 };
  const fetchImpl = async (u) => {
    if (u.endsWith('/api/tags')) {
      return json({ models: [{ name: 'b:70b', size: 4e10, details: {} },
        { name: 'a:8b', size: 4.9e9, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } }] });
    }
    if (u.endsWith('/api/ps')) return json({ models: [{ name: 'b:70b' }] });
    if (u.endsWith('/api/show')) return json({ model_info: info });
    throw new Error('x');
  };
  const gpu = { totalMiB: 16376, usedMiB: 0, freeMiB: 16000 };
  const r = await lm.listModels({ engine: 'ollama', fetchImpl, gpu });
  assert.deepStrictEqual(r.map((m) => m.id), ['b:70b', 'a:8b']);
  assert.strictEqual(r[0].maxOnGpu, 0);
  assert.ok(r[1].maxOnGpu > 0 && r[1].maxOnGpu <= 131072);
  const down = await lm.listModels({ engine: 'ollama', fetchImpl: async () => { throw new Error('refused'); }, gpu });
  assert.deepStrictEqual(down, []);
});

test('formatTokens', () => {
  assert.deepStrictEqual([85000, 262144, 1048576, 500].map(lm.formatTokens), ['85k', '262k', '1.0M', '500']);
});
