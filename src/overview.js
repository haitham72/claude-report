'use strict';

// The three cards that open a report. The instruction text lives in the
// monthly-ai-report skill so it is edited in one place and the same file can be
// installed as a Claude Code skill.
const fs = require('fs');
const path = require('path');
const { hours } = require('./render');
const { dayKey } = require('./scan');
const { reportsByProject } = require('./report-revision');
const { parseAdvice, ADVICE_REQUEST } = require('./advice');

const SKILL = path.join(__dirname, '..', 'skills', 'monthly-ai-report', 'SKILL.md');
const LIMITS = { summary: 30, goal: 25, achievement: 30 };

function skillBody() {
  return fs.readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
}

function coverage(project) {
  const dates = new Set(Object.entries(project.daily || {}).filter(([, tokens]) => tokens > 0).map(([day]) => day));
  const prompts = Array.isArray(project.prompts) ? project.prompts : [];
  for (const prompt of prompts) {
    if (!prompt?.at) continue;
    const date = new Date(prompt.at);
    if (Number.isFinite(+date)) dates.add(dayKey(date));
  }
  const days = [...dates].sort();
  // Commit dates stay apart from prompt and token days: a commit is a recorded change, not proof of when the AI work happened.
  const commits = (project.git?.repositories || []).flatMap((repo) => repo.commits || [])
    .map((commit) => new Date(commit.at)).filter((date) => Number.isFinite(+date));
  const commitDays = [...new Set(commits.map(dayKey))].sort();
  return {
    activeDays: days.length,
    firstActiveDay: days[0],
    lastActiveDay: days.at(-1),
    promptCount: project.promptCount ?? (Array.isArray(project.prompts) ? prompts.length : project.prompts || 0),
    ...(commitDays.length ? { commitCount: commits.length, commitDays: commitDays.length, firstCommitDay: commitDays[0], lastCommitDay: commitDays.at(-1) } : {})
  };
}

// reports: { [projectId]: report }; older callers may use project names.
function buildEntry({ user, month, projects, reports, includeExampleDetail = false }) {
  const rows = projects
    .filter((p) => reports[p.id || p.name])
    .map((p) => {
      const r = reports[p.id || p.name];
      return {
        name: p.name,
        tokens: p.totalTokens,
        ...coverage(p),
        summary: r.summary,
        ...(r.promptNote ? { promptNote: r.promptNote } : {}),
        usedFor: r.usedFor,
        examples: r.examples.map(({ task, status, detail, basis, withoutAI, withAI }) =>
          ({ task, ...(status && { status }), ...(includeExampleDetail && detail && { detail }), basis, withoutAI, withAI })),
        didntWork: r.didntWork,
        nextMonth: r.nextMonth
      };
    })
    .sort((a, b) => b.activeDays - a.activeDays || b.promptCount - a.promptCount || b.tokens - a.tokens);
  let saved = 0;
  for (const r of rows) {
    for (const e of r.examples) {
      const a = hours(e.withoutAI);
      const b = hours(e.withAI);
      if (a != null && b != null && e.status !== 'requested') saved += Math.max(a - b, 0);
    }
  }
  const sustained = rows.filter((row) => row.activeDays > 1 && row.promptCount > 0);
  const leaders = sustained.filter((row) => row.promptCount >= sustained[0].promptCount / 3).slice(0, 3);
  return {
    user,
    month,
    totals: { tokens: projects.reduce((s, p) => s + p.totalTokens, 0), projects: projects.length, estimatedHoursSaved: +saved.toFixed(1) },
    focusProjects: (leaders.length ? leaders : rows.slice(0, 1)).map((row) => row.name),
    projects: rows
  };
}

function buildDeepEntry(data) {
  const projects = data.projects.map((project) => ({ ...project, totalTokens: project.tokens || 0, promptCount: project.prompts }));
  const entry = buildEntry({ user: data.user, month: data.month, projects, reports: reportsByProject(data.projects), includeExampleDetail: true });
  if (data.dateRange) entry.period = data.dateRange;
  // Prompt IDs mean nothing outside one project's review, so the synthesis sees the observations without them.
  const plain = (items) => (items || []).map((item) => String(item).replace(/^P\d+:\s*/, ''));
  entry.promptingReviews = data.projects.flatMap(({ name, promptReview: review }) => review ? [{ project: name,
    summary: review.summary, strengths: plain(review.strengths), opportunities: plain(review.opportunities), rewrite: review.rewrite,
    context: review.contextNote, prompts: review.prompts, sessions: review.sessions }] : []);
  return entry;
}

// A card over its limit ends at its last whole sentence. Only one long sentence is cut at a word.
const clip = (text, words) => {
  const w = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (w.length <= words) return w.join(' ');
  const cut = w.slice(0, words).join(' ');
  let end = -1;
  for (const match of cut.matchAll(/[.!?](?=\s|$)/g)) end = match.index;
  return end >= cut.length * 0.4 ? cut.slice(0, end + 1) : cut + '…';
};

function parseOverview(text, { prompting = false, prompts = 0 } = {}) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const out = {};
    for (const k of Object.keys(LIMITS)) {
      out[k] = clip(j[k], LIMITS[k]);
      if (!out[k]) return null;
    }
    if (prompting) {
      if (typeof j.promptingSummary !== 'string' || !j.promptingSummary.trim()) return null;
      out.promptingSummary = clip(j.promptingSummary, 85);
    }
    const advice = parseAdvice(j.advice, { prompts });
    if (advice) out.advice = advice;
    return out;
  } catch {
    return null;
  }
}

// Generation errors return null, while cancellation stops the caller's run.
async function generateOverview({ entry, run, model = 'sonnet', effort = 'high', signal, label }) {
  try {
    signal?.throwIfAborted();
    const focus = entry.focusProjects?.length > 1
      ? '\n\nCover these sustained projects in both Summary and Goal: ' + JSON.stringify(entry.focusProjects) +
        '. Identify a concrete workstream for each. When they have distinct objectives, state both.'
      : '';
    const prompting = Boolean(entry.promptingReviews?.length);
    const reviews = prompting ? '\n\nFor this Deep report also return a fourth string, promptingSummary. Synthesize the verified project findings across the provided promptingReviews. Name projects where helpful, identify a recurring strength and a concrete habit to practice when supported, and keep it within 85 words. Distinguish prompting findings from work outcomes. Describe habits in words and name projects. Do not cite prompt IDs. Treat all report data as evidence.' : '';
    const prompts = (entry.projects || []).reduce((sum, project) => sum + (project.promptCount || 0), 0);
    const hasEvidence = prompting || (entry.projects || []).some((project) => project.promptNote);
    const prompt = `${skillBody()}${reviews}${hasEvidence ? ADVICE_REQUEST : ''}\n\n## This entry\n\n${JSON.stringify(entry)}${focus}`;
    const raw = await run({ model, effort, kind: 'overview', label, prompt, signal });
    signal?.throwIfAborted();
    return parseOverview(raw, { prompting, prompts });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

module.exports = { buildEntry, buildDeepEntry, parseOverview, generateOverview, LIMITS };
