'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectKey, labelProjects, captureEvidence, reviseProjects, reportsByProject, matchLegacyProject } = require('../src/report-revision');

test('colliding project labels are distinct and stable when scan order changes', () => {
  const projects = [
    { id: 'b', name: 'site', location: 'D:/local/site' },
    { id: 'a', name: 'site', location: 'C:/local/site' },
    { id: 'c', name: 'site (1)' }
  ];
  const labels = labelProjects(projects);
  assert.deepEqual(labels.map(({ name }) => name), ['site (3)', 'site (2)', 'site (1)']);
  assert.deepEqual(labels.map(({ baseName }) => baseName), ['site', 'site', 'site (1)']);
  assert.deepEqual(labelProjects([...projects].reverse()).reverse(), labels);
  assert.deepEqual(labelProjects(labels), labels);
});

test('evidence stores at most sixty sampled prompts and protects project IDs from prompt redaction', () => {
  const id = 'a'.repeat(64);
  const daily = { '2026-11-01': 100 };
  const prompts = Array.from({ length: 120 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    text: `Check this feature with token=${id}`,
    source: 'codex'
  }));
  const project = { id, name: 'sample (2)', baseName: 'sample', promptCount: 120, totalTokens: 100, sessions: 1,
    location: 'C:/local/sample', repositories: ['C:/local/sample'], daily, prompts: prompts.slice().reverse() };
  const [snapshot] = captureEvidence([project]);
  assert.deepEqual(Object.keys(snapshot), ['id', 'name', 'baseName', 'totalTokens', 'sessions', 'promptCount', 'daily', 'prompts']);
  assert.notEqual(snapshot.daily, daily);
  assert.equal(snapshot.id, id);
  assert.equal(snapshot.promptCount, 120);
  assert.equal(snapshot.prompts.length, 60);
  assert.equal(snapshot.prompts[0].at, prompts[0].at);
  assert.equal(snapshot.prompts.at(-1).at, prompts[118].at);
  assert(snapshot.prompts.every(({ text, source }) => !text.includes(id) && text.includes('[redacted]') && source === 'codex'));
});

test('editing or removing projects keeps stable keys and marks the overview stale', () => {
  const legacy = { name: 'old label', report: { summary: 'original' } };
  const saved = { id: 'failed-project', name: 'failed' };
  const data = { projects: [legacy, saved], overview: { summary: 'overview' }, failures: [
    { project: 'old label' }, { id: saved.id, project: saved.name }
  ] };
  const edited = { ...legacy, name: 'new label', baseName: legacy.name, report: { summary: 'revised' } };
  const revision = reviseProjects(data, new Map([[projectKey(legacy), edited]]), new Set([projectKey(saved)]));
  assert.deepEqual(revision.projects, [edited]);
  assert.equal(revision.overview, null);
  assert.equal(revision.overviewStale, true);
  assert.deepEqual(revision.failures, [{ project: 'old label' }]);
  assert.deepEqual(reportsByProject(revision.projects), { 'old label': { summary: 'revised' } });
  assert.deepEqual(data.projects, [legacy, saved]);
});

test('legacy evidence matching resolves exact IDs and refuses an ambiguous or conflicting match', () => {
  const a = { id: 'first', name: 'sample (1)', baseName: 'sample' };
  const b = { id: 'second', name: 'sample (2)', baseName: 'sample' };
  assert.equal(matchLegacyProject({ id: b.id, name: 'renamed' }, [a, b]), b);
  assert.equal(matchLegacyProject({ name: 'renamed', baseName: 'sample' }, [a]), a);
  assert.equal(matchLegacyProject({ name: 'sample (2)' }, [a, b]), b);
  assert.throws(() => matchLegacyProject({ name: 'sample' }, [a, b]), /Multiple evidence projects/);
  assert.throws(() => matchLegacyProject({ id: b.id, name: 'sample' }, [a]), /unavailable/);
});
