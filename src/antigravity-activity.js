'use strict';

// Antigravity (Google's agent IDE) activity, read from its local conversation index.
// Tokens are not exposed in a readable form, so they stay 0: this source contributes sessions,
// prompts, turns and hours only. Never writes to the store.
//
// Design:
//  - session   = one non-subagent conversation with activity in [from, to)
//  - turns     = step_count of a conversation whose last_modified_time is in the window
//                (the index keeps no per-step times, so the whole count lands on the last-modified day)
//  - prompt    = at most ONE per conversation: the latest user message, which is the only one with a
//                known time (last_user_input_time). Text comes from the FTS user_body column, sliced
//                with user_step_byte_offsets; falls back to the conversation preview/title.
//  - subagents = (parent_conversation_id set or nesting_depth > 0) count turns, never prompts/sessions.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { projectNameOf, projectId, gitRootOf, dayKey, redact, isEnvLeak, deepPrompt, stripDeepContext } = require('./scan');
const { emptyProject } = require('./codex-activity');
const { querySqlite, sqliteAvailable } = require('./sqlite-read');

const add = (target, key, count) => { target[key] = (target[key] || 0) + count; };

// '2026-11-23 06:00:05.8335062+00:00' -> Date (fraction trimmed to ms; some engines reject 7 digits).
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const zone = m[4] ? (m[4] === 'Z' ? 'Z' : m[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z';
  const date = new Date(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}${zone}`);
  return Number.isFinite(+date) ? date : null;
}

function workspacePath(json) {
  let uris;
  try { uris = JSON.parse(json); } catch { return ''; }
  const first = Array.isArray(uris) ? uris.find((u) => typeof u === 'string' && u.startsWith('file:')) : '';
  if (!first) return '';
  try { return fileURLToPath(first); } catch { return ''; }
}

// The user message at the last user step: slice user_body by the chunk's [step, byteOffset] pairs.
function latestUserText(chunks, stepIndex) {
  let best = null;
  for (const chunk of chunks) {
    let offsets;
    try { offsets = JSON.parse(chunk.offsets); } catch { continue; }
    if (!Array.isArray(offsets) || typeof chunk.body !== 'string') continue;
    const body = Buffer.from(chunk.body, 'utf8');
    offsets.forEach((pair, i) => {
      if (!Array.isArray(pair) || !Number.isInteger(pair[0]) || !Number.isInteger(pair[1])) return;
      if (stepIndex >= 0 && pair[0] > stepIndex) return;
      if (best && pair[0] < best.step) return;
      const next = offsets[i + 1];
      const end = Array.isArray(next) && Number.isInteger(next[1]) ? next[1] : body.length;
      best = { step: pair[0], text: body.subarray(pair[1], Math.max(end, pair[1])).toString('utf8').trim() };
    });
  }
  return best ? best.text : '';
}

function scanAntigravity(from, to, root = path.join(process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini', 'antigravity')), options = {}) {
  const { identifyProjects = false, deep = false } = options;
  const file = path.join(root, 'conversation_summaries.db');
  let rows, chunks;
  try {
    if (!fs.existsSync(file) || !sqliteAvailable()) return [];
    rows = querySqlite(file,
      'SELECT conversation_id, preview, title, step_count, last_modified_time, last_user_input_time, last_user_input_step_index, ' +
      'workspace_uris, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries');
    try {
      chunks = querySqlite(file,
        'SELECT conversation_id, user_body AS body, CAST(user_step_byte_offsets AS TEXT) AS offsets FROM conversations_fts WHERE chunk_index >= 0 ORDER BY conversation_id, chunk_index');
    } catch { chunks = []; }
  } catch { return []; }

  const byConversation = new Map();
  for (const c of chunks) {
    if (!byConversation.has(c.conversation_id)) byConversation.set(c.conversation_id, []);
    byConversation.get(c.conversation_id).push(c);
  }

  const names = new Map();
  const projects = new Map();
  for (const row of rows) {
    try {
      const subagent = !!row.parent_conversation_id || (row.nesting_depth || 0) > 0;
      if (deep && subagent) continue;
      const modified = parseTime(row.last_modified_time);
      const userAt = parseTime(row.last_user_input_time);
      const modifiedIn = modified && modified >= from && modified < to;
      const userIn = userAt && userAt >= from && userAt < to;
      if (!modifiedIn && !userIn) continue;
      const cwd = workspacePath(row.workspace_uris);
      if (!cwd) continue;
      if (!names.has(cwd)) {
        const gitRoot = gitRootOf(cwd);
        const location = gitRoot || cwd;
        names.set(cwd, { name: projectNameOf(cwd), root: gitRoot, id: identifyProjects ? projectId(location) : undefined, location });
      }
      const { name, root: gitRoot, id, location } = names.get(cwd);
      if (!name) continue;
      const key = id || name;
      if (!projects.has(key)) projects.set(key, { ...emptyProject(name), ...(id ? { id, location } : {}) });
      const project = projects.get(key);
      if (gitRoot && !project.repositories.includes(gitRoot)) project.repositories.push(gitRoot);
      const model = row.agent_name || 'antigravity';

      if (modifiedIn) {
        const turns = Math.max(Number(row.step_count) || 0, 0);
        project.tokens.turns += turns;
        add(project.dailyTurns, dayKey(modified), turns);
        add(project.daily, dayKey(modified), 0);
        add(project.models, model, 0);
        add(project.entrypoints, 'antigravity', 0);
      }
      if (subagent) continue;
      project.sessions++;
      if (!userIn) continue;
      const raw = (latestUserText(byConversation.get(row.conversation_id) || [], Number(row.last_user_input_step_index)) ||
        row.preview || row.title || '').trim();
      const text = deep ? stripDeepContext(raw) : raw;
      if (!text || isEnvLeak(text)) continue;
      project.prompts.push(deep ? deepPrompt(text, userAt.toISOString(), row.conversation_id, 'antigravity')
        : { at: userAt.toISOString(), text: redact(text).slice(0, identifyProjects ? 800 : 400), source: 'antigravity' });
      project.promptCount++;
      project.hours[userAt.getHours()]++;
    } catch { /* one malformed row never sinks the scan */ }
  }
  return [...projects.values()].sort((a, b) => b.tokens.turns - a.tokens.turns);
}

module.exports = { scanAntigravity };
