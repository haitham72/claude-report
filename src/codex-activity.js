'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectNameOf, projectId, gitRootOf, dayKey, redact, isEnvLeak, deepPrompt, stripDeepContext } = require('./scan');

function emptyProject(name) {
  return {
    name, totalTokens: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0 },
    sessions: 0, repositories: [], promptCount: 0, prompts: [], interruptions: [], daily: {}, dailyTurns: {}, tools: {}, models: {},
    entrypoints: {}, hours: Array(24).fill(0), cache: { cold: 0, rebuilt: 0, afterIdle: 0, starts: 0 }
  };
}

const add = (target, key, count) => { target[key] = (target[key] || 0) + count; };
const addCounts = (target, values = {}) => Object.entries(values).forEach(([field, value]) => add(target, field, value));

function readSessions(dir, after) {
  const out = [];
  function walk(folder) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const item of entries) {
      const name = path.join(folder, item.name);
      if (item.isDirectory()) walk(name);
      else if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name)) {
        try { if (fs.statSync(name).mtimeMs >= after) out.push(name); } catch { /* moved during scan */ }
      }
    }
  }
  walk(dir);
  return out;
}

function userText(payload) {
  if (typeof payload.message === 'string') return payload.message;
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return '';
  const metadata = payload.internal_chat_message_metadata_passthrough;
  return payload.content.map((item, index) => {
    if (item?.type !== 'input_text' || typeof item.text !== 'string') return '';
    const kind = metadata?.content_item_kinds?.[index];
    const provenance = metadata?.content_item_metadata?.[index]?.provenance?.type;
    if ((kind && kind !== 'user.text') || (provenance && provenance !== 'user')) return '';
    const text = item.text.trim();
    return text.startsWith('<environment_context>') || /^# AGENTS\.md instructions for\b/i.test(text) ? '' : text;
  }).filter(Boolean).join('\n');
}

function activityFromSession(file, from, to, names, { identifyProjects, deep }) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  let cwd = '', model = '', turn = '', subagent = false;
  let totals = null;
  const projects = new Map();
  const seenPrompts = new Map();
  const session = path.basename(file, '.jsonl');
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];

  for (const line of raw.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') continue;
    // A subagent session is work an agent delegated. Its tokens are real usage, but its briefs are not the user's prompts.
    if (record.type === 'session_meta' && (payload.source?.subagent || payload.parent_thread_id)) {
      if (deep) return [];
      subagent = true;
    }
    if (record.type === 'session_meta' || record.type === 'turn_context') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.model === 'string') model = payload.model;
    }
    if (record.type === 'turn_context' || (record.type === 'event_msg' && payload.type === 'task_started')) {
      if (typeof payload.turn_id === 'string') turn = payload.turn_id;
    }
    const event = record.type === 'event_msg';
    const response = record.type === 'response_item' && payload.type === 'message' && payload.role === 'user';
    if ((!event && !response) || !cwd) continue;
    const at = new Date(record.timestamp);
    if (!Number.isFinite(+at) || at >= to) continue;

    let prompt = '';
    let interrupted = false;
    let usage;
    if (payload.type === 'token_count') {
      const cumulative = payload.info?.total_token_usage;
      const last = payload.info?.last_token_usage;
      if (!cumulative || !last) continue;
      // Codex can emit the same cumulative snapshot more than once.
      usage = Object.fromEntries(fields.map((key) => [key, totals
        ? Math.max((cumulative[key] || 0) - (totals[key] || 0), 0)
        : (last[key] || 0)]));
      totals = cumulative;
      if (!fields.some((key) => usage[key] > 0)) continue;
    } else if (response || payload.type === 'user_message') {
      if (at < from || subagent) continue;
      const raw = userText(payload).trim();
      const text = deep ? stripDeepContext(raw) : raw;
      if (!text || text.startsWith('<environment_context>') || isEnvLeak(text)) continue;
      const turnId = payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id || turn;
      // Older rollouts can mirror the same user prompt as both an event and a response item.
      if (turnId) {
        const key = JSON.stringify([turnId, text]);
        const source = seenPrompts.get(key);
        if (source && source !== record.type) continue;
        seenPrompts.set(key, record.type);
      }
      prompt = deep ? deepPrompt(text, at.toISOString(), session, 'codex')
        : { at: at.toISOString(), text: redact(text).slice(0, identifyProjects ? 800 : 400), source: 'codex' };
    } else if (identifyProjects && payload.type === 'turn_aborted') {
      interrupted = true;
    } else continue;

    if (at < from) continue;
    if (!names.has(cwd)) {
      const root = gitRootOf(cwd);
      const location = root || cwd;
      names.set(cwd, { name: projectNameOf(cwd), root, location, id: identifyProjects ? projectId(location) : undefined });
    }
    const { name, root, location, id } = names.get(cwd);
    if (!name) continue;
    const key = id || name;
    if (!projects.has(key)) projects.set(key, { ...emptyProject(name), ...(id ? { id, location } : {}) });
    const project = projects.get(key);
    if (!subagent) project.sessions = 1;
    if (root && !project.repositories.includes(root)) project.repositories.push(root);
    const day = dayKey(at);
    if (interrupted) project.interruptions.push({ at: at.toISOString(), source: 'codex' });
    if (prompt) {
      project.prompts.push(prompt);
      project.promptCount++;
      project.hours[at.getHours()]++;
    }
    if (usage) {
      const cacheRead = usage.cached_input_tokens;
      const cacheCreate = usage.cache_write_input_tokens;
      const input = Math.max(usage.input_tokens - cacheRead - cacheCreate, 0);
      const output = usage.output_tokens;
      const tokens = input + output + cacheRead + cacheCreate;
      addCounts(project.tokens, { input, output, cacheRead, cacheCreate, turns: 1 });
      project.totalTokens += tokens;
      add(project.daily, day, tokens);
      add(project.dailyTurns, day, 1);
      if (model) add(project.models, model, tokens);
      add(project.entrypoints, 'codex', tokens);
    }
  }
  return [...projects.values()];
}

function mergeProjects(...sources) {
  const projects = new Map();
  for (const source of sources) {
    for (const p of source) {
      const key = p.id || p.name;
      if (!projects.has(key)) projects.set(key, { ...emptyProject(p.name), ...(p.id ? { id: p.id, location: p.location } : {}) });
      const merged = projects.get(key);
      for (const key of ['totalTokens', 'sessions', 'promptCount']) merged[key] += p[key] || 0;
      for (const key of ['tokens', 'daily', 'dailyTurns', 'models', 'entrypoints', 'cache']) addCounts(merged[key], p[key]);
      for (const [tool, entry] of Object.entries(p.tools || {})) addCounts(merged.tools[tool] ||= { calls: 0, fails: 0 }, entry);
      p.hours?.forEach((count, hour) => { merged.hours[hour] += count; });
      for (const root of (p.repositories || [])) if (!merged.repositories.includes(root)) merged.repositories.push(root);
      for (const prompt of (p.prompts || [])) merged.prompts.push(prompt);
      merged.interruptions.push(...(p.interruptions || []));
    }
  }
  for (const p of projects.values()) p.prompts.sort((a, b) => a.at.localeCompare(b.at));
  return [...projects.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function scanCodex(from, to, root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), options = {}) {
  const names = new Map();
  return mergeProjects(readSessions(root, +from).flatMap((file) => activityFromSession(file, from, to, names, options)));
}

module.exports = { scanCodex, mergeProjects };
