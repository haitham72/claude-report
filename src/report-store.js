'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { safeName } = require('./export');

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const RUN = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\d{3}(?:-\d+)?$/;
const EXPORT_NAME = /^Report_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}_[a-z0-9-]+\.(html|pdf)$/;
const REPORT_FILES = ['report.json', 'report.html', 'reports.json', 'report-metadata.json', 'report-evidence.json', 'report-history.json'];
const deletingRuns = new Set();
const deletingExports = new Map();

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds())
    + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function reportDir(home, month, run = '') {
  if (typeof month !== 'string' || !MONTH.test(month) || typeof run !== 'string' || (run && !RUN.test(run))) {
    throw new Error('Invalid report reference');
  }
  return run ? path.join(home, 'reports', month, 'runs', run) : path.join(home, 'reports', month);
}

function statIfPresent(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkedDir(home, month, run = '', create = false) {
  const dir = path.resolve(reportDir(home, month, run));
  let current = path.resolve(home);
  if (create) fs.mkdirSync(current, { recursive: true });
  for (const name of path.relative(current, dir).split(path.sep)) {
    current = path.join(current, name);
    if (create) {
      try { fs.mkdirSync(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!fs.lstatSync(current).isDirectory()) throw new Error('Invalid report directory');
  }
  return dir;
}

function reportFile(dir, name) {
  const file = path.join(dir, name);
  const stat = statIfPresent(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('Invalid report file');
  return file;
}

function readJson(dir, name, fallback) {
  const file = reportFile(dir, name);
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(dir, name, value) {
  const pending = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(pending, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(pending, path.join(dir, name));
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function saveRun(home, data, reports, html, now = new Date(), { metadata, evidence } = {}) {
  const monthDir = checkedDir(home, data.month, '', true);
  const runs = path.join(monthDir, 'runs');
  try { fs.mkdirSync(runs); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(runs).isDirectory()) throw new Error('Invalid report directory');
  const stamp = timestamp(now);
  let run = stamp;
  let index = 2;
  for (;;) {
    const dir = reportDir(home, data.month, run);
    try { fs.mkdirSync(dir); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      run = stamp + '-' + index++;
      continue;
    }
    writeJson(dir, 'reports.json', reports);
    fs.writeFileSync(path.join(dir, 'report.html'), html);
    if (metadata !== undefined) writeJson(dir, 'report-metadata.json', metadata);
    if (evidence !== undefined) writeJson(dir, 'report-evidence.json', evidence);
    // The index uses report.json as the completion marker.
    writeJson(dir, 'report.json', data);
    return run;
  }
}

function savedReportDir(home, month, run) {
  const dir = checkedDir(home, month, run);
  if (!reportFile(dir, 'report.json') || !reportFile(dir, 'report.html')) throw new Error('Saved report not found');
  return dir;
}

function readHistory(dir) {
  return readJson(dir, 'report-history.json', { archived: false, exports: [] });
}

function readMetadata(dir) {
  return readJson(dir, 'report-metadata.json', {});
}

function fingerprint(file, stat, withDigest) {
  const identity = [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.size].join(':');
  return withDigest ? { identity, digest: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } : { identity };
}

function exportIsAvailable(entry, checkDigest = false) {
  try {
    if (!path.isAbsolute(entry.path) || !EXPORT_NAME.test(path.basename(entry.path))) return false;
    if (fs.realpathSync(entry.path) !== entry.path) return false;
    const stat = fs.lstatSync(entry.path);
    if (!stat.isFile() || fingerprint(entry.path, stat, false).identity !== entry.identity) return false;
    return !checkDigest || fingerprint(entry.path, stat, true).digest === entry.digest;
  } catch {
    return false;
  }
}

function exportSummary(entry, checkDigest) {
  const { id, path: file, format, createdAt } = entry;
  return { id, path: file, format, createdAt, missing: !exportIsAvailable(entry, checkDigest) };
}

function loadRun(home, month, run = '') {
  const dir = savedReportDir(home, month, run);
  const history = readHistory(dir);
  return {
    data: readJson(dir, 'report.json'),
    reports: readJson(dir, 'reports.json', {}),
    metadata: readMetadata(dir),
    evidence: readJson(dir, 'report-evidence.json', null),
    archived: !!history.archived,
    exports: history.exports.map((entry) => exportSummary(entry))
  };
}

function listReports(home, { includeArchived = false } = {}) {
  const found = [];
  function children(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { return []; }
  }
  for (const month of children(path.join(home, 'reports')).filter((name) => MONTH.test(name))) {
    const runs = children(path.join(reportDir(home, month), 'runs')).filter((name) => RUN.test(name));
    for (const run of ['', ...runs]) {
      try {
        const dir = savedReportDir(home, month, run);
        const j = readJson(dir, 'report.json');
        const history = readHistory(dir);
        const archived = !!history.archived;
        if (archived && !includeArchived) continue;
        const metadata = readMetadata(dir);
        delete metadata.events;
        found.push({ month, run, label: j.label || month, projects: j.projects.filter((p) => p.report).length, partial: !!(j.failures?.length || j.reviewFailures?.length),
          archived, metadata, exports: history.exports.map((entry) => exportSummary(entry)) });
      } catch { /* Ignore incomplete or unreadable runs. */ }
    }
  }
  return found.sort((a, b) => b.month.localeCompare(a.month) || b.run.localeCompare(a.run, 'en', { numeric: true }));
}

function setReportArchived(home, month, run, archived) {
  const dir = savedReportDir(home, month, run);
  const history = readHistory(dir);
  history.archived = !!archived;
  writeJson(dir, 'report-history.json', history);
}

function recordReportExport(home, month, run, savedPath) {
  const dir = savedReportDir(home, month, run);
  const candidate = path.resolve(savedPath);
  const stat = fs.lstatSync(candidate);
  const file = fs.realpathSync(candidate);
  const match = EXPORT_NAME.exec(path.basename(file));
  if (!stat.isFile() || !match) throw new Error('Invalid report export');
  const history = readHistory(dir);
  const signature = fingerprint(file, stat, true);
  const known = history.exports.find((entry) => entry.path === file && entry.identity === signature.identity && entry.digest === signature.digest);
  if (known) return exportSummary(known);
  const entry = { id: randomUUID(), path: file, format: match[1], createdAt: new Date().toISOString(), ...signature };
  history.exports.unshift(entry);
  writeJson(dir, 'report-history.json', history);
  return exportSummary(entry);
}

function findReportExport(dir, exportId) {
  const entry = readHistory(dir).exports.find(({ id }) => id === exportId);
  if (!entry) throw new Error('Saved report copy not found');
  return entry;
}

function getReportExport(home, month, run, exportId) {
  return exportSummary(findReportExport(savedReportDir(home, month, run), exportId), true);
}

function forgetReportExport(home, month, run, exportId) {
  const dir = savedReportDir(home, month, run);
  if (deletingExports.get(dir)?.has(exportId)) throw new Error('This copy is already being deleted');
  const history = readHistory(dir);
  history.exports = history.exports.filter(({ id }) => id !== exportId);
  writeJson(dir, 'report-history.json', history);
}

async function deleteReportExport(home, month, run, exportId, trash) {
  const dir = savedReportDir(home, month, run);
  const active = deletingExports.get(dir) || new Set();
  if (active.has(exportId)) throw new Error('This report copy is already being deleted');
  const entry = findReportExport(dir, exportId);
  deletingExports.set(dir, active);
  active.add(exportId);
  try {
    const deleted = exportIsAvailable(entry, true);
    if (deleted) await trash(entry.path);
    const history = readHistory(dir);
    history.exports = history.exports.filter(({ id }) => id !== exportId);
    writeJson(dir, 'report-history.json', history);
    return { path: entry.path, deleted };
  } finally {
    active.delete(exportId);
    if (!active.size) deletingExports.delete(dir);
  }
}

async function deleteReportRun(home, month, run, trash) {
  const dir = savedReportDir(home, month, run);
  if (deletingRuns.has(dir) || deletingExports.has(dir)) throw new Error('This report or one of its copies is already being deleted');

  const copies = new Set(readHistory(dir).exports.map((entry) => entry.path));
  const data = readJson(dir, 'report.json');
  const legacyBase = `AI-report-${month}-${safeName(data.user)}`;
  const legacyAttachments = run ? [] : [`${legacyBase}.html`, `${legacyBase}.pdf`];
  const attachments = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (EXPORT_NAME.test(entry.name) || legacyAttachments.includes(entry.name))
      && !copies.has(fs.realpathSync(path.join(dir, entry.name))))
    .map((entry) => entry.name);
  const files = [...REPORT_FILES, ...attachments].filter((name) => reportFile(dir, name));
  const staging = fs.mkdtempSync(path.join(checkedDir(home, month), '.deleted-report-'));
  const moved = [];
  deletingRuns.add(dir);
  try {
    for (const name of files) {
      fs.renameSync(path.join(dir, name), path.join(staging, name));
      moved.push(name);
    }
    await trash(staging);
  } catch (error) {
    const restoreErrors = [];
    for (const name of moved.reverse()) {
      try { fs.renameSync(path.join(staging, name), path.join(dir, name)); }
      catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (restoreErrors.length) throw new AggregateError([error, ...restoreErrors], `Report deletion failed and some files could not be restored from ${staging}`);
    fs.rmdirSync(staging);
    throw error;
  } finally {
    deletingRuns.delete(dir);
  }
}

module.exports = { reportDir, saveRun, loadRun, listReports, setReportArchived, recordReportExport, getReportExport, forgetReportExport, deleteReportExport, deleteReportRun };
