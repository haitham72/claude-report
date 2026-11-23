'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../src/atomic');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-')), 'settings.json');

test('writes the file and leaves no temp file', () => {
  const f = tmpFile();
  assert.strictEqual(writeFileAtomic(f, 'one'), 'rename');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'one');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')), []);
});

test('a rename that fails with EPERM is retried and then succeeds', () => {
  const f = tmpFile();
  let fails = 2;
  const fsImpl = { ...fs, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync, renameSync: (a, b) => { if (fails-- > 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); fs.renameSync(a, b); } };
  assert.strictEqual(writeFileAtomic(f, 'two', { fsImpl, wait() {} }), 'rename');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'two');
});

test('a target that stays locked is never written in place: the rename error is thrown and the temp file removed', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'old');
  const fsImpl = { writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync, renameSync: () => { throw Object.assign(new Error('EPERM stuck'), { code: 'EPERM' }); } };
  assert.throws(() => writeFileAtomic(f, 'three', { fsImpl, wait() {} }), /EPERM stuck/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')), []);
});

test('an error that is not a lock is not retried and is thrown', () => {
  const f = tmpFile();
  let calls = 0;
  const fsImpl = { writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync, renameSync: () => { calls++; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  assert.throws(() => writeFileAtomic(f, 'x', { fsImpl, wait() {} }), /ENOSPC/);
  assert.strictEqual(calls, 1);
});
