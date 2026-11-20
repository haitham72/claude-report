'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { redact, isEnvLeak, deepPrompt, dayKey } = require('./scan');
const { reportBounds } = require('./report-window');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
  });
  return result.status === 0 ? result.stdout : null;
}

function eligibleFile(file) {
  return file && !/(?:^|\/)(?:\.git|\.aws|\.ssh|node_modules)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)|(?:^|\/)(?:credentials|secrets?)(?:[./]|$)|\.(?:key|pem|pfx|p12)$/i.test(file) &&
    !isEnvLeak(file);
}

function rootContext(root) {
  const files = [];
  for (const name of ['README.md', 'CLAUDE.md']) {
    const file = path.join(root, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const fd = fs.openSync(file, 'r');
      let text;
      try {
        const head = Buffer.alloc(16000);
        const size = fs.readSync(fd, head, 0, head.length, 0);
        text = redact(head.toString('utf8', 0, size)).split(/\r?\n/).filter((line) => !isEnvLeak(line)).join('\n');
      } finally { fs.closeSync(fd); }
      text = deepPrompt(text).text.split(/\s+/).slice(0, 250).join(' ');
      if (text) files.push({ file: name, text });
    } catch { /* Root documentation is optional. */ }
  }
  return files;
}

function hunks(patch, effort) {
  const result = [];
  for (const match of patch.matchAll(/^@@ (.+?) @@[^\n]*\n((?:[+\-\\].*(?:\n|$))*)/gm)) {
    const item = { range: match[1] };
    if (effort === 'high') {
      const diffLines = match[2].split('\n').filter((line) => /^[+-]/.test(line));
      const content = diffLines.map((line) => line.slice(1)).join('\n');
      const omit = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) || isEnvLeak(content);
      const cleaned = omit ? '' : diffLines.map((line) => line[0] + redact(line.slice(1))).join('\n');
      item.digest = createHash('sha256').update(cleaned).digest('hex');
      item.lines = cleaned.slice(0, 1200);
      if (omit || cleaned.length > 1200) item.excerpt = true;
    }
    result.push(item);
  }
  return result;
}

function patchByFile(patch, effort) {
  const files = new Map();
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const header = section.split(/^@@ /m, 1)[0];
    const markers = [...header.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map((match) => match[1].trimEnd());
    const file = markers.reverse().find((name) => name !== '/dev/null');
    if (file) files.set(file, hunks(section, effort));
  }
  return files;
}

function collectChange(root, commands, at, ref, effort, evidence, missing, selected) {
  const names = git(root, commands.names);
  if (names === null) { missing.count++; return; }
  const files = [...new Set(names.split('\0').filter((file) => eligibleFile(file) && (!selected || selected.has(redact(file)))))];
  for (let index = 0; index < files.length; index += 30) {
    const group = files.slice(index, index + 30);
    const patch = effort === 'high' ? git(root, [...commands.patch, '--', ...group]) : '';
    const byFile = patch ? patchByFile(patch, effort) : new Map();
    for (const file of group) {
      const entry = { at, ref, file: redact(file) };
      if (effort === 'high') {
        if (patch === null || /["\\\t\n]/.test(file)) {
          const oneFile = git(root, [...commands.patch, '--', file]);
          if (oneFile === null) missing.count++;
          else entry.hunks = hunks(oneFile, effort);
        } else entry.hunks = byFile.get(file);
      }
      evidence.push(entry);
    }
  }
}

function collectDeepGit(projects, month, cutoff, effort, dateRange) {
  const bounds = reportBounds(month, dateRange, cutoff);
  const from = bounds.from.toISOString();
  const end = bounds.to.toISOString();
  const workingTree = dayKey(new Date(+bounds.to - 1)) === dayKey(new Date());
  return Object.fromEntries(projects.map((project) => {
    const changes = [], context = [], missing = { count: 0 };
    const selected = project.files ? new Set(project.files) : null;
    const roots = new Map((project.repositories || []).map((root) =>
      [process.platform === 'win32' ? root.toLowerCase() : root, root]));
    if (effort === 'medium' && project.location) context.push(...rootContext(project.location));
    let authorUnknown = false;
    for (const root of roots.values()) {
      const author = git(root, ['config', 'user.email'])?.trim().toLowerCase();
      if (!author) authorUnknown = true;
      const log = author ? git(root, ['log', '--all', '--since-as-filter=' + from, '--until=' + end, '--format=%H%x09%cI%x09%ae', '--no-show-signature']) : '';
      if (log === null) missing.count++;
      for (const line of (log || '').split(/\r?\n/)) {
        const [id, at, email] = line.split('\t');
        if (!id || !/^[0-9a-f]{40,64}$/.test(id) || email?.toLowerCase() !== author ||
          Date.parse(at) < Date.parse(from) || Date.parse(at) >= Date.parse(end)) continue;
        const show = ['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-prefix', '--diff-merges=first-parent'];
        collectChange(root, { names: [...show, '--name-only', '-z', id], patch: [...show, '--unified=0', id] },
          at, id, effort, changes, missing, selected);
      }
      for (const kind of workingTree ? ['staged', 'working tree'] : []) {
        const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-prefix', ...(kind === 'staged' ? ['--cached'] : [])];
        collectChange(root, { names: [...diff, '--name-only', '-z'], patch: [...diff, '--unified=0'] }, end, kind, effort, changes, missing, selected);
      }
    }
    const datedFiles = new Map(changes.map((change) => [change.at.slice(0, 10) + '\0' + change.file, change]));
    return [project.id || project.name, { changes: effort !== 'high' ? [...datedFiles.values()] : changes,
      context, missing: missing.count, authorUnknown }];
  }));
}

module.exports = { collectDeepGit, hunks };
