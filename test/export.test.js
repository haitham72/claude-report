'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { findBrowser, htmlToPdf, safeName, buildMessage, defaultBody, exportReport } = require('../src/export');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const html = path.join(tmp, 'report.html');
fs.writeFileSync(html, '<html>hi</html>');

function child() { const c = new EventEmitter(); c.kill = () => { c.killed = true; }; return c; }
const pdfArg = (a) => a.find((x) => x.startsWith('--print-to-pdf=')).slice(15);

test('findBrowser order', () => {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const edge = path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const chrome = path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.strictEqual(findBrowser({ platform: 'win32', exists: (p) => p === edge || p === chrome }), edge);
  assert.strictEqual(findBrowser({ platform: 'win32', exists: (p) => p === chrome }), chrome);
  assert.strictEqual(findBrowser({ platform: 'win32', exists: () => false }), null);
  assert.match(findBrowser({ platform: 'darwin', exists: (p) => p.includes('Google Chrome') }), /Google Chrome$/);
  const seen = [];
  assert.strictEqual(findBrowser({ platform: 'linux', which: (n) => { seen.push(n); return n === 'chromium' ? '/usr/bin/chromium' : null; } }), '/usr/bin/chromium');
  assert.deepStrictEqual(seen, ['microsoft-edge', 'google-chrome', 'chromium']);
});

test('htmlToPdf args, profile cleanup and size check', async () => {
  let args, profile;
  const spawn = (cmd, a) => {
    args = a; profile = a.find((x) => x.startsWith('--user-data-dir=')).slice(16);
    assert.ok(fs.existsSync(profile));
    const c = child();
    setImmediate(() => { fs.writeFileSync(pdfArg(a), Buffer.alloc(5000)); c.emit('close', 0); });
    return c;
  };
  const r = await htmlToPdf({ htmlPath: html, pdfPath: path.join(tmp, 'a.pdf'), browser: 'B', spawn });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(args.slice(0, 4), ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=5000']);
  assert.strictEqual(args[args.length - 1], `${pathToFileURL(html).href}#print`);
  assert.ok(!fs.existsSync(profile));
});

test('htmlToPdf rejects tiny pdf and kills on timeout', async () => {
  const tiny = (cmd, a) => { const c = child(); setImmediate(() => { fs.writeFileSync(pdfArg(a), 'x'); c.emit('close', 0); }); return c; };
  const r = await htmlToPdf({ htmlPath: html, pdfPath: path.join(tmp, 'b.pdf'), browser: 'B', spawn: tiny });
  assert.strictEqual(r.ok, false);
  let c;
  const hang = () => (c = child());
  const r2 = await htmlToPdf({ htmlPath: html, pdfPath: path.join(tmp, 'c.pdf'), browser: 'B', spawn: hang, timeoutMs: 30 });
  assert.strictEqual(r2.ok, false); assert.ok(c.killed);
});

test('safeName, buildMessage, defaultBody', () => {
  assert.strictEqual(safeName('Ali Q./x y_z-1'), 'AliQ.xy_z-1');
  assert.strictEqual(buildMessage({ template: '{label}|{user}|{month}', month: '2026-11', label: 'Nov', user: 'Ali' }), 'Nov|Ali|2026-11');
  const b = defaultBody({ label: 'Nov', user: 'Ali', overview: { summary: 'S', goal: 'G', achievement: 'A' } });
  assert.match(b, /report for Nov is attached/);
  assert.match(b, /Summary: S\nGoal: G\nAchievement: A/);
  assert.ok(b.endsWith('Ali'));
  assert.ok(!/Summary/.test(defaultBody({ label: 'Nov', user: 'Ali' })));
});

test('exportReport html with save and collision naming', async () => {
  const home = path.join(tmp, 'home'), dl = path.join(tmp, 'Downloads');
  const run = () => exportReport({ month: '2026-11', label: 'Nov', run: '2026-11-18 16-35-15.123', user: 'sam.lee', htmlPath: html, options: { format: 'html', save: true, folder: dl }, home });
  const a = await run(), b = await run();
  assert.strictEqual(a.attachment, path.join(home, 'Report_11-18-2026_16-35-15_sam-lee.html'));
  assert.strictEqual(a.saved, path.join(dl, 'November_2026', 'Report_11-18-2026_16-35-15_sam-lee.html'));
  assert.strictEqual(b.saved, path.join(dl, 'November_2026', 'Report_11-18-2026_16-35-15_sam-lee-2.html'));
  assert.deepStrictEqual(a.notes, []);
});

test('re-export upgrades the HTML while preserving the original file timestamp for naming', async () => {
  const home = path.join(tmp, 'legacy');
  const original = path.join(tmp, 'old-report.html');
  fs.writeFileSync(original, 'old report');
  const date = new Date(2026, 10, 18, 14, 51, 43);
  fs.utimesSync(original, date, date);
  const result = await exportReport({ month: '2026-11', label: 'Nov', user: 'sam.lee', htmlPath: original,
    htmlContent: '<select id="theme"></select>', home });
  assert.strictEqual(result.attachment, path.join(home, 'Report_11-18-2026_14-51-43_sam-lee.html'));
  assert.match(fs.readFileSync(result.attachment, 'utf8'), /id="theme"/);
  assert.strictEqual(fs.readFileSync(original, 'utf8'), 'old report');
});

test('exportReport pdf falls back to html without a browser', async () => {
  const r = await exportReport({ month: 'm', label: 'L', user: 'u', htmlPath: html, options: { format: 'pdf' }, home: path.join(tmp, 'h2'), deps: { findBrowser: () => null } });
  assert.ok(r.attachment.endsWith('.html'));
  assert.deepStrictEqual(r.notes, ['PDF needs Edge or Chrome, sent as HTML']);
});

test('exportReport pdf success and outlook failure becomes a note', async () => {
  let mailArgs;
  const deps = {
    findBrowser: () => 'B',
    htmlToPdf: async ({ pdfPath }) => { fs.writeFileSync(pdfPath, Buffer.alloc(3000)); return { ok: true }; },
    openMailDraft: async (a) => { mailArgs = a; return { ok: false, method: 'outlook-com', error: 'no COM' }; },
  };
  const r = await exportReport({ month: 'm', label: 'L', user: 'u', overview: { summary: 'S' }, htmlPath: html, options: { format: 'pdf', outlook: true, to: 'x@y.z' }, home: path.join(tmp, 'h3'), deps });
  assert.ok(r.attachment.endsWith('.pdf'));
  assert.strictEqual(r.mail.ok, false);
  assert.ok(r.notes.some((n) => /no COM/.test(n)));
  assert.strictEqual(mailArgs.subject, 'AI report, L, u');
  assert.strictEqual(mailArgs.to, 'x@y.z');
  assert.match(mailArgs.body, /Summary: S/);
});
