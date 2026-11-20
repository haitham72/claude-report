'use strict';

// Opens a new mail draft with the report attached. Classic Outlook only (COM / AppleScript):
// other clients cannot take an attachment from the command line, the caller falls back to mailto.
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

// Fixed script: user values come from the environment only, so there is nothing to quote or inject into.
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$o = New-Object -ComObject Outlook.Application',
  '$m = $o.CreateItem(0)',
  'if ($env:CR_TO) { $m.To = $env:CR_TO }',
  '$m.Subject = $env:CR_SUBJECT',
  '$m.Body = $env:CR_BODY',
  '[void]$m.Attachments.Add($env:CR_FILE)',
  '$m.Display()',
].join('; ');

// Values arrive as argv, never spliced into the script text.
const OSA_SCRIPT = [
  'on run argv',
  'set theFile to POSIX file (item 1 of argv)',
  'set theTo to item 2 of argv',
  'tell application "Microsoft Outlook"',
  'set msg to make new outgoing message with properties {subject:(item 3 of argv), plain text content:(item 4 of argv)}',
  'if theTo is not "" then make new to recipient at msg with properties {email address:{address:theTo}}',
  'make new attachment at msg with properties {file:theFile}',
  'open msg',
  'activate',
  'end tell',
  'end run',
];

function mailtoUrl({ to = '', subject = '', body = '' } = {}) {
  const b = String(body || '').slice(0, 1500);
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(b)}`;
}

function run(spawn, cmd, args, env, timeoutMs, method) {
  return new Promise((resolve) => {
    let done = false, err = '', child, timer;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try {
      child = spawn(cmd, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return finish({ ok: false, method, error: e.message }); }
    if (child.stderr && child.stderr.on) child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    child.on('error', (e) => finish({ ok: false, method, error: e.message }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, method } : { ok: false, method, error: err.trim() || `exit code ${code}` }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, method, error: 'timed out' });
    }, timeoutMs);
  });
}

async function openMailDraft({ file, to = '', subject = '', body = '', platform = process.platform, spawn = child_process.spawn, timeoutMs = 20000 } = {}) {
  try {
    const method = platform === 'win32' ? 'outlook-com' : platform === 'darwin' ? 'outlook-applescript' : 'none';
    if (method === 'none') return { ok: false, method, error: 'no supported mail client' };
    if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) {
      return { ok: false, method, error: `attachment not found: ${file}` };
    }
    if (method === 'outlook-com') {
      const env = { ...process.env, CR_FILE: file, CR_TO: to || '', CR_SUBJECT: subject || '', CR_BODY: body || '' };
      return await run(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], env, timeoutMs, method);
    }
    const args = [];
    for (const l of OSA_SCRIPT) args.push('-e', l);
    args.push(file, to || '', subject || '', body || '');
    return await run(spawn, 'osascript', args, process.env, timeoutMs, method);
  } catch (e) {
    return { ok: false, method: 'none', error: e.message };
  }
}

module.exports = { openMailDraft, mailtoUrl, PS_SCRIPT };
