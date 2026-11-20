'use strict';

// What the bottom status bar shows, as plain data so it can be tested without VS Code.
// Each gauge is a ring glyph item (coloured by how full the window is) next to a
// plain label item: VS Code gives one colour per item, so the two are separate.
const RING = ['○', '◔', '◑', '◕', '●'];
const ring = (pct) => RING[Math.min(4, Math.round(Math.max(0, pct) / 25))];
const COLORS = { ok: '#34c759', mid: '#ff9f0a', hot: '#ff453a' };
const levelColor = (pct) => (pct >= 80 ? COLORS.hot : pct >= 50 ? COLORS.mid : COLORS.ok);

const resets = (w) => {
  if (!w || !w.resetsAt) return '';
  const seen = w.seenAt && Date.now() - w.seenAt > 10 * 60 * 1000 ? `, last seen ${Math.round((Date.now() - w.seenAt) / 60000)} min ago` : '';
  return `resets ${new Date(w.resetsAt * 1000).toLocaleString()}${seen}`;
};

function statusItems(live, commands) {
  if (!live) {
    return [{ text: '$(plug) Claude Report', command: commands.connect, tooltip: 'Connect Claude Code to see model, context and plan usage here' }];
  }
  const items = [];
  const open = commands.open;
  if (live.model) {
    items.push({ text: `${live.stale ? '$(clock) ' : ''}${live.model}`, command: open, tooltip: live.stale ? 'No update for 10+ minutes' : 'Current Claude Code model' });
  }
  const gauge = (label, w) => {
    if (!w) return;
    const pct = Math.round(w.pct);
    items.push({ text: ring(w.pct), color: levelColor(w.pct), command: open, tooltip: `${label} usage ${pct}% ${resets(w)}`.trim() });
    items.push({ text: `${label} ${pct}%`, command: open, tooltip: resets(w) });
  };
  gauge('5h', live.fiveHour);
  gauge('7d', live.sevenDay);
  if (live.ctxPct != null) {
    items.push({ text: `ctx ${Math.round(live.ctxPct)}%`, color: live.ctxPct >= 80 ? COLORS.hot : undefined, command: open, tooltip: 'Context window used' });
  }
  return items;
}

module.exports = { statusItems, ring, levelColor, COLORS, MAX_ITEMS: 6 };
