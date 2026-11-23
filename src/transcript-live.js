'use strict';

// Live model + context % read straight from Claude Code's transcripts, so the
// status bar works in every IDE (the VS Code extension never runs statusLine).
// Only the tail of the newest transcript is read, and only numbers/names leave.
const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 96 * 1024;
const STALE_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 40;
// Our own tooling runs Claude in these folders; they must not hijack the bar.
const IGNORED_CWD = ['claude-report-work', 'ide-companio-work'];

// Heuristic: transcripts do not say whether the 1M window is on, so a turn that
// already holds more than 200k tokens can only have fit in the 1M window.
function contextWindow(model, tokens) {
  return typeof tokens === 'number' && tokens > 200000 ? 1000000 : 200000;
}

function shortModel(id) {
  if (typeof id !== 'string' || !id) return null;
  const s = id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return s && !s.startsWith('<') ? s : null;
}

const norm = (p) => {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function listTranscripts(projectsDir, now, maxAgeMs) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const base = path.join(projectsDir, d.name);
    let names;
    try { names = fs.readdirSync(base); } catch (e) { continue; }
    // Only top-level files: subagent transcripts live in .../subagents/.
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(base, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && now - st.mtimeMs <= maxAgeMs) out.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch (e) { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CANDIDATES);
}

function readTail(file, size) {
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (size > len) lines.shift(); // first line is cut mid-record
  const recs = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && typeof r === 'object') recs.push(r); } catch (e) { /* garbage line */ }
  }
  return recs;
}

function summarise(recs) {
  let cwd = null, sessionId = null, last = null;
  for (const r of recs) {
    if (r.isSidechain) continue;
    if (typeof r.cwd === 'string') cwd = r.cwd;
    if (typeof r.sessionId === 'string') sessionId = r.sessionId;
    const m = r.message;
    if (r.type === 'assistant' && m && m.usage && shortModel(m.model)) last = r;
  }
  return { cwd, sessionId, last };
}

function readTranscriptLive({ projectsDir = path.join(require('./scan').claudeDir(), 'projects'), cwd, now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  try {
    const want = cwd ? norm(cwd) : null;
    let fallback = null;
    for (const c of listTranscripts(projectsDir, now, maxAgeMs)) {
      let s;
      try { s = summarise(readTail(c.file, c.size)); } catch (e) { continue; }
      if (!s.last) continue;
      if (IGNORED_CWD.some((x) => (s.cwd || '').includes(x))) continue;
      const u = s.last.message.usage;
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const tokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
      const ts = Date.parse(s.last.timestamp);
      const updatedAt = Number.isFinite(ts) ? ts : c.mtime;
      const snap = {
        model: shortModel(s.last.message.model),
        ctxPct: Math.min(100, Math.round((tokens / contextWindow(s.last.message.model, tokens)) * 1000) / 10),
        updatedAt,
        stale: now - updatedAt > STALE_MS,
        sessionId: s.sessionId || path.basename(c.file, '.jsonl'),
        cwd: s.cwd,
        source: 'transcript',
        fiveHour: null,
        sevenDay: null,
      };
      if (!want || (s.cwd && norm(s.cwd) === want)) return snap;
      if (!fallback) fallback = snap;
    }
    return fallback;
  } catch (e) {
    return null;
  }
}

module.exports = { readTranscriptLive, contextWindow };
