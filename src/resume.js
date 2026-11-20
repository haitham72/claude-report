'use strict';

const fs = require('fs');
const path = require('path');

const norm = (p) => {
  const n = path.resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

// Claude Code stores a session under the folder it ran in, and can only find it again from
// that folder. The Claude Code panel resumes inside the open folder, so only a session from
// that same folder can use it. Any other session is resumed in a terminal started in its own
// folder, which works whichever editor created the session.
function resumeTarget({ here, cwd, exists = fs.existsSync }) {
  if (!cwd) return { via: 'terminal', cwd: here || undefined, missing: false };
  const folder = exists(cwd) ? cwd : null;
  if (here && folder && norm(here) === norm(folder)) return { via: 'panel', cwd: folder, missing: false };
  return { via: 'terminal', cwd: folder || here || undefined, missing: !folder };
}

module.exports = { resumeTarget };
