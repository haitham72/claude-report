'use strict';

// Runs the user's own Claude Code CLI headlessly. The prompt goes through stdin
// so it never hits the command line (length limits, shell quoting, ps output).
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A fixed folder outside any project: the scan can recognise and ignore it, and
// nothing run here is attributed to the user's own work.
const WORK_DIR = path.join(os.tmpdir(), 'claude-report-work');
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function runClaude({ model, effort, prompt, signal, schema, timeoutMs = 180000, spawn = childProcess.spawn, bin = 'claude' }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    // Checked before spawning: on win32 the args pass through a shell.
    if (!MODELS.includes(model)) return reject(new Error(`claude: model "${model}" is not allowed (${MODELS.join(', ')})`));
    if (!EFFORTS.includes(effort)) return reject(new Error(`claude: effort "${effort}" is not allowed (${EFFORTS.join(', ')})`));

    // No session file: the prompts sent here must not land in ~/.claude/projects, where next month's scan would read them again.
    const args = ['-p', '--model', model, '--effort', effort, '--output-format', schema ? 'json' : 'text', '--no-session-persistence'];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    let child;
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
      // Use the native executable for structured args. Plain text also supports claude.cmd.
      child = spawn(bin, args, { cwd: WORK_DIR, shell: process.platform === 'win32' && !schema, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`claude: could not start: ${e.message}`));
    }

    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const terminate = (error) => {
      finish(reject, error);
      // Through cmd.exe a plain kill leaves claude itself running, so take the whole tree down.
      if (process.platform === 'win32' && child.pid) {
        try { childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch { /* best effort */ }
      }
      try { child.kill(); } catch { /* already gone */ }
    };
    const onAbort = () => terminate(signal.reason);
    timer = setTimeout(() => terminate(new Error(`claude: timed out after ${timeoutMs} ms`)), timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      // One failed start is final. Re-running the identical command would respawn without end when the executable is missing.
      finish(reject, new Error(`claude: could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`claude: exited with code ${code}: ${err.trim().slice(-300)}`));
      if (!schema) return finish(resolve, out.trim());
      try {
        const envelope = JSON.parse(out);
        if (!envelope.is_error && envelope.structured_output) return finish(resolve, JSON.stringify(envelope.structured_output));
        if (typeof envelope.result === 'string' && envelope.result.trim()) {
          return envelope.is_error ? finish(reject, new Error(envelope.result.slice(0, 300))) : finish(resolve, envelope.result.trim());
        }
      } catch { /* Missing result fields are reported below. */ }
      finish(reject, new Error('Claude Code did not return structured review JSON'));
    });

    // A child that dies early closes stdin; the exit handler reports why.
    child.stdin.on('error', () => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.stdin.end(prompt);
  });
}

module.exports = { runClaude, MODELS, EFFORTS, WORK_DIR };
