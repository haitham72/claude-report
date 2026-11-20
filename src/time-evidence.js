'use strict';

const key = (value) => value.trim().toLowerCase();

function applyTimeEvidence(reports, evidence) {
  for (const [name, report] of Object.entries(reports)) {
    const entries = Array.isArray(evidence?.[name]) ? evidence[name] : [];
    if (!entries.length) continue;
    const tasks = new Set();
    const recorded = [];
    for (const entry of entries) {
      if (typeof entry.task !== 'string' || !Number.isFinite(entry.spent)) continue;
      tasks.add(key(entry.task));
      recorded.push({
        task: entry.task,
        withAI: entry.spent + ' h',
        withoutAI: Number.isFinite(entry.baseline) ? entry.baseline + ' h' : '',
        basis: 'Time supplied by you',
        timeSource: 'reported'
      });
    }
    report.examples = [...recorded, ...report.examples.filter((item) => !tasks.has(key(item.task)))];
  }
}

module.exports = { applyTimeEvidence };
