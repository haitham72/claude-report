'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomic } = require('./atomic');
const { tokens, outputBudget, projectPlan, auditProject } = require('./deep-review');

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_FILES = 6;

function reviewCache(home, scope) {
  const dir = path.join(home, 'deep-review-cache');
  const file = (project, level) => path.join(dir, digest([6, scope, project, level]) + '.json');
  return {
    get(project, level, hash) {
      try {
        const entry = JSON.parse(fs.readFileSync(file(project, level), 'utf8'));
        return entry.hash === hash ? entry.value : undefined;
      } catch { return undefined; }
    },
    put(project, level, hash, value) {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(file(project, level), JSON.stringify({ hash, checkedAt: new Date().toISOString(), value }, null, 2));
    }
  };
}

function recentFiles(review) {
  const unique = new Map();
  for (const change of [...(review.git.changes || [])].sort((a, b) => b.at.localeCompare(a.at))) {
    const at = change.ref === 'staged' || change.ref === 'working tree' ? change.at.slice(0, 10) : change.at;
    if (!unique.has(change.file)) unique.set(change.file, { file: change.file, at, ref: change.ref });
  }
  const prompts = review.rows.map((row) => row.text.toLowerCase());
  return [...unique.values()].map((entry) => {
    const fullName = entry.file.toLowerCase();
    const basename = fullName.split('/').at(-1);
    const mentions = prompts.filter((text) => text.includes(fullName) || text.includes(basename)).length;
    return { ...entry, mentions };
  }).sort((a, b) => b.mentions - a.mentions).slice(0, 24);
}

function selectInlineFiles(review) {
  return recentFiles(review).slice(0, MAX_FILES).map(({ file }) => file);
}

function planProjectReview({ review, level, inline = {}, budget, context, cache }) {
  let evidence, details = {};
  const fingerprints = [];
  if (level !== 'low') {
    const diffs = level === 'high' ? (inline.changes || []) : [];
    const limit = Math.min(Math.floor(budget * 0.36), Math.max(700, Math.floor(tokens(review.rows) * 0.5)));
    const baseLimit = diffs.length ? Math.floor(limit * 0.62) : limit;
    const files = recentFiles(review).map(({ mentions, ...file }) => file);
    const documents = (review.git.context || []).map(({ file, text }) => ({ file, text }));
    const changedLines = [];
    const missingGit = (review.git.missing || 0) + (inline.missing || 0);
    const authorUnknown = Boolean(review.git.authorUnknown || inline.authorUnknown);
    evidence = { files, documents, changedLines, missingGit, authorUnknown };
    while (tokens(evidence) > baseLimit && files.length > MAX_FILES) files.pop();
    while (tokens(evidence) > baseLimit && documents.length) {
      const doc = documents.at(-1);
      const excerpt = doc.text.split(/\s+/).slice(0, 75).join(' ');
      if (excerpt !== doc.text) doc.text = excerpt;
      else documents.pop();
    }
    while (tokens(evidence) > baseLimit && files.length) files.pop();

    const ranges = new Map();
    const orderedDiffs = [...diffs].sort((a, b) => b.at.localeCompare(a.at));
    for (const { file } of files) {
      const changes = orderedDiffs.filter((change) => change.file === file)
        .flatMap(({ ref, hunks }) => (hunks || []).filter((hunk) => hunk.lines)
          .map((hunk) => ({ file, ref, range: hunk.range, lines: hunk.lines, fingerprint: hunk.digest, excerpt: Boolean(hunk.excerpt) }))).slice(0, 3);
      for (const { fingerprint, ...change } of changes) {
        const available = limit - tokens(evidence);
        if (available <= 40) break;
        const header = { ...change, lines: '' };
        const cap = Math.max(0, (available - tokens(header) - 2) * 3);
        if (!cap) continue;
        const lines = change.lines.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '');
        const excerpt = { ...change, lines, excerpt: change.excerpt || lines.length < change.lines.length };
        if (!lines || tokens({ ...evidence, changedLines: [...changedLines, excerpt] }) > limit) continue;
        changedLines.push(excerpt);
        fingerprints.push(fingerprint);
        if (!ranges.has(file)) ranges.set(file, new Set());
        ranges.get(file).add(change.range);
      }
    }
    details = { files: files.length, diffExcerpts: changedLines.length, contextFiles: documents.map(({ file }) => file),
      changedFiles: files.map(({ file }) => ({ file, ranges: [...(ranges.get(file) || [])] })), missingGit, authorUnknown };
  }

  const plan = projectPlan(review, budget, level, evidence);
  const hash = digest([plan.payload, plan.chunks, fingerprints, outputBudget(context)]);
  return { plan, details, hash, cached: cache.get(review.id, level, hash) };
}

async function runProjectReview({ review, level, prepared, run, model, budget, context, cache, signal, onDetail = () => {} }) {
  signal?.throwIfAborted();
  const { plan, details, hash, cached } = prepared;
  if (cached) {
    onDetail('Reusing the review for unchanged evidence');
    return { ...cached, reused: true };
  }
  const result = { ...await auditProject({ review, level, plan, run, model, budget, context, signal, onDetail }), ...details };
  signal?.throwIfAborted();
  try { cache.put(review.id, level, hash, result); } catch { /* The rendered review can still be saved. */ }
  return result;
}

module.exports = { reviewCache, selectInlineFiles, planProjectReview, runProjectReview };
