'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPlanHistory } = require('../src/plan-history');

test('the local Claude Control history fills gaps and the hook wins matching timestamps', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-history-'));
  const controlFile = path.join(dir, 'control.json');
  const now = 1e12;
  fs.writeFileSync(controlFile, JSON.stringify([
    { t: now + 1, s: 50 }, { t: now - 10 * 86400000, s: 50 }, { t: now - 3, s: 12, sr: 456 },
    { t: now - 2, s: 13, w: 32, other: 'ignored' }, { t: now - 1, s: 103, w: '20' }
  ]));
  fs.writeFileSync(path.join(dir, 'usage-history.json'), JSON.stringify([{ t: now - 2, s: 14, sr: 1e9 + 60 }]));
  const before = fs.readFileSync(controlFile, 'utf8');
  assert.deepEqual(readPlanHistory({ dir, controlFile, now }), [
    { t: now - 3, s: 12, sSource: 'control' },
    { t: now - 2, s: 14, sr: 1e9 + 60, w: 32, sSource: 'hook', wSource: 'control' }
  ]);
  assert.equal(fs.readFileSync(controlFile, 'utf8'), before);
  assert.deepEqual(readPlanHistory({ dir, now }), [{ t: now - 2, s: 14, sr: 1e9 + 60, sSource: 'hook' }]);
  t.after(() => {
    fs.unlinkSync(controlFile);
    fs.unlinkSync(path.join(dir, 'usage-history.json'));
    fs.rmdirSync(dir);
  });
});
