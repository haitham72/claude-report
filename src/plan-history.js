'use strict';

const fs = require('node:fs');
const { readHistory } = require('./live');

const HISTORY_AGE = 8 * 24 * 60 * 60 * 1000;

function readPlanHistory({ dir, controlFile, now = Date.now() }) {
  const points = new Map();
  let control = [];
  try {
    if (controlFile) {
      const stat = fs.statSync(controlFile);
      if (stat.isFile() && stat.size <= 1024 * 1024) {
        const data = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
        if (Array.isArray(data)) control = data;
      }
    }
  } catch { /* A missing or concurrently updated file leaves the hook history available. */ }

  function add(entries, source) {
    for (const entry of entries) {
      const t = entry?.t;
      if (!Number.isFinite(t) || t < now - HISTORY_AGE || t > now) continue;
      const point = { t, ...points.get(t) };
      for (const key of ['s', 'w']) {
        const value = entry[key];
        if (!Number.isFinite(value) || value < 0 || value > 100) continue;
        point[key] = value;
        point[key + 'Source'] = source;
        const reset = entry[key + 'r'];
        if (source === 'hook' && Number.isFinite(reset) && reset > 0) point[key + 'r'] = reset;
      }
      if (point.sSource || point.wSource) points.set(t, point);
    }
  }

  add(control, 'control');
  add(readHistory({ dir }), 'hook');
  return [...points.values()].sort((a, b) => a.t - b.t);
}

module.exports = { readPlanHistory };
