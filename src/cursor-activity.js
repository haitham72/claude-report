'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectNameOf, projectId, gitRootOf, dayKey, redact, cleanTitle, isEnvLeak, deepPrompt, stripDeepContext } = require('./scan');
const { mergeProjects, emptyProject } = require('./codex-activity');
const { querySqlite, sqliteAvailable } = require('./sqlite-read');

function defaultFile() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config');
  return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

const add = (target, key, count) => { target[key] = (target[key] || 0) + count; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// file:///g%3A/x, /g:/x or g:\x -> a native path. Remote schemes are not local folders.
function uriToPath(value) {
  if (typeof value !== 'string' || !value) return '';
  let p = value;
  if (/^file:/i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch { return ''; }
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return '';
  if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
  return p ? path.normalize(p) : '';
}

function parseList(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

const J = (p) => `json_extract(CAST(value AS TEXT),'${p}')`;

function composerRows(file, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = querySqlite(file,
      `SELECT key, ${J('$.workspaceIdentifier.uri.fsPath')} fs, ${J('$.workspaceIdentifier.uri.external')} ext, ` +
      `${J('$.trackedGitRepos[0].repoPath')} repo, ${J('$.modelConfig.modelName')} model, ${J('$.name')} name, ` +
      `${J('$.subagentInfo.parentComposerId')} parent, ${J('$.isBestOfNSubcomposer')} bon, ` +
      `${J('$.subagentComposerIds')} subs, ${J('$.subComposerIds')} subs2 ` +
      `FROM cursorDiskKV WHERE key IN (${chunk.map(() => '?').join(',')})`, chunk.map((id) => `composerData:${id}`));
    for (const r of rows) out.set(String(r.key).slice('composerData:'.length), r);
  }
  return out;
}

function scanCursor(from, to, file = defaultFile(), options = {}) {
  const { identifyProjects, deep } = options;
  try {
    if (!file || !fs.existsSync(file) || !sqliteAvailable()) return [];
    // bubble createdAt is an ISO-8601 UTC string (compares as text) or, in some builds, epoch ms (compares as a number).
    const bubbles = querySqlite(file,
      `SELECT key, ${J('$.type')} t, ${J('$.createdAt')} c, ${J('$.tokenCount.inputTokens')} i, ${J('$.tokenCount.outputTokens')} o, ` +
      `${J('$.workspaceUris[0]')} w, CASE WHEN ${J('$.type')}=1 THEN ${J('$.text')} END txt ` +
      `FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND (` +
      `(json_type(CAST(value AS TEXT),'$.createdAt')='text' AND ${J('$.createdAt')} >= ? AND ${J('$.createdAt')} < ?) OR ` +
      `(json_type(CAST(value AS TEXT),'$.createdAt') IN ('integer','real') AND ${J('$.createdAt')} >= ? AND ${J('$.createdAt')} < ?))`,
      [from.toISOString(), to.toISOString(), from.getTime(), to.getTime()]);
    if (!bubbles.length) return [];

    const byComposer = new Map();
    for (const b of bubbles) {
      const id = String(b.key).split(':')[1];
      if (!id) continue;
      if (!byComposer.has(id)) byComposer.set(id, []);
      byComposer.get(id).push(b);
    }
    const composers = composerRows(file, [...byComposer.keys()]);
    const children = new Set();
    for (const c of composers.values()) {
      for (const id of [...parseList(c.subs), ...parseList(c.subs2)]) if (typeof id === 'string') children.add(id);
    }

    const names = new Map();
    const perSession = [];
    for (const [id, list] of byComposer) {
      const c = composers.get(id) || {};
      // A subagent / best-of-N composer is delegated work: its tokens are real usage, its briefs are not the user's prompts.
      const sub = Boolean(c.parent) || c.bon === 1 || children.has(id);
      if (deep && sub) continue;
      const model = typeof c.model === 'string' ? c.model : '';
      const fallback = list.map((b) => uriToPath(b.w)).find(Boolean);
      const cwd = uriToPath(c.fs) || uriToPath(c.ext) || uriToPath(c.repo) || fallback || '';
      if (!cwd || /claude-report-work|ide-companio-work/i.test(cwd)) continue;
      if (!names.has(cwd)) {
        const root = gitRootOf(cwd);
        const location = root || cwd;
        names.set(cwd, { name: projectNameOf(cwd), root, location, id: identifyProjects ? projectId(location) : undefined });
      }
      const { name, root, location, id: pid } = names.get(cwd);
      if (!name) continue;
      const project = { ...emptyProject(name), ...(pid ? { id: pid, location } : {}) };
      if (root) project.repositories.push(root);
      let active = false;
      let lastAt = null;
      for (const b of list) {
        const at = new Date(b.c);
        if (!Number.isFinite(+at) || at < from || at >= to) continue;
        const day = dayKey(at);
        if (!lastAt || at > lastAt) lastAt = at;
        if (b.t === 1) {
          if (sub) continue;
          const raw = typeof b.txt === 'string' ? b.txt.trim() : '';
          const text = deep ? stripDeepContext(raw).trim() : raw;
          if (!text || isEnvLeak(text)) continue;
          project.prompts.push(deep ? deepPrompt(text, at.toISOString(), id, 'cursor')
            : { at: at.toISOString(), text: redact(text).slice(0, identifyProjects ? 800 : 400), source: 'cursor' });
          project.promptCount++;
          project.hours[at.getHours()]++;
          active = true;
        } else if (b.t === 2) {
          const input = num(b.i), output = num(b.o), tokens = input + output;
          project.tokens.input += input;
          project.tokens.output += output;
          project.tokens.turns++;
          project.totalTokens += tokens;
          add(project.daily, day, tokens);
          add(project.dailyTurns, day, 1);
          if (model) add(project.models, model, tokens);
          add(project.entrypoints, 'cursor', tokens);
          active = true;
        }
      }
      if (!active) continue;
      if (!sub) project.sessions = 1;
      const title = deep || sub ? '' : cleanTitle(c.name);
      if (title) project.titles.push({ at: lastAt.toISOString(), text: title, source: 'cursor' });
      perSession.push(project);
    }
    return mergeProjects(perSession);
  } catch {
    return [];
  }
}

module.exports = { scanCursor };
