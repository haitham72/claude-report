'use strict';

// Lists Claude Code sessions like the extension's Session Manager, from local
// files only: transcripts for titles/prompts, the pid registry for liveness.
// Only the head and tail of each transcript are read, never a whole file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 96 * 1024;
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const IGNORED_CWD = ['claude-report-work', 'ide-companio-work'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (id) => typeof id === 'string' && UUID_RE.test(id);

function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

function defaultProjectName(cwd) {
  try { return require('./scan').projectNameOf(cwd); } catch { return String(cwd || ''); }
}

function readRange(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.toString('utf8', 0, n);
}

function parse(line) {
  if (!line || line[0] !== '{') return null;
  try { return JSON.parse(line); } catch { return null; }
}

function promptText(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isSidechain) return '';
  const c = rec.message && rec.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((p) => p && p.type === 'tool_result')) return '';
    text = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ');
  }
  text = text.trim();
  return text && !text.startsWith('<') && !text.startsWith('Caveat:') ? text : '';
}

function readHead(fd, size) {
  const len = Math.min(size, HEAD_BYTES);
  let lines = readRange(fd, 0, len).split('\n');
  // A cut-off last line would be junk; keep it only when the file ended there.
  if (size > len) lines.pop();
  const out = { cwd: '', entrypoint: '', prompt: '', ai: '', custom: '' };
  for (const line of lines) {
    const r = parse(line);
    if (!r) continue;
    if (!out.cwd && typeof r.cwd === 'string') out.cwd = r.cwd;
    if (!out.entrypoint && typeof r.entrypoint === 'string') out.entrypoint = r.entrypoint;
    if (!out.prompt) out.prompt = promptText(r);
    titleFrom(r, out);
  }
  return out;
}

function titleFrom(r, out) {
  if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) out.ai = r.aiTitle.trim();
  else if (r.type === 'custom-title') {
    const t = r.customTitle || r.title;
    if (typeof t === 'string' && t.trim()) out.custom = t.trim();
  }
}

function readTail(fd, size) {
  const out = { ai: '', custom: '' };
  const len = Math.min(size, TAIL_BYTES);
  const lines = readRange(fd, size - len, len).split('\n');
  if (size > len) lines.shift();
  for (const line of lines) {
    const r = parse(line);
    if (r) titleFrom(r, out);
  }
  return out;
}

function clip(s, n) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
}

function readRegistry(dir, isAlive) {
  const live = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return live; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!r || typeof r.sessionId !== 'string' || !Number.isInteger(r.pid)) continue;
      if (isAlive(r.pid)) live.set(r.sessionId, r);
    } catch { /* corrupt entry */ }
  }
  return live;
}

function listSessions(opts) {
  try {
    const o = opts || {};
    const home = os.homedir();
    const projectsDir = o.projectsDir || path.join(home, '.claude', 'projects');
    const registryDir = o.registryDir || path.join(home, '.claude', 'sessions');
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const limit = typeof o.limit === 'number' ? o.limit : 60;
    const isAlive = o.isAlive || defaultAlive;
    const projectName = o.projectName || defaultProjectName;
    const live = readRegistry(registryDir, isAlive);

    const files = [];
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      let names = [];
      try { names = fs.readdirSync(path.join(projectsDir, d.name)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(projectsDir, d.name, n);
        try {
          const st = fs.statSync(file);
          if (st.isFile()) files.push({ file, id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size });
        } catch { /* vanished */ }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const picked = files.filter((f, i) => i < limit || live.has(f.id));

    const out = [];
    for (const f of picked) {
      const reg = live.get(f.id);
      if (!reg && now - f.mtime > MAX_AGE_MS) continue;
      let fd;
      try {
        fd = fs.openSync(f.file, 'r');
        const head = readHead(fd, f.size);
        const tail = f.size > HEAD_BYTES ? readTail(fd, f.size) : { ai: '', custom: '' };
        const cwd = head.cwd || (reg && reg.cwd) || '';
        if (IGNORED_CWD.some((w) => cwd.includes(w))) continue;
        const custom = tail.custom || head.custom;
        const ai = tail.ai || head.ai;
        if (!head.prompt && !custom && !ai) continue;
        const title = custom || ai || (head.prompt ? clip(head.prompt, 70) : 'Untitled session');
        const active = !!reg;
        out.push({
          id: f.id,
          title,
          cwd,
          project: projectName(cwd),
          updatedAt: active && typeof reg.updatedAt === 'number' ? Math.max(f.mtime, reg.updatedAt) : f.mtime,
          active,
          status: active ? (reg.status === 'busy' ? 'busy' : 'idle') : '',
          entrypoint: head.entrypoint || (reg && reg.entrypoint) || '',
        });
      } catch { /* skip unreadable file */ } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    out.sort((a, b) => (b.active - a.active) || (b.updatedAt - a.updatedAt));
    return out;
  } catch {
    return [];
  }
}

function ageLabel(updatedAt, now) {
  const s = Math.max(0, ((now === undefined ? Date.now() : now) - updatedAt) / 1000);
  if (s < 90) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 14) return d + 'd';
  return Math.floor(d / 7) + 'w';
}

function groupOf(session, now) {
  if (session.active) return 'Active';
  const n = new Date(now === undefined ? Date.now() : now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (session.updatedAt >= today) return 'Today';
  if (session.updatedAt >= yesterday) return 'Yesterday';
  return 'Earlier';
}

module.exports = { listSessions, ageLabel, groupOf, isUuid };
