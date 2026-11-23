'use strict';

// The name shown on a report, chosen automatically: the first one available of the Claude profile's
// display name, its full name, git user.name, the part of the Claude account email before "@",
// and the operating-system user name. Never the full email address.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const localPart = (email) => (typeof email === 'string' && email.includes('@') ? email.split('@')[0] : '');
const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

function claudeAccount(env = process.env) {
  try {
    const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || {};
  } catch { return {}; }
}

function gitName(run = execFileSync) {
  try {
    return clean(run('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }));
  } catch { return ''; }
}

function accountUsername({ account = claudeAccount(), git = gitName, osUser = () => os.userInfo().username } = {}) {
  const candidates = [() => account.displayName, () => account.fullName, git, () => localPart(account.emailAddress), osUser];
  for (const pick of candidates) {
    const name = clean(pick());
    if (name && !name.includes('@')) return name;
  }
  return 'user';
}

module.exports = { accountUsername, localPart };
