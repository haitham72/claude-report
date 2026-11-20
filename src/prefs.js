'use strict';

// Choices made in the sidebar (the local model, for now). They live in one small file instead of VS Code's
// settings: the editor only accepts a setting once it has registered the extension's manifest, which a
// freshly installed version does not always do until the whole app restarts.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

function readPrefs(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writePref(dir, key, value) {
  const prefs = { ...readPrefs(dir), [key]: value };
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'prefs.json'), JSON.stringify(prefs, null, 2) + '\n');
}

module.exports = { readPrefs, writePref };
