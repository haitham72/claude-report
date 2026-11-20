'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeLive, readLive, readHistory } = require('../src/live');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const NOW = 1_800_000_000_000;
const status = (o = {}) => ({
  session_id: 's1', cwd: '/proj/a', model: { display_name: 'Opus', id: 'x' },
  context_window: { used_percentage: 12 },
  rate_limits: { five_hour: { used_percentage: 30, resets_at: NOW / 1000 + 3600 }, seven_day: { used_percentage: 40, resets_at: NOW / 1000 + 86400 } },
  prompt: 'secret', transcript_path: '/secret', ...o,
});

test('round trip stores only the allow-list', () => {
  const dir = tmp();
  writeLive(status(), { dir, now: NOW });
  const s = readLive({ dir, now: NOW });
  assert.deepStrictEqual(Object.keys(s).sort(), ['ctxPct', 'cwd', 'fiveHour', 'model', 'sessionId', 'sevenDay', 'stale', 'updatedAt']);
  assert.strictEqual(s.model, 'Opus');
  assert.strictEqual(s.ctxPct, 12);
  assert.strictEqual(s.fiveHour.pct, 30);
  assert.strictEqual(s.stale, false);
  const raw = fs.readFileSync(path.join(dir, 'live', 's1.json'), 'utf8');
  assert.ok(!raw.includes('secret'));
});

test('no session_id is ignored; id is sanitised', () => {
  const dir = tmp();
  assert.strictEqual(writeLive({ cwd: 'x' }, { dir }), null);
  writeLive(status({ session_id: '../a b' }), { dir, now: NOW });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'live')), ['___a_b.json']);
});

test('stale flag and expired windows', () => {
  const dir = tmp();
  writeLive(status({ rate_limits: { five_hour: { used_percentage: 30, resets_at: NOW / 1000 + 60 }, seven_day: { used_percentage: 5, resets_at: NOW / 1000 + 86400 } } }), { dir, now: NOW });
  const later = NOW + 11 * 60 * 1000;
  const s = readLive({ dir, now: later });
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.fiveHour, null);
  assert.strictEqual(s.sevenDay.pct, 5);
  const account = readLive({ dir, now: NOW + 7 * 3600 * 1000 });
  assert.strictEqual(account.stale, true);
  assert.strictEqual(account.sevenDay.pct, 5);
  assert.strictEqual(account.model, undefined);
  assert.strictEqual(readLive({ dir, now: NOW + 24 * 3600 * 1000 }), null);
});

test('prefers the snapshot matching cwd, else freshest', () => {
  const dir = tmp();
  writeLive(status({ session_id: 'a', cwd: 'C:\\Proj\\A' }), { dir, now: NOW });
  writeLive(status({ session_id: 'b', cwd: '/other' }), { dir, now: NOW + 1000 });
  assert.strictEqual(readLive({ dir, now: NOW + 2000 }).sessionId, 'b');
  assert.strictEqual(readLive({ dir, now: NOW + 2000, cwd: '/nowhere' }).sessionId, 'b');
  const same = process.platform === 'win32' ? 'c:/proj/a/' : 'C:\\Proj\\A';
  assert.strictEqual(readLive({ dir, now: NOW + 2000, cwd: same }).sessionId, 'a');
});

test('the workspace selects the model but the account gets the freshest plan usage', () => {
  const dir = tmp();
  writeLive(status({ session_id: 'a', cwd: '/a', model: { display_name: 'Opus' } }), { dir, now: NOW });
  writeLive(status({ session_id: 'b', cwd: '/b', model: { display_name: 'Haiku' }, rate_limits: {
    five_hour: { used_percentage: 50, resets_at: NOW / 1000 + 3600 }
  } }), { dir, now: NOW + 1000 });
  const snap = readLive({ dir, cwd: '/a', now: NOW + 1000 });
  assert.strictEqual(snap.model, 'Opus');
  assert.strictEqual(snap.fiveHour.pct, 50);
  assert.strictEqual(snap.fiveHour.seenAt, NOW + 1000);
  assert.strictEqual(snap.sevenDay.pct, 40);
});

test('corrupt files are skipped', () => {
  const dir = tmp();
  writeLive(status(), { dir, now: NOW });
  fs.writeFileSync(path.join(dir, 'live', 'bad.json'), '{nope');
  assert.strictEqual(readLive({ dir, now: NOW }).sessionId, 's1');
  assert.strictEqual(readLive({ dir: tmp() }), null);
});

test('plan windows survive a restart: a reading without them falls back to the last good ones until they reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-'));
  const t0 = 1_800_000_000_000;
  const resetsAt = Math.floor(t0 / 1000) + 7200;
  writeLive({ session_id: 's1', model: { display_name: 'M' }, rate_limits: { five_hour: { used_percentage: 61, resets_at: resetsAt }, seven_day: { used_percentage: 35, resets_at: resetsAt + 100000 } } }, { dir, now: t0 });
  writeLive({ session_id: 's1', model: { display_name: 'M' }, context_window: { used_percentage: 5 } }, { dir, now: t0 + 60000 });
  const live = readLive({ dir, now: t0 + 120000 });
  assert.strictEqual(live.fiveHour.pct, 61);
  assert.strictEqual(live.sevenDay.pct, 35);
  assert.strictEqual(live.fiveHour.seenAt, t0);
  writeLive({ session_id: 's1', model: { display_name: 'M' } }, { dir, now: (resetsAt + 10) * 1000 });
  const reset = readLive({ dir, now: (resetsAt + 20) * 1000 });
  assert.strictEqual(reset.fiveHour, null, 'a window that has reset is not shown');
  assert.strictEqual(reset.sevenDay.pct, 35);
});

test('history keeps samples over the week, even during frequent readings, and records rotations', () => {
  const dir = tmp();
  const day = 86400000;
  const file = path.join(dir, 'usage-history.json');
  fs.writeFileSync(file, JSON.stringify([{ t: NOW - 9 * day, s: 4 }, { t: NOW - 6 * day, w: 12 }]));
  for (let i = 0; i <= 6; i++) writeLive(status(), { dir, now: NOW + i * 60000 });
  const next = status({ rate_limits: { five_hour: { used_percentage: 1, resets_at: NOW / 1000 + 7200 } } });
  writeLive(next, { dir, now: NOW + 390000 });
  const history = readHistory({ dir });
  assert.deepStrictEqual(history.map((entry) => entry.t), [NOW - 6 * day, NOW, NOW + 240000, NOW + 300000, NOW + 360000, NOW + 390000]);
  assert.strictEqual(history.at(-1).sr, NOW / 1000 + 7200);
  assert.strictEqual(history.at(-2).wr, NOW / 1000 + 86400);
});
