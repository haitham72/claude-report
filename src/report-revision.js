'use strict';

const { sliceProject } = require('./generate');
const { redact } = require('./scan');

function projectKey(project) {
  return project.id || project.baseName || project.name;
}

function labelProjects(projects) {
  const groups = new Map();
  const used = new Set();
  const labels = new Map();
  for (const project of projects) {
    const base = project.baseName || project.name;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(project);
    used.add(base);
  }
  for (const [base, group] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (group.length < 2) continue;
    group.sort((a, b) => projectKey(a).localeCompare(projectKey(b), 'en'));
    let number = 1;
    for (const project of group) {
      let label;
      do { label = `${base} (${number++})`; } while (used.has(label));
      used.add(label);
      labels.set(project, label);
    }
  }
  return projects.map((project) => ({
    ...project,
    baseName: project.baseName || project.name,
    name: labels.get(project) || project.name
  }));
}

function captureEvidence(projects) {
  return projects.map((project) => {
    const slice = sliceProject(project);
    return {
      id: project.id,
      name: project.name,
      baseName: project.baseName || project.name,
      totalTokens: project.totalTokens,
      sessions: project.sessions,
      promptCount: project.promptCount,
      daily: { ...project.daily },
      prompts: slice.prompts.map((prompt) => ({ ...prompt, text: redact(prompt.text) })),
      ...(slice.interruptions ? { interruptions: slice.interruptions } : {})
    };
  });
}

function reviseProjects(data, replacements = new Map(), removed = new Set()) {
  return {
    ...data,
    projects: data.projects.filter((project) => !removed.has(projectKey(project)))
      .map((project) => replacements.get(projectKey(project)) || project),
    overview: null,
    overviewStale: true,
    ...(data.failures && { failures: data.failures.filter((failure) => !removed.has(failure.id || failure.project)) }),
    ...(data.reviewFailures && { reviewFailures: data.reviewFailures.filter((failure) => !removed.has(failure.id || failure.project)) })
  };
}

function reportsByProject(projects) {
  return Object.fromEntries(projects.filter((project) => project.report).map((project) => [projectKey(project), project.report]));
}

function matchLegacyProject(savedProject, scannedProjects) {
  if (savedProject.id) {
    const exact = scannedProjects.filter((project) => project.id === savedProject.id);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error('Multiple evidence projects match the saved project ID');
  }
  const name = savedProject.baseName || savedProject.name;
  const candidates = scannedProjects.filter((project) => !savedProject.id || !project.id);
  const originalMatches = candidates.filter((project) => (project.baseName || project.name) === name);
  const matches = originalMatches.length ? originalMatches : candidates.filter((project) => project.name === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Multiple evidence projects match ${name}`);
  throw new Error(`Evidence for ${name} is unavailable`);
}

module.exports = { projectKey, labelProjects, captureEvidence, reviseProjects, reportsByProject, matchLegacyProject };
