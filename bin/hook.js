#!/usr/bin/env node
'use strict';

// statusLine command: records a live snapshot, then shows the user's original
// status line (chain) or a short line of our own. Never fails, never prints errors.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { DEFAULT_DIR, writeLive } = require('../src/live');

const RING = ['○', '◔', '◑', '◕', '●'];
const ring = (p) => RING[Math.min(4, Math.round(Math.max(0, p) / 25))];

// The line Claude Code shows at the bottom of its terminal UI when no other status line is chained.
// Colour is only added for the real command; tests read the plain text.
function ownLine(s, color) {
  const paint = (text, pct) => {
    if (!color) return text;
    const code = pct == null ? 111 : pct >= 80 ? 203 : pct >= 50 ? 214 : 78;
    return `\u001b[38;5;${code}m${text}\u001b[0m`;
  };
  const parts = [];
  if (s.model && s.model.display_name) parts.push(color ? `\u001b[38;5;147m${s.model.display_name}\u001b[0m` : s.model.display_name);
  const ctx = s.context_window && s.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push(paint(color ? `${ring(ctx)} ctx ${Math.round(ctx)}%` : `ctx ${Math.round(ctx)}%`, ctx));
  const rl = s.rate_limits || {};
  const f = rl.five_hour && rl.five_hour.used_percentage;
  const d = rl.seven_day && rl.seven_day.used_percentage;
  if (typeof f === 'number') parts.push(paint(color ? `${ring(f)} 5h ${Math.round(f)}%` : `5h ${Math.round(f)}%`, f));
  if (typeof d === 'number') parts.push(paint(color ? `${ring(d)} 7d ${Math.round(d)}%` : `7d ${Math.round(d)}%`, d));
  const dir = s.cwd ? String(s.cwd).split(/[\\/]/).filter(Boolean).pop() : '';
  const head = dir && color ? `\u001b[2m${dir}\u001b[0m  ` : '';
  return head + parts.join(color ? '  ' : ' · ');
}

// "C:/path with spaces/app.exe" --flag  ->  ['C:/path with spaces/app.exe', '--flag'].
// Returns null when the command needs a shell: pipes, redirects, variables, .cmd files.
function splitCommand(cmd) {
  if (/[|&<>;`$%^()'~]/.test(cmd.replace(/"[^"]*"/g, '""'))) return null;
  if (/^\s*[A-Za-z_]\w*=/.test(cmd)) return null; // FOO=1 tool
  // A quote glued to other text (--fmt="a b") is shell syntax; a quoted token must stand alone.
  for (const m of cmd.matchAll(/"[^"]*"/g)) {
    const before = cmd[m.index - 1];
    const after = cmd[m.index + m[0].length];
    if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) return null;
  }
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2]);
  if (!out.length || /\.(cmd|bat)$/i.test(out[0])) return null;
  return out;
}

function run(stdinText, { dir = DEFAULT_DIR, spawn = childProcess.spawnSync, color = false } = {}) {
  let status = null;
  try {
    status = JSON.parse(stdinText);
    writeLive(status, { dir });
  } catch { /* the status line must never break */ }
  let chain = null;
  try { chain = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).chain; } catch { /* no config */ }
  if (typeof chain === 'string' && chain) {
    try {
      const opts = { input: stdinText, encoding: 'utf8', timeout: 3000, windowsHide: true };
      // Without a shell a timeout kills the program itself, not a cmd.exe wrapper that leaves it running.
      const parts = splitCommand(chain);
      const r = parts ? spawn(parts[0], parts.slice(1), opts) : spawn(chain, { ...opts, shell: true });
      // A chain that prints nothing (its app was closed or removed) falls back to our own line.
      if (r && typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout;
    } catch { /* fall through to our own line */ }
  }
  try { return status ? ownLine(status, color) : ''; } catch { return ''; }
}

if (require.main === module) {
  let buf = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let out = '';
    try { out = run(buf, { color: !process.env.NO_COLOR }); } catch { /* ignore */ }
    process.stdout.write(out, () => process.exit(0));
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 1000).unref();
}

module.exports = { run, splitCommand };
