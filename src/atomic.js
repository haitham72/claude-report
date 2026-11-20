'use strict';

const fs = require('fs');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Writes next to the target and renames over it. On Windows the rename fails with EPERM or EBUSY while
// another program (an editor, Claude Code, antivirus) has the target open, so it is retried briefly and,
// failing that, the content is written in place. Returns which way it went.
function writeFileAtomic(file, text, { fsImpl = fs, retries = 6, wait = sleep } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, text);
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      fsImpl.renameSync(tmp, file);
      return 'rename';
    } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      wait(40 * (i + 1));
    }
  }
  try {
    fsImpl.writeFileSync(file, text);
    return 'in-place';
  } catch (e) {
    throw last || e;
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

module.exports = { writeFileAtomic };
