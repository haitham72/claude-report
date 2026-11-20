'use strict';

// Local model servers (LM Studio, Ollama) for the Connect tab: which models are
// there and the largest context each fits on this GPU. Read-only, localhost only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const MIB = 1024 * 1024;
const GGUF_SCAN_LIMIT = 16 * MIB;
const ENGINES = {
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', probe: '/api/v0/models' },
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', probe: '/api/tags' },
};

function defaultRun(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * MIB },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function gpuInfo({ run = defaultRun } = {}) {
  try {
    const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits']);
    // Several GPUs: the first line is where models are placed by default.
    const line = String(out).split(/\r?\n/).find((l) => l.trim());
    if (!line) return null;
    const p = line.split(',').map((s) => s.trim());
    const [totalMiB, usedMiB, freeMiB] = p.slice(1, 4).map(Number);
    if (!p[0] || ![totalMiB, usedMiB, freeMiB].every(Number.isFinite)) return null;
    return { name: p[0], totalMiB, usedMiB, freeMiB };
  } catch { return null; }
}

// GGUF value types: 0..5 ints, 6 f32, 7 bool, 8 string, 9 array, 10..12 u64/i64/f64
const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function readGgufMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let start = 0;
    let win = Buffer.alloc(0);
    let off = 0;
    const need = (n) => {
      if (off + n > GGUF_SCAN_LIMIT || off + n > fileSize) throw new Error('eof');
      if (off >= start && off + n <= start + win.length) return;
      const len = Math.min(Math.max(n, 512 * 1024), fileSize - off);
      const b = Buffer.alloc(len);
      const got = fs.readSync(fd, b, 0, len, off);
      if (got < n) throw new Error('short');
      start = off; win = b.subarray(0, got);
    };
    const u32 = () => { need(4); const v = win.readUInt32LE(off - start); off += 4; return v; };
    const u64 = () => { need(8); const v = Number(win.readBigUInt64LE(off - start)); off += 8; return v; };
    const str = () => {
      const n = u64();
      if (n > 1 << 20) throw new Error('str');
      need(n); const s = win.toString('utf8', off - start, off - start + n); off += n; return s;
    };
    const scalar = (t) => {
      need(FIXED[t]);
      const o = off - start; let v;
      switch (t) {
        case 0: v = win.readUInt8(o); break;
        case 1: v = win.readInt8(o); break;
        case 2: v = win.readUInt16LE(o); break;
        case 3: v = win.readInt16LE(o); break;
        case 4: v = win.readUInt32LE(o); break;
        case 5: v = win.readInt32LE(o); break;
        case 6: v = win.readFloatLE(o); break;
        case 7: v = win.readUInt8(o) !== 0; break;
        case 10: v = Number(win.readBigUInt64LE(o)); break;
        case 11: v = Number(win.readBigInt64LE(o)); break;
        default: v = win.readDoubleLE(o);
      }
      off += FIXED[t]; return v;
    };
    // Wanted arrays collapse to their max element; everything else is skipped.
    const value = (t, wanted) => {
      if (t === 8) { if (wanted) return str(); const n = u64(); off += n; return undefined; }
      if (t === 9) {
        const et = u32(); const n = u64();
        if (wanted && FIXED[et]) { let m = -Infinity; for (let i = 0; i < n; i++) m = Math.max(m, scalar(et)); return m; }
        if (FIXED[et]) { off += n * FIXED[et]; return undefined; }
        for (let i = 0; i < n; i++) value(et, false);
        return undefined;
      }
      if (!FIXED[t]) throw new Error('type');
      return scalar(t);
    };

    need(24);
    if (win.toString('latin1', 0, 4) !== 'GGUF') return null;
    off = 4;
    const version = u32();
    if (version !== 2 && version !== 3) return null;
    u64(); // tensor count
    const kvCount = u64();

    const m = { arch: null, blockCount: null, headCountKv: null, headCount: null, keyLength: null,
      valueLength: null, embeddingLength: null, contextLength: null, fileSize };
    const suffix = { 'block_count': 'blockCount', 'attention.head_count_kv': 'headCountKv',
      'attention.head_count': 'headCount', 'attention.key_length': 'keyLength',
      'attention.value_length': 'valueLength', 'embedding_length': 'embeddingLength',
      'context_length': 'contextLength' };
    const done = () => m.arch && Object.values(suffix).every((f) => m[f] != null);
    for (let i = 0; i < kvCount; i++) {
      const key = str(); const t = u32();
      let field = null;
      if (key === 'general.architecture') field = 'arch';
      else if (m.arch && key.startsWith(m.arch + '.')) field = suffix[key.slice(m.arch.length + 1)] || null;
      const v = value(t, !!field);
      if (field && v !== undefined) m[field] = v;
      if (done()) break;
    }
    if (!m.arch || !m.blockCount) return null;
    if (!m.keyLength && m.embeddingLength && m.headCount) m.keyLength = Math.floor(m.embeddingLength / m.headCount);
    return m;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// K and V per layer per token. Sliding-window and hybrid (linear-attention)
// architectures cache less than this, so it is a safe upper bound: the context
// we report is an estimate that real runs usually beat.
function kvBytesPerToken(meta, { bytesPerElement = 2 } = {}) {
  if (!meta || !meta.blockCount || !meta.headCountKv) return null;
  const k = meta.keyLength || meta.valueLength;
  if (!k) return null;
  return 2 * meta.blockCount * meta.headCountKv * k * bytesPerElement;
}

// For atFreeNow pass weightsBytes 0 when the model is already loaded: its
// weights are inside the used VRAM, so free memory only has to hold the cache.
function maxContextOnGpu({ gpu, weightsBytes, kvPerToken, modelMaxContext, overheadMiB = 1200, memoryFraction = 1 } = {}) {
  const none = { atCapacity: null, atFreeNow: null };
  if (!gpu || !(kvPerToken > 0) || !(weightsBytes >= 0) || !(modelMaxContext > 0)) return none;
  const fit = (vramMiB, weights) => {
    if (!Number.isFinite(vramMiB)) return null;
    const t = Math.floor((vramMiB * MIB - weights - overheadMiB * MIB) / kvPerToken);
    const c = Math.min(Math.max(t, 0), modelMaxContext);
    return Math.floor(c / 1024) * 1024;
  };
  const reserve = gpu.totalMiB * (1 - memoryFraction);
  return { atCapacity: fit(gpu.totalMiB - reserve, weightsBytes), atFreeNow: fit(gpu.freeMiB - reserve, weightsBytes) };
}

async function getJson(fetchImpl, url, timeoutMs, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function detectEngines({ fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  return Promise.all(Object.entries(ENGINES).map(async ([engine, e]) => {
    let running = false;
    try { await getJson(fetchImpl, e.baseUrl + e.probe, timeoutMs); running = true; } catch { /* down */ }
    return { engine, name: e.name, baseUrl: e.baseUrl, running };
  }));
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function modelDirs(fsImpl) {
  const home = os.homedir();
  const dirs = [path.join(home, '.lmstudio', 'models'), path.join(home, '.cache', 'lm-studio', 'models')];
  return dirs.filter((d) => { try { return fsImpl.statSync(d).isDirectory(); } catch { return false; } });
}

function walkGguf(fsImpl, root, depth = 0, out = []) {
  let ents; try { ents = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (depth < 3) walkGguf(fsImpl, p, depth + 1, out); }
    else if (/.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) out.push(p);
  }
  return out;
}

// LM Studio ids are often hub aliases ('google/gemma-4-12b-qat') with no folder of
// that name, so match the id's tokens (and the quantization) against file paths;
// on a tie the shortest path wins (the plain upstream build over fine-tunes).
function findGguf(fsImpl, dirs, id, quant) {
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = id.split('/').pop().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const q = quant ? squash(quant) : '';
  let best = null;
  for (const d of dirs) {
    for (const p of walkGguf(fsImpl, d)) {
      const n = squash(path.relative(d, p));
      if (tokens.every((t) => n.includes(t)) && (!q || n.includes(q)) && (!best || p.length < best.length)) best = p;
    }
  }
  return best;
}

async function lmsList(exec) {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'lms.exe' : 'lms';
  for (const cmd of [path.join(home, '.cache', 'lm-studio', 'bin', exe), path.join(home, '.lmstudio', 'bin', exe), 'lms']) {
    try { const j = JSON.parse(await exec(cmd, ['ls', '--json'])); if (Array.isArray(j)) return j; } catch { /* next */ }
  }
  return [];
}

const loadedFirstBySize = (a, b) =>
  (a.state === 'loaded' ? 0 : 1) - (b.state === 'loaded' ? 0 : 1) || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);

function withFit(base, gpu, meta, sizeBytes) {
  const kv = kvBytesPerToken(meta);
  const cap = base.maxContext || (meta && meta.contextLength);
  const fit = sizeBytes != null && kv
    ? maxContextOnGpu({ gpu, weightsBytes: sizeBytes, kvPerToken: kv, modelMaxContext: cap }) : null;
  const ok = !!fit && fit.atCapacity != null;
  let now = ok ? fit.atFreeNow : null;
  // Already loaded: its weights are in the used VRAM, so only the cache must fit in what is free.
  if (ok && base.state === 'loaded') {
    now = maxContextOnGpu({ gpu, weightsBytes: 0, kvPerToken: kv, modelMaxContext: cap }).atFreeNow;
  }
  const reportFit = ok
    ? maxContextOnGpu({ gpu, weightsBytes: sizeBytes, kvPerToken: kv, modelMaxContext: cap, memoryFraction: 0.9 })
    : null;
  return { ...base, sizeBytes, maxOnGpu: ok ? fit.atCapacity : null, maxOnGpuNow: now,
    reportContext: reportFit?.atFreeNow ?? null, estimated: !ok };
}

async function listModels({ engine, baseUrl, fetchImpl = globalThis.fetch, gpu, exec = defaultRun, fsImpl = fs, timeoutMs = 4000 } = {}) {
  try {
    const e = ENGINES[engine];
    if (!e) return [];
    const url = baseUrl || e.baseUrl;
    const out = engine === 'lmstudio'
      ? await listLmStudio({ baseUrl: url, fetchImpl, gpu, exec, fsImpl, timeoutMs })
      : await listOllama({ baseUrl: url, fetchImpl, gpu, timeoutMs });
    return out.sort(loadedFirstBySize);
  } catch { return []; }
}

async function listLmStudio({ baseUrl, fetchImpl, gpu, exec, fsImpl, timeoutMs }) {
  const j = await getJson(fetchImpl, baseUrl + '/api/v0/models', timeoutMs);
  const models = (j.data || []).filter((m) => m.type !== 'embeddings');
  const files = await lmsList(exec);
  const dirs = modelDirs(fsImpl);
  return models.map((m) => {
    const f = files.find((x) => x.modelKey === m.id || x.path === m.id || (x.path || '').includes(m.id));
    let file = null;
    if (f && f.path) {
      file = dirs.map((d) => path.join(d, f.path)).find((p) => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } }) || null;
    }
    if (!file) file = findGguf(fsImpl, dirs, m.id, m.quantization);
    const meta = file ? readGgufMeta(file) : null;
    const sizeBytes = (f && f.sizeBytes) || (meta && meta.fileSize) || null;
    const base = { id: m.id, engine: 'lmstudio', publisher: m.publisher || null, arch: m.arch || (meta && meta.arch) || null,
      quantization: m.quantization || null, type: m.type, state: m.state === 'loaded' ? 'loaded' : 'idle',
      paramsString: (f && f.paramsString) || null, maxContext: m.max_context_length || (meta && meta.contextLength) || null,
      loadedContext: m.loaded_context_length || null };
    return withFit(base, gpu, meta, sizeBytes);
  });
}

async function listOllama({ baseUrl, fetchImpl, gpu, timeoutMs }) {
  const tags = await getJson(fetchImpl, baseUrl + '/api/tags', timeoutMs);
  let loaded = new Map();
  try {
    loaded = new Map(((await getJson(fetchImpl, baseUrl + '/api/ps', timeoutMs)).models || []).map((m) => [m.name || m.model, m.context_length]));
  } catch { /* optional */ }
  return Promise.all((tags.models || []).map(async (m) => {
    const name = m.name || m.model;
    let info = {};
    try {
      info = (await getJson(fetchImpl, baseUrl + '/api/show', timeoutMs, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) })).model_info || {};
    } catch { /* leave empty */ }
    const arch = info['general.architecture']
      || (Object.keys(info).find((k) => k.endsWith('.block_count')) || '').replace(/\.block_count$/, '') || null;
    const g = (s) => (arch ? info[`${arch}.${s}`] : undefined);
    const heads = g('attention.head_count');
    const kvh = g('attention.head_count_kv');
    const emb = g('embedding_length');
    const meta = arch && g('block_count') && kvh ? {
      arch, blockCount: g('block_count'), headCountKv: Array.isArray(kvh) ? Math.max(...kvh) : kvh, headCount: heads,
      keyLength: g('attention.key_length') || g('attention.value_length') || (emb && heads ? Math.floor(emb / heads) : null),
      valueLength: g('attention.value_length'), embeddingLength: emb, contextLength: g('context_length') } : null;
    const d = m.details || {};
    const base = { id: name, engine: 'ollama', publisher: null, arch, quantization: d.quantization_level || null,
      type: 'llm', state: loaded.has(name) ? 'loaded' : 'idle', paramsString: d.parameter_size || null,
      maxContext: (meta && meta.contextLength) || null, loadedContext: loaded.get(name) || null };
    return withFit(base, gpu, meta, m.size ?? null);
  }));
}

module.exports = { gpuInfo, readGgufMeta, kvBytesPerToken, maxContextOnGpu, detectEngines, listModels, formatTokens };
