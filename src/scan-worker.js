'use strict';

const { parentPort, workerData } = require('worker_threads');
const { scanPeriod, lastDaysRange } = require('./scan');
const { scanCodex, mergeProjects } = require('./codex-activity');
const { scanAntigravity } = require('./antigravity-activity');
const { scanCursor } = require('./cursor-activity');
const { reportBounds } = require('./report-window');

function scanActivity({ month, days, cutoff, deep, dateRange }) {
  const { from, to } = days ? lastDaysRange(days) : reportBounds(month, dateRange, cutoff);
  const options = { identifyProjects: Boolean(month), deep };
  const claude = scanPeriod(from, to, options);
  // Each extra source is optional: a missing store or runtime yields [] and no tab.
  const extra = {
    codex: scanCodex(from, to, undefined, options),
    antigravity: scanAntigravity(from, to, undefined, options),
    cursor: scanCursor(from, to, undefined, options)
  };
  const present = Object.fromEntries(Object.entries(extra).filter(([, projects]) => projects.length));
  const others = Object.values(present);
  return {
    month, days, projects: others.length ? mergeProjects(claude, ...others) : claude,
    sources: { claude, ...present }
  };
}

const result = workerData.git
  ? require('./git-evidence').collectGit(workerData.git, workerData.month, workerData.cutoff, undefined, workerData.dateRange)
  : workerData.deepGit ? require('./deep-git').collectDeepGit(workerData.deepGit, workerData.month, workerData.cutoff, workerData.effort, workerData.dateRange)
    : scanActivity(workerData);
parentPort.postMessage(result);
