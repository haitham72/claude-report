'use strict';

// The sidebar page: a shell (header, tabs, Report and Connect pages) with the
// Metrics tab port inlined. It runs inside a VS Code webview and talks to the
// extension by messages, so it can also be opened in a browser against a fake host.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'template', 'panel');

function buildPanelHtml() {
  const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
  return read('shell.html')
    .replace('/*__METRICS_CSS__*/', () => read('metrics.css'))
    .replace('/*__METRICS_JS__*/', () => read('metrics.js'));
}

// The data contract of template/panel/metrics.js.
function buildMetricsData({ projects, days, live = null, history = [], openProject = null, showUsageTrend = true }) {
  return {
    openProject,
    days,
    windowDays: days.length,
    live,
    history,
    showUsageTrend,
    projects: projects.map((p) => ({
      name: p.name,
      tokens: p.totalTokens,
      sessions: p.sessions,
      prompts: p.promptCount,
      t: p.tokens,
      daily: p.daily,
      dailyTurns: p.dailyTurns,
      tools: p.tools,
      models: p.models,
      hours: p.hours,
      cache: p.cache
    }))
  };
}

module.exports = { buildPanelHtml, buildMetricsData };
