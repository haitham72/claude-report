'use strict';

// The name shown on a report: the part before "@" of the Claude account email.
// Only that local part leaves this module, never the address itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const localPart = (email) => (typeof email === 'string' && email.includes('@') ? email.split('@')[0] : '');

function accountUsername() {
  try {
    const j = JSON.parse(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'), 'utf8'));
    const u = localPart(j.oauthAccount && j.oauthAccount.emailAddress);
    if (u) return u;
  } catch { /* not signed in through Claude Code */ }
  try {
    const out = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
    const u = localPart(out.trim());
    if (u) return u;
  } catch { /* no git identity */ }
  return os.userInfo().username;
}

module.exports = { accountUsername, localPart };
