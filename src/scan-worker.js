'use strict';

const { parentPort, workerData } = require('worker_threads');
const { scanPeriod, lastDaysRange } = require('./scan');
const { scanCodex, mergeProjects } = require('./codex-activity');
const { reportBounds } = require('./report-window');

function scanActivity({ month, days, cutoff, deep, dateRange }) {
  const { from, to } = days ? lastDaysRange(days) : reportBounds(month, dateRange, cutoff);
  const options = { identifyProjects: Boolean(month), deep };
  const claude = scanPeriod(from, to, options);
  const codex = scanCodex(from, to, undefined, options);
  return {
    month, days, projects: codex.length ? mergeProjects(claude, codex) : claude,
    sources: { claude, ...(codex.length ? { codex } : {}) }
  };
}

const result = workerData.git
  ? require('./git-evidence').collectGit(workerData.git, workerData.month, workerData.cutoff, undefined, workerData.dateRange)
  : workerData.deepGit ? require('./deep-git').collectDeepGit(workerData.deepGit, workerData.month, workerData.cutoff, workerData.effort, workerData.dateRange)
    : scanActivity(workerData);
parentPort.postMessage(result);
