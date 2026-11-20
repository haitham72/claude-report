'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resumeTarget } = require('../src/resume');

const yes = () => true;

test('a session from the open folder resumes in the Claude Code panel', () => {
  assert.deepStrictEqual(resumeTarget({ here: 'G:/a/b', cwd: 'G:\\a\\b\\', exists: yes }), { via: 'panel', cwd: 'G:\\a\\b\\', missing: false });
});

test('a session from another folder resumes in a terminal started in that folder', () => {
  const r = resumeTarget({ here: 'G:/a/b', cwd: 'G:/a/other', exists: yes });
  assert.strictEqual(r.via, 'terminal');
  assert.strictEqual(r.cwd, 'G:/a/other');
});

test('a subfolder is another folder, because sessions are stored per folder', () => {
  assert.strictEqual(resumeTarget({ here: 'G:/a/b', cwd: 'G:/a/b/sub', exists: yes }).via, 'terminal');
});

test('a folder that no longer exists falls back to the open folder and says so', () => {
  const r = resumeTarget({ here: 'G:/a/b', cwd: 'G:/gone', exists: () => false });
  assert.deepStrictEqual(r, { via: 'terminal', cwd: 'G:/a/b', missing: true });
});

test('no workspace and no folder still gives a terminal', () => {
  assert.strictEqual(resumeTarget({ here: undefined, cwd: '', exists: yes }).via, 'terminal');
});
