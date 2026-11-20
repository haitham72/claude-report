'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPrefs, writePref } = require('../src/prefs');

test('a choice is saved, read back, and never wipes the others', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pref-')), 'nested');
  assert.deepStrictEqual(readPrefs(dir), {});
  writePref(dir, 'local.engine', 'ollama');
  writePref(dir, 'local.enabled', true);
  assert.deepStrictEqual(readPrefs(dir), { 'local.engine': 'ollama', 'local.enabled': true });
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('a damaged file reads as empty and is replaced on the next write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pref-'));
  fs.writeFileSync(path.join(dir, 'prefs.json'), '{not json');
  assert.deepStrictEqual(readPrefs(dir), {});
  writePref(dir, 'a', 1);
  assert.deepStrictEqual(readPrefs(dir), { a: 1 });
});
