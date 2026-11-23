'use strict';

// Which agent tab the panel opens first. Pure; no vscode import.

function detectHost(appName) {
  const name = String(appName || '').toLowerCase();
  if (/antigravity/.test(name)) return 'antigravity';
  if (/cursor/.test(name)) return 'cursor';
  if (/devin/.test(name)) return 'devin';
  if (/windsurf/.test(name)) return 'windsurf';
  if (/vscodium|visual studio code|\bvs ?code\b|\bcode\b/.test(name)) return 'vscode';
  return 'other';
}

// Devin and Windsurf keep no readable local transcripts (Devin sessions run in the cloud; Windsurf's
// Cascade files are encrypted), so in those editors the panel falls back to Claude.
const OWN = { antigravity: 'antigravity', cursor: 'cursor' };

function defaultSource(host, availableSourceIds, { claudeInstalled } = {}) {
  const ids = Array.isArray(availableSourceIds) ? availableSourceIds : [];
  const own = OWN[host];
  if (own && ids.includes(own)) return own;
  if (claudeInstalled || ids.includes('claude')) return 'claude';
  return ids.length ? ids[0] : 'all';
}

module.exports = { detectHost, defaultSource };
