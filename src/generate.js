'use strict';

// Turns scanned prompts into the per-project report shape render.js consumes,
// by asking the selected model through an injected `run` function.
const fs = require('fs');
const path = require('path');
const { scrubDeep } = require('./scan');
const { summarizeGit } = require('./git-evidence');

const LIMITS = { summaryWords: 35, taskWords: 24, detailWords: 52, basisWords: 28, usedFor: 8, didntWork: 5, nextMonth: 4, examples: 8, itemWords: 32, promptNoteWords: 24 };

const SHAPE = '{"project": string, "summary": string, "usedFor": [string], "examples": [{"task": string, "status": "requested" | "recorded" | "verified", "detail": string, "basis": string}], "didntWork": [string], "nextMonth": [string], "promptNote": string}';

function limitsText() {
  return `Limits (hard): summary at most ${LIMITS.summaryWords} words; each example task at most ${LIMITS.taskWords} words; each detail at most ${LIMITS.detailWords} words; each basis at most ${LIMITS.basisWords} words; usedFor at most ${LIMITS.usedFor} items; examples at most ${LIMITS.examples}; didntWork at most ${LIMITS.didntWork} items; nextMonth at most ${LIMITS.nextMonth} items; every usedFor, didntWork and nextMonth item at most ${LIMITS.itemWords} words; promptNote at most ${LIMITS.promptNoteWords} words.`;
}

const STATUSES = ['requested', 'recorded', 'verified'];
const countWords = (text) => typeof text === 'string' ? (text.match(/\S+/g) || []).length : 0;

function expandedProjectWords(report) {
  return [...(report?.usedFor || []), ...(report?.didntWork || []), ...(report?.nextMonth || []),
    ...(report?.examples || []).flatMap(({ task, detail, basis }) => [task, detail, basis])]
    .reduce((total, text) => total + countWords(text), 0);
}

function detailTarget(slice, previousWords) {
  const evidence = [...slice.prompts.map(({ text }) => text), ...(slice.git?.commits || []).map(({ subject }) => subject)];
  const words = evidence.reduce((total, text) => total + countWords(text), 0);
  if (words < 200) return 0;
  const target = previousWords ? Math.round(previousWords * 1.7) : Math.max(180, Math.round(words * 0.55));
  return Math.min(520, Math.round(words * 0.8), target);
}

function sliceProject(project, { maxPrompts = 60, maxChars = Infinity } = {}) {
  const kept = (project.prompts || []).filter((p) => p && typeof p.text === 'string' && p.text.trim().length >= 5)
    .slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let picked = kept;
  if (kept.length > maxPrompts) {
    // Even sampling keeps the whole month represented, in order.
    picked = [];
    const step = kept.length / maxPrompts;
    for (let i = 0; i < maxPrompts; i++) picked.push(kept[Math.floor(i * step)]);
  }
  const interruptions = (project.interruptions || []).filter((item) => typeof item.at === 'string')
    .slice().sort((a, b) => a.at.localeCompare(b.at));
  const sampledInterruptions = interruptions.length > 8
    ? Array.from({ length: 8 }, (_, i) => interruptions[Math.round(i * (interruptions.length - 1) / 7)])
    : interruptions;
  // Titles are cheap context, newest first, and trimmed before prompts: at most 30, within 15% of the budget.
  let seen = 0;
  const titles = (project.titles || []).filter((t) => t && typeof t.text === 'string' && t.text && typeof t.at === 'string')
    .slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).filter((t) => (seen += t.text.length + 16) <= maxChars * 0.15)
    .map((t) => `${t.at.slice(0, 10)} ${t.text}`);
  const titleChars = titles.reduce((n, t) => n + t.length + 4, 0);
  return {
    project: project.name,
    git: summarizeGit(project.git),
    totalTokens: project.totalTokens,
    sessions: project.sessions,
    ...(sampledInterruptions.length ? { interruptions: sampledInterruptions } : {}),
    ...(titles.length ? { titles } : {}),
    prompts: picked.map((p) => ({
      at: p.at, text: p.text.slice(0, Math.floor((maxChars - titleChars) / Math.max(1, picked.length))), source: p.source || 'claude'
    }))
  };
}

// The instructions live in the project-ai-report skill, so they are edited in one place
// and the same file can be installed as a Claude Code skill.
function skillBody(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
}

function buildProjectPrompt(slice, { estimateTime = false, previousWords, draft } = {}) {
  const target = detailTarget(slice, previousWords);
  const coverage = target
    ? `Aim for about ${target} words across usedFor, examples, didntWork and nextMonth when the evidence supports them. Put most of the detail in the examples. For substantial examples, write 30 to 50 words in detail alone. Name what changed or was requested, why it mattered, and what was verified or left open. Keep the summary brief.`
    : 'Keep the summary brief. Include every distinct example and detail supported by the available evidence.';
  const timing = estimateTime ? [
    'Time estimates are enabled. For each concrete example, also return withoutAIMinutes and withAIMinutes.',
    'Estimate the effort for the same task scope with and without AI in whole minutes. Include work the person still had to do, including review or rework when evident.',
    'Use approximate, conservative values. Set both fields to null if the task is too vague to estimate, and for any example whose status is requested, because no completed work is recorded for it. These are estimates, so never present them as observed time.'
  ].join(' ') : 'Leave time and savings out of the report.';
  const context = slice.titles ? 'The titles list is one line per session, for orientation only. It is not evidence of work done and never a source to quote.' : '';
  const prompt = [skillBody('project-ai-report'), coverage, ...(context ? [context] : []), limitsText(), timing, '', '## This project', JSON.stringify(slice)];
  if (draft) prompt.push('', '## Revise the first draft',
    `The draft has ${expandedProjectWords(draft)} expanded words. Return the full report with about ${target} supported expanded words. Preserve the distinct examples and their sources. Add omitted requirements, decisions, corrections, tests and open questions. For each substantial example, write a detail paragraph of at least two complete sentences. Use facts from the project evidence above.`,
    JSON.stringify(draft));
  return prompt.join('\n');
}

function buildFinalPrompt(reports) {
  return [
    'Tighten the wording of these project reports to the limits below.',
    'Keep every fact and number. Do not add anything. Keep the same JSON shape and the same project names.',
    'Reply with ONLY a JSON array of reports, no code fences, no commentary. Each report has this shape:',
    SHAPE,
    limitsText(),
    '',
    'Reports:',
    JSON.stringify(reports)
  ].join('\n');
}

// First balanced {...} or [...] in text that parses as JSON.
function extractJson(text, open) {
  const close = open === '{' ? '}' : ']';
  const s = String(text || '');
  for (let start = s.indexOf(open); start !== -1; start = s.indexOf(open, start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function clip(value, maxWords) {
  const s = typeof value === 'string' ? value.trim() : '';
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(' ') + '…' : s;
}

function list(value, max, words) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => clip(v, words)).filter(Boolean).slice(0, max);
}

function estimateLabel(minutes) {
  if (minutes % 480 === 0) return `~${minutes / 480} ${minutes === 480 ? 'day' : 'days'}`;
  return minutes % 60 === 0 ? `~${minutes / 60} h` : `~${minutes} min`;
}

function exampleTime(example, estimateTime) {
  // A request with no recorded result has no completed work to compare, so it carries no saved time.
  if (example.status === 'requested') return { withoutAI: '', withAI: '' };
  const values = [example.withoutAIMinutes, example.withAIMinutes];
  if (estimateTime && values.every((minutes) => Number.isSafeInteger(minutes) && minutes > 0)) {
    return { withoutAI: estimateLabel(values[0]), withAI: estimateLabel(values[1]), timeSource: 'estimated' };
  }
  return { withoutAI: '', withAI: '' };
}

function normalise(obj, projectName, { allowEmpty = false, estimateTime = false } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const summary = clip(obj.summary, LIMITS.summaryWords);
  const examples = (Array.isArray(obj.examples) ? obj.examples : [])
    .filter((e) => e && typeof e === 'object' && typeof e.task === 'string' && e.task.trim())
    .slice(0, LIMITS.examples)
    .map((e) => {
      const detail = clip(e.detail, LIMITS.detailWords);
      const status = STATUSES.includes(e.status) ? e.status : undefined;
      return { task: clip(e.task, LIMITS.taskWords), ...(status ? { status } : {}), ...exampleTime(e, estimateTime),
        ...(detail ? { detail } : {}), basis: clip(e.basis, LIMITS.basisWords) };
    });
  if (!summary || (!allowEmpty && !examples.length)) return null;
  const promptNote = clip(obj.promptNote, LIMITS.promptNoteWords);
  return {
    project: projectName,
    summary,
    usedFor: list(obj.usedFor, LIMITS.usedFor, LIMITS.itemWords),
    examples,
    didntWork: list(obj.didntWork, LIMITS.didntWork, LIMITS.itemWords),
    nextMonth: list(obj.nextMonth, LIMITS.nextMonth, LIMITS.itemWords),
    ...(promptNote ? { promptNote } : {})
  };
}

function parseReport(text, projectName, options) {
  try {
    return normalise(extractJson(text, '{'), projectName, options);
  } catch {
    return null;
  }
}

// Returns an array of reports (project names kept), or null if nothing usable.
function parseReportList(text, options) {
  try {
    const arr = extractJson(text, '[');
    if (!Array.isArray(arr)) return null;
    const out = arr.map((o) => normalise(o, o && typeof o.project === 'string' ? o.project : '', options));
    if (!out.length || out.some((r) => !r || !r.project)) return null;
    return out;
  } catch {
    return null;
  }
}

async function generateReports({
  projects,
  run,
  models = { project: { model: 'haiku', effort: 'medium' }, finalizer: { model: 'sonnet', effort: 'high' } },
  minPrompts = 1,
  concurrency = 3,
  local = false,
  estimateTime = false,
  localInputChars = 11000,
  localMaxPrompts = 32,
  maxOutputTokens,
  signal,
  onProgress = () => {}
}) {
  const progress = (e) => { try { onProgress(e); } catch { /* a bad listener must not stop the run */ } };
  const todo = projects.filter((p) => (p.prompts || []).length >= minPrompts);
  const results = {};
  const failed = [];
  const failures = [];
  const parseOptions = { allowEmpty: local, estimateTime };
  let next = 0;
  // Every project gets a state up front so a live view can list them all at once.
  projects.forEach((p) => progress({ project: p.name, status: todo.includes(p) ? 'queued' : 'skipped' }));

  async function worker() {
    while (next < todo.length) {
      signal?.throwIfAborted();
      const p = todo[next++];
      const key = p.id || p.name;
      progress({ project: p.name, status: 'gathering' });
      try {
        const summarize = async (slice, draft) => {
          progress({ project: p.name, status: 'working', detail: draft ? 'Expanding project details' : slice.prompts.length + ' evidence prompts' });
          const prompt = buildProjectPrompt(slice, { estimateTime, previousWords: p.previousExpandedWords, draft });
          const text = await run({ ...models.project, kind: 'project', label: p.name, prompt, estimateTime, maxOutputTokens, signal });
          signal?.throwIfAborted();
          const report = parseReport(text, p.name, parseOptions);
          if (!report) throw new Error('Model returned unusable report JSON');
          return report;
        };
        let slice = sliceProject(p, { maxPrompts: local ? localMaxPrompts : 60, maxChars: local ? localInputChars : 36000 });
        let report, retried = false;
        try {
          report = await summarize(slice);
        } catch (first) {
          signal?.throwIfAborted();
          if (!local || !/JSON|context limit|output token|empty reply/i.test(first.message)) throw first;
          progress({ project: p.name, status: 'working', detail: 'Retrying with a shorter prompt' });
          retried = true;
          slice = sliceProject(p, { maxPrompts: Math.max(1, Math.floor(localMaxPrompts / 2)), maxChars: Math.floor(localInputChars * 0.55) });
          report = await summarize(slice);
        }
        const words = expandedProjectWords(report);
        const target = detailTarget(slice, p.previousExpandedWords);
        if (!retried && words < Math.min(350, target * 0.86)) {
          try {
            const expanded = await summarize(slice, report);
            if (expanded.examples.length >= report.examples.length && expandedProjectWords(expanded) > words) report = expanded;
          } catch { signal?.throwIfAborted(); }
        }
        results[key] = report;
        progress({ project: p.name, status: 'done' });
      } catch (e) {
        signal?.throwIfAborted();
        failed.push(p.name);
        const error = String(scrubDeep(String(e.message || e)) || 'Model request failed').slice(0, 180);
        failures.push({ project: p.name, ...(p.id ? { id: p.id } : {}), error });
        progress({ project: p.name, status: 'failed', error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  signal?.throwIfAborted();

  let usedFinalizer = false;
  const keys = Object.keys(results);
  const keysByName = new Map(keys.map((key) => [results[key].project, key]));
  if (keys.length && models.finalizer && !estimateTime) {
    progress({ stage: 'finalizing' });
    try {
      const text = await run({ ...models.finalizer, kind: 'finalizer', prompt: buildFinalPrompt(Object.values(results)), signal });
      signal?.throwIfAborted();
      const tightened = parseReportList(text, parseOptions);
      const same = tightened && tightened.length === keys.length && new Set(tightened.map((r) => r.project)).size === keys.length &&
        tightened.every((r) => keysByName.has(r.project));
      if (same) {
        for (const r of tightened) results[keysByName.get(r.project)] = r;
        usedFinalizer = true;
      }
    } catch { signal?.throwIfAborted(); }
  }

  return { reports: results, failed, failures, usedFinalizer };
}

module.exports = { LIMITS, sliceProject, buildProjectPrompt, buildFinalPrompt, parseReport, parseReportList, generateReports, expandedProjectWords,
  parseJsonObject: (text) => extractJson(text, '{') };
