'use strict';

// Turns scan results and per-project reports into the report page. All design
// lives in template/report.html; this file only prepares numbers and fills it.
const fs = require('fs');
const path = require('path');
const { dayList } = require('./scan');
const { reportBounds, dateRangeLabel } = require('./report-window');
const { toDocument } = require('./report-document');

const TEMPLATE = path.join(__dirname, '..', 'template', 'report.html');

function hours(text) {
  const m = /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(min|h|hour|day)/i.exec(text || '');
  if (!m) return null;
  const n = m[2] ? (+m[1] + +m[2]) / 2 : +m[1];
  const unit = m[3].toLowerCase();
  return unit === 'min' ? n / 60 : unit === 'day' ? n * 8 : n;
}

// scan: { projects }, reports: { [projectName]: report }. schemaVersion is the
// contract the team dashboard will import without any model in between.
function buildData({ month, scan, reports = {}, user = '', overview = null, now = new Date(), dateRange }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const sameMonth = now.getFullYear() === y && now.getMonth() === m - 1;
  const through = dateRange ? Number(dateRange.to.slice(-2)) : sameMonth ? now.getDate() : new Date(y, m, 0).getDate();
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const custom = dateRange ? reportBounds(month, dateRange, now) : null;
  const label = custom ? dateRangeLabel(dateRange) : first.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  return {
    schemaVersion: 1,
    overview,
    month,
    label,
    range: custom ? label : `${fmt(first)} to ${fmt(new Date(y, m - 1, through))}`,
    ...(custom ? { dateRange } : {}),
    through,
    days: custom ? dayList(custom.from, custom.end) : dayList(first, new Date(y, m - 1, through + 1)),
    user,
    projects: scan.projects.map((p) => {
      const r = reports[p.id || p.name];
      return {
        name: p.name,
        ...(p.id ? { id: p.id, baseName: p.baseName || p.name } : {}),
        tokens: p.totalTokens,
        ...(p.tokens ? { tokenParts: { input: p.tokens.input || 0, output: p.tokens.output || 0, cacheRead: p.tokens.cacheRead || 0, cacheCreate: p.tokens.cacheCreate || 0 } } : {}),
        sessions: p.sessions,
        prompts: p.promptCount,
        daily: p.daily || {},
        dailyTurns: p.dailyTurns || {},
        git: p.git,
        report: r && withExampleHours(r)
      };
    })
  };
}

function withExampleHours(report) {
  return { ...report, examples: report.examples.map((e) => ({ ...e, a: hours(e.withoutAI), b: hours(e.withAI) })) };
}

function renderHtml(data, template = fs.readFileSync(TEMPLATE, 'utf8')) {
  // "<" is escaped so no project name can close the script block it sits in.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template.replace('__DATA__', () => json);
}

// The standalone file: the same page as renderHtml, inside a complete document.
const renderDocument = (data, template) => toDocument(renderHtml(data, template));

module.exports = { buildData, renderHtml, renderDocument, hours, withExampleHours };

if (require.main === module) {
  const { accountUsername } = require('./user');
  const { scrubDeep } = require('./scan');
  const month = process.argv[2];
  if (!month) { console.log('usage: node src/render.js YYYY-MM'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'out', month);
  const scan = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  const reports = {};
  const repDir = path.join(dir, 'reports');
  if (fs.existsSync(repDir)) {
    for (const f of fs.readdirSync(repDir)) {
      const r = scrubDeep(JSON.parse(fs.readFileSync(path.join(repDir, f), 'utf8')));
      reports[r.project] = r;
    }
  }
  const out = path.join(dir, 'report.html');
  const ovFile = path.join(dir, 'overview.json');
  const overview = fs.existsSync(ovFile) ? scrubDeep(JSON.parse(fs.readFileSync(ovFile, 'utf8'))) : null;
  fs.writeFileSync(out, renderDocument(buildData({ month, scan, reports, overview, user: accountUsername() })));
  console.log('written', out);
}
