'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectHost, defaultSource } = require('../src/host');

test('detectHost', () => {
  const rows = [
    ['Visual Studio Code', 'vscode'], ['Visual Studio Code - Insiders', 'vscode'], ['VSCodium', 'vscode'],
    ['Cursor', 'cursor'], ['cursor', 'cursor'], ['Antigravity', 'antigravity'], ['Antigravity IDE', 'antigravity'],
    ['Devin', 'devin'], ['DEVIN', 'devin'], ['Windsurf', 'windsurf'], ['Windsurf - Next', 'windsurf'],
    ['Eclipse Theia', 'other'], ['', 'other'], [undefined, 'other'], [null, 'other']
  ];
  for (const [name, want] of rows) assert.strictEqual(detectHost(name), want, String(name));
});

test('defaultSource', () => {
  const rows = [
    ['antigravity', ['claude', 'antigravity'], true, 'antigravity'],
    ['cursor', ['claude', 'cursor'], true, 'cursor'],
    ['devin', ['codex', 'claude'], false, 'claude'],
    ['windsurf', ['codex'], false, 'codex'],
    ['cursor', ['claude', 'codex'], false, 'claude'],
    ['cursor', ['codex'], true, 'claude'],
    ['vscode', ['codex', 'cursor'], false, 'codex'],
    ['vscode', ['codex', 'claude'], false, 'claude'],
    ['other', [], false, 'all'],
    ['devin', [], true, 'claude']
  ];
  for (const [host, ids, claudeInstalled, want] of rows) {
    assert.strictEqual(defaultSource(host, ids, { claudeInstalled }), want, `${host} ${ids}`);
  }
  assert.strictEqual(defaultSource('vscode', undefined, {}), 'all');
});
