'use strict';

// Every activity source the extension reads, in tab order. `plan` marks the one whose
// five-hour and weekly plan limits the Metrics page can show (only Claude reports them).
const SOURCES = [
  { id: 'claude', label: 'Claude', product: 'Claude Code', plan: true },
  { id: 'codex', label: 'Codex', product: 'Codex' },
  { id: 'antigravity', label: 'Antigravity', product: 'Antigravity' },
  { id: 'cursor', label: 'Cursor', product: 'Cursor' },
];

const byId = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
const labelOf = (id) => (byId[id] ? byId[id].label : id);
const productOf = (id) => (byId[id] ? byId[id].product : id);

// "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Cursor".
function productList(ids) {
  const names = [...new Set(ids)].sort((a, b) => order(a) - order(b)).map(productOf);
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
const order = (id) => { const i = SOURCES.findIndex((s) => s.id === id); return i < 0 ? SOURCES.length : i; };

module.exports = { SOURCES, labelOf, productOf, productList };
