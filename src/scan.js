'use strict';

// Reads ~/.claude/projects transcripts and aggregates one calendar month:
// tokens per project (input + output + cache read + cache create, the same
// total Claude Control shows) and the prompts typed that month ("comments").
const fs = require('fs');
const os = require('os');
const path = require('path');

const { titleFrom } = require('./sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_PROMPT_CHARS = 400;
const COLD_MIN_PROMPT = 20000; // smaller prompts are never worth caching
const COLD_MAX_HIT = 0.1; // below this share replayed from cache, a turn is cold
const IDLE_GAP_MS = 5 * 60 * 1000; // the cache lifetime a pause is measured against
const shortModel = (m) => (typeof m === 'string' && !m.startsWith('<') ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '');

// .env files and the KEY=value lines inside them never reach a report.
const ENV_FILE = /(?<![\w])\.env[\w.-]*/i;
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}[ \t]*=[ \t]*\S/m;

const SECRET_PATTERNS = [
  /(?<![\w])\.env[\w.-]*/gi,
  /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}[ \t]*=[ \t]*\S.*$/gm,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\b[A-Za-z0-9+/_-]{40,}\b/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g
];

// A prompt that names a .env file or pastes env-style lines is left out of the report entirely.
function isEnvLeak(text) {
  return ENV_FILE.test(text) || (text.match(new RegExp(ENV_LINE.source, 'gm')) || []).length >= 2;
}

// Redacts every string in a report or overview, however deeply nested.
function scrubDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
}

// One-line session title for the report: redacted, capped, and never an env leak.
function cleanTitle(text) {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return !t || isEnvLeak(t) ? '' : redact(t).slice(0, 120);
}

function redact(text) {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function gitRootOf(cwd) {
  if (!cwd) return '';
  cwd = path.resolve(cwd);
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

// The same name the scan gives a session started in cwd, so "the open project" matches.
function projectNameOf(cwd) {
  return path.resolve(cwd).toLowerCase() === path.resolve(os.homedir()).toLowerCase() ? 'home' : path.basename(gitRootOf(cwd) || cwd);
}

function projectId(root) {
  const location = path.resolve(root);
  return require('node:crypto').createHash('sha256')
    .update(process.platform === 'win32' ? location.toLowerCase() : location).digest('hex');
}

function promptText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((p) => p.type === 'tool_result')) return '';
  return c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function isRealPrompt(t, deep) {
  const automatic = deep ? /^<(?:local-command|command-|task-notification|system-reminder|environment_context|user-prompt-submit-hook)/i.test(t)
    : t.startsWith('<');
  return t && !automatic && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
}

function deepPrompt(text, at, session, source) {
  const sanitized = redact(text);
  let words = 0;
  for (const _word of sanitized.matchAll(/\S+/g)) words++;
  return { at, session, source, words, text: sanitized.trim() };
}

function stripDeepContext(text) {
  return text
    .replace(/<(browser_instruction|ide_opened_file|ide_selection|environment_context|system-reminder)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/^\s*<(browser_instruction|ide_opened_file|ide_selection|environment_context|system-reminder)(?:\s|>)[\s\S]*$/i, '')
    .trim();
}

// Everything in [from, to), local time, grouped by project.
function scanPeriod(from, to, { identifyProjects = false, deep = false } = {}) {
  const projects = new Map();
  const seen = new Set();
  const fromMs = from.getTime();

  for (const file of walk(PROJECTS_DIR, [])) {
    // A file last written before the period began holds nothing from it.
    try { if (fs.statSync(file).mtimeMs < fromMs) continue; } catch { continue; }
    const topDir = path.relative(PROJECTS_DIR, file).split(path.sep)[0];
    if (deep && path.relative(PROJECTS_DIR, file).split(path.sep).includes('subagents')) continue;
    const sessionId = path.basename(file, '.jsonl');
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }

    let cwd = '';
    const heads = { ai: '', custom: '' };
    let first = null;
    let last = null;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0 };
    const prompts = [];
    const interruptions = [];
    const days = {};
    const turnDays = {};
    let entry = '';
    const cache = { cold: 0, rebuilt: 0, afterIdle: 0, starts: 0 };
    let turnNo = 0;
    let prevAt = null;
    const toolNames = {};
    const tools = {};
    const models = {};
    const hoursHist = new Array(24).fill(0);

    for (const line of lines) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.cwd && !cwd) cwd = r.cwd;
      if (r.entrypoint && !entry) entry = r.entrypoint; // cli, claude-vscode, claude-desktop ...
      titleFrom(r, heads); // title lines carry no timestamp
      const d = r.timestamp ? new Date(r.timestamp) : null;
      if (!d || isNaN(d)) continue;
      if (d < from || d >= to) continue;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;

      if (r.type === 'assistant' && r.message && r.message.usage) {
        const id = `${r.message.id || ''}:${r.requestId || ''}`;
        if (id !== ':') {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const u = r.message.usage;
        tokens.input += u.input_tokens || 0;
        tokens.output += u.output_tokens || 0;
        tokens.cacheRead += u.cache_read_input_tokens || 0;
        tokens.cacheCreate += u.cache_creation_input_tokens || 0;
        tokens.turns += 1;
        const dk = dayKey(d);
        turnDays[dk] = (turnDays[dk] || 0) + 1;
        days[dk] = (days[dk] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

        // A turn that replays almost none of its prompt from cache is cold. The
        // first turn of a session is always cold, so it is counted apart.
        const side = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (side >= COLD_MIN_PROMPT && (u.cache_read_input_tokens || 0) < side * COLD_MAX_HIT) {
          if (turnNo === 0) cache.starts += 1;
          else {
            cache.cold += 1;
            cache.rebuilt += u.cache_creation_input_tokens || 0;
            if (d - prevAt > IDLE_GAP_MS) cache.afterIdle += 1;
          }
        }
        turnNo += 1;
        prevAt = d;

        const model = shortModel(r.message.model);
        if (model) models[model] = (models[model] || 0) + side + (u.output_tokens || 0);
        for (const b of Array.isArray(r.message.content) ? r.message.content : []) {
          if (b && b.type === 'tool_use' && b.name) {
            toolNames[b.id] = b.name;
            (tools[b.name] = tools[b.name] || { calls: 0, fails: 0 }).calls += 1;
          }
        }
      } else if (r.type === 'user' && !r.isMeta && !r.isSidechain) {
        for (const b of Array.isArray(r.message && r.message.content) ? r.message.content : []) {
          const name = b && b.type === 'tool_result' && b.is_error ? toolNames[b.tool_use_id] : '';
          if (name && tools[name]) tools[name].fails += 1;
        }
        const raw = promptText(r.message).trim();
        const t = deep ? stripDeepContext(raw) : raw;
        if (identifyProjects && t.startsWith('[Request interrupted')) interruptions.push({ at: d.toISOString(), source: 'claude' });
        if (isRealPrompt(t, deep) && !isEnvLeak(t)) {
          prompts.push(deep ? deepPrompt(t, d.toISOString(), sessionId, 'claude')
            : { at: d.toISOString(), text: redact(t).slice(0, identifyProjects ? 800 : MAX_PROMPT_CHARS) });
          hoursHist[d.getHours()] += 1;
        }
      }
    }
    if (!first) continue;
    if (/claude-report-work/i.test(cwd)) continue; // our own report runs

    const name = cwd ? projectNameOf(cwd) : topDir;
    const root = gitRootOf(cwd);
    const location = root || cwd;
    const id = identifyProjects && location ? projectId(location) : undefined;
    const key = id || name;
    if (!projects.has(key)) {
      projects.set(key, { name, id, location, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0 }, sessions: new Set(), repositories: new Set(), activeMs: 0, titles: [], prompts: [], interruptions: [], daily: {}, dailyTurns: {}, entrypoints: {}, cache: { cold: 0, rebuilt: 0, afterIdle: 0, starts: 0 }, tools: {}, models: {}, hours: new Array(24).fill(0) });
    }
    const p = projects.get(key);
    if (root) p.repositories.add(root);
    for (const k of Object.keys(tokens)) p.tokens[k] += tokens[k];
    p.sessions.add(sessionId);
    const title = deep ? '' : cleanTitle(heads.custom || heads.ai);
    if (title) p.titles.push({ at: last.toISOString(), text: title, source: 'claude' });
    p.activeMs += last - first;
    p.prompts.push(...prompts);
    p.interruptions.push(...interruptions);
    for (const k of Object.keys(days)) p.daily[k] = (p.daily[k] || 0) + days[k];
    for (const k of Object.keys(turnDays)) p.dailyTurns[k] = (p.dailyTurns[k] || 0) + turnDays[k];
    const fileTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    p.entrypoints[entry || 'unknown'] = (p.entrypoints[entry || 'unknown'] || 0) + fileTokens;
    for (const k of Object.keys(cache)) p.cache[k] += cache[k];
    for (const [k, v] of Object.entries(tools)) {
      const t = (p.tools[k] = p.tools[k] || { calls: 0, fails: 0 });
      t.calls += v.calls;
      t.fails += v.fails;
    }
    for (const [k, v] of Object.entries(models)) p.models[k] = (p.models[k] || 0) + v;
    hoursHist.forEach((v, i) => { p.hours[i] += v; });
  }

  return [...projects.values()]
    .map((p) => ({
      name: p.name,
      ...(identifyProjects ? { id: p.id, location: p.location, interruptions: p.interruptions } : {}),
      totalTokens: p.tokens.input + p.tokens.output + p.tokens.cacheRead + p.tokens.cacheCreate,
      tokens: p.tokens,
      sessions: p.sessions.size,
      repositories: [...p.repositories],
      sessionSpanHours: +(p.activeMs / 3600000).toFixed(1),
      promptCount: p.prompts.length,
      titles: p.titles.sort((a, b) => a.at.localeCompare(b.at)),
      daily: p.daily,
      dailyTurns: p.dailyTurns,
      entrypoints: p.entrypoints,
      cache: p.cache,
      tools: p.tools,
      models: p.models,
      hours: p.hours,
      prompts: p.prompts.sort((a, b) => a.at.localeCompare(b.at))
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// month: 'YYYY-MM' in local time.
function scanMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return scanPeriod(new Date(y, m - 1, 1), new Date(y, m, 1));
}

// The last n local days, today included: the Metrics view's rolling window.
function lastDaysRange(n, now = new Date()) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: new Date(to.getFullYear(), to.getMonth(), to.getDate() - n), to };
}

function scanDays(n, now = new Date()) {
  const { from, to } = lastDaysRange(n, now);
  return scanPeriod(from, to);
}

// Every local day from `from` up to but not including `to`, as YYYY-MM-DD.
function dayList(from, to) {
  const out = [];
  for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(dayKey(d));
  return out;
}

module.exports = { scanMonth, scanDays, scanPeriod, lastDaysRange, dayList, dayKey, projectNameOf, projectId, gitRootOf, isEnvLeak, scrubDeep, human, redact, cleanTitle, deepPrompt, stripDeepContext };
