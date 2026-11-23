'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redact } = require('./scan');
const { reportBounds } = require('./report-window');

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };

// The signed-in Git identity of a repository. Without one, commits cannot be attributed to the report's author.
function repositoryAuthor(root, spawn) {
  const result = spawn('git', ['-C', root, 'config', 'user.email'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: GIT_ENV });
  const email = result?.status === 0 ? String(result.stdout || '').trim().toLowerCase() : '';
  return /^\S+@\S+$/.test(email) ? email : '';
}

function readRepository(root, from, to, spawn = spawnSync) {
  const args = ['-C', root, 'log', '--all', '--since-as-filter=' + from.toISOString(), '--until=' + to.toISOString(),
    '--format=%H%x09%cI%x09%aI%x09%ae%x09%s', '--no-show-signature', '--encoding=UTF-8'];
  const result = spawn('git', args, {
    encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, env: GIT_ENV
  });
  const name = path.basename(root);
  if (result.error || result.status !== 0) return { name, unavailable: true, commits: [] };
  // Only the report author's commits are listed. A shared repository would otherwise credit teammates' work.
  const author = repositoryAuthor(root, spawn);
  if (!author) return { name, commits: [], authorUnknown: true };
  const commits = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [hash, at, authored, email, ...subject] = line.split('\t');
    const date = new Date(at);
    if (!/^[a-f0-9]{40,64}$/.test(hash) || !(date >= from && date < to)) continue;
    if (String(email || '').toLowerCase() !== author) continue;
    commits.push({ hash, at, authored, subject: redact(subject.join(' ')).slice(0, 250) });
  }
  return { name, commits };
}

function collectGit(projects, month, now = new Date(), spawn = spawnSync, dateRange) {
  const { from, to } = reportBounds(month, dateRange, now);
  const cache = new Map();
  return Object.fromEntries(projects.map((project) => {
    const repositories = [];
    for (const root of new Set(project.repositories || [])) {
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (!cache.has(key)) cache.set(key, readRepository(root, from, to, spawn));
      repositories.push(cache.get(key));
    }
    const times = repositories.flatMap((repo) => repo.commits.map((commit) => commit.at))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    return [project.id || project.name, { repositories, count: times.length, first: times[0], last: times.at(-1) }];
  }));
}

function summarizeGit(evidence) {
  if (!evidence?.count) return undefined;
  const all = evidence.repositories.flatMap((repo) => repo.commits.map(({ hash, at, subject }) =>
    ({ repository: repo.name, commit: hash.slice(0, 10), at, subject })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const count = Math.min(all.length, 12);
  const commits = count === 1 ? all : Array.from({ length: count }, (_, index) =>
    all[Math.round(index * (all.length - 1) / (count - 1))]);
  return { count: evidence.count, first: evidence.first, last: evidence.last, commits };
}

module.exports = { collectGit, summarizeGit };
