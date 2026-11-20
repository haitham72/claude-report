'use strict';

// Turns a finished report page into a PDF or HTML attachment, saves a copy, and hands it to the mail draft.
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const { pathToFileURL } = require('url');
const mail = require('./mail');

function findBrowser({ platform = process.platform, exists = fs.existsSync, which = () => null } = {}) {
  if (platform === 'win32') {
    const roots = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA].filter(Boolean);
    const rel = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
    for (const r of rel) for (const root of roots) {
      const p = path.win32.join(root, ...r);
      if (exists(p)) return p;
    }
    return null;
  }
  if (platform === 'darwin') {
    for (const p of ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (exists(p)) return p;
    return null;
  }
  for (const n of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
    const p = which(n);
    if (p) return p;
  }
  return null;
}

function htmlToPdf({ htmlPath, pdfPath, browser, spawn = child_process.spawn, timeoutMs = 45000 }) {
  return new Promise((resolve) => {
    let profile, child, timer, done = false;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve(r);
    };
    try {
      if (!browser) return finish({ ok: false, error: 'no browser' });
      // Fresh profile: otherwise a running Edge swallows the command and prints nothing.
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pdf-'));
      try { fs.rmSync(pdfPath, { force: true }); } catch { /* ignore */ }
      const args = ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=5000',
        `--user-data-dir=${profile}`, `--print-to-pdf=${pdfPath}`, `${pathToFileURL(htmlPath).href}#print`];
      child = spawn(browser, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('close', () => {
        let size = 0;
        try { size = fs.statSync(pdfPath).size; } catch { /* missing */ }
        finish(size > 1024 ? { ok: true } : { ok: false, error: 'no PDF produced' });
      });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, error: 'timed out' });
      }, timeoutMs);
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

const safeName = (text) => String(text == null ? '' : text).replace(/[^A-Za-z0-9._-]/g, '');

function exportName({ run, date, user }) {
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}-\d{2}-\d{2})(?:\.\d{3})?(?:-\d+)?$/.exec(run || '');
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = parts ? [parts[2], parts[3], parts[1], parts[4]]
    : [pad(date.getMonth() + 1), pad(date.getDate()), date.getFullYear(), [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('-')];
  const name = String(user || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return 'Report_' + stamp.slice(0, 3).join('-') + '_' + stamp[3] + '_' + name;
}

function monthFolder(month) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return 'Reports';
  const [year, number] = month.split('-').map(Number);
  const name = new Date(year, number - 1, 1).toLocaleString('en-US', { month: 'long' });
  return name + '_' + year;
}

function buildMessage({ template = '', month = '', label = '', user = '' } = {}) {
  return String(template).replace(/\{month\}/g, month).replace(/\{label\}/g, label).replace(/\{user\}/g, user);
}

function defaultBody({ label = '', user = '', overview } = {}) {
  const lines = ['Hello,', '', `The AI report for ${label} is attached.`];
  if (overview && (overview.summary || overview.goal || overview.achievement)) {
    lines.push('');
    if (overview.summary) lines.push(`Summary: ${overview.summary}`);
    if (overview.goal) lines.push(`Goal: ${overview.goal}`);
    if (overview.achievement) lines.push(`Achievement: ${overview.achievement}`);
  }
  lines.push('', user);
  return lines.join('\n');
}

function uniquePath(fsm, dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fsm.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

function whichOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

async function exportReport({ month, label, run, user, overview, htmlPath, htmlContent, options = {}, home, deps = {} } = {}) {
  const d = {
    findBrowser: deps.findBrowser || (() => findBrowser({ which: whichOnPath })),
    htmlToPdf: deps.htmlToPdf || htmlToPdf,
    openMailDraft: deps.openMailDraft || mail.openMailDraft,
    fs: deps.fs || fs,
  };
  const notes = [];
  const out = { attachment: null, saved: null, notes, mail: null };
  try {
    const o = options || {};
    let ext = o.format === 'pdf' ? 'pdf' : 'html';
    const date = run ? new Date() : d.fs.statSync(htmlPath).mtime;
    const base = exportName({ run, date, user });
    d.fs.mkdirSync(home, { recursive: true });
    const htmlAttachment = path.join(home, `${base}.html`);
    if (htmlContent !== undefined) d.fs.writeFileSync(htmlAttachment, htmlContent);
    let attachment = path.join(home, `${base}.${ext}`);
    if (ext === 'pdf') {
      let r = { ok: false };
      try {
        const browser = d.findBrowser();
        if (browser) r = await d.htmlToPdf({ htmlPath: htmlContent === undefined ? htmlPath : htmlAttachment, pdfPath: attachment, browser });
      } catch (e) { r = { ok: false, error: e.message }; }
      if (!r || !r.ok) {
        notes.push('PDF needs Edge or Chrome, sent as HTML');
        ext = 'html';
        attachment = path.join(home, `${base}.html`);
      }
    }
    if (ext === 'html' && htmlContent === undefined) d.fs.copyFileSync(htmlPath, attachment);
    out.attachment = attachment;

    if (o.save) {
      try {
        const root = o.folder || path.join(os.homedir(), 'Downloads', 'Reports');
        const period = monthFolder(month);
        const dir = path.basename(path.normalize(root)).toLowerCase() === period.toLowerCase() ? root : path.join(root, period);
        d.fs.mkdirSync(dir, { recursive: true });
        let dest;
        for (;;) {
          dest = uniquePath(d.fs, dir, path.basename(attachment));
          try { d.fs.copyFileSync(attachment, dest, fs.constants.COPYFILE_EXCL); break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        out.saved = dest;
      } catch (e) { notes.push(`could not save a copy: ${e.message}`); }
    }

    if (o.outlook) {
      const subject = buildMessage({ template: o.subject || 'AI report, {label}, {user}', month, label, user });
      const body = o.body ? buildMessage({ template: o.body, month, label, user }) : defaultBody({ label, user, overview });
      const r = await d.openMailDraft({ file: attachment, to: o.to || '', subject, body });
      if (!r || !r.ok) {
        out.mail = r || { ok: false, method: 'none', error: 'no result' };
        notes.push(`mail draft failed: ${out.mail.error || 'unknown error'}`);
      }
    }
  } catch (e) { notes.push(`export failed: ${e.message}`); }
  return out;
}

module.exports = { findBrowser, htmlToPdf, safeName, buildMessage, defaultBody, exportName, exportReport };
