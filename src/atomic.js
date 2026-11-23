'use strict';

const fs = require('fs');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Writes next to the target and renames over it. On Windows the rename fails with EPERM or EBUSY while
// another program (an editor, Claude Code, antivirus) has the target open, so it is retried briefly and,
// failing that, the last rename error is thrown. The target is never written in place, so a reader never
// sees half a file. Returns 'rename'.
function writeFileAtomic(file, text, { fsImpl = fs, retries = 6, wait = sleep } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, text);
  let last;
  try {
    for (let i = 0; i <= retries; i++) {
      try {
        fsImpl.renameSync(tmp, file);
        return 'rename';
      } catch (e) {
        last = e;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
        if (i < retries) wait(40 * (i + 1));
      }
    }
    throw last;
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch { /* already gone after a successful rename */ }
  }
}

module.exports = { writeFileAtomic };
