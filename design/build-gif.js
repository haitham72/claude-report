'use strict';

// Records media/marketplace/report.gif: the demo report in a plain window, held at the top, scrolled to the
// projects, one project opened, then scrolled to Advice. Every frame is a headless Chrome screenshot, so the
// motion is deterministic. Needs design/demo-report.html (run `DEMO=1 node design/build-preview.js` first),
// Chrome or Edge, and ffmpeg on PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const W = 820, H = 540, SCALE = 1.5, FPS = 12;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome or Edge not found');

const here = __dirname;
const report = path.join(here, 'demo-report.html');
if (!fs.existsSync(report)) throw new Error('Run DEMO=1 node design/build-preview.js first');

// The report reads its frame from the hash: scroll from one section to another by t, optionally with the first project open.
const driver = `<style>html{scrollbar-width:none}::-webkit-scrollbar{display:none}*{transition:none!important;animation:none!important}</style><script>(function () {
  document.documentElement.setAttribute('data-theme', 'dark');
  var t = document.getElementById('theme'); if (t) t.value = 'dark';
  var q = new URLSearchParams(location.hash.slice(1));
  if (q.get('open') === '1') { var d = document.querySelector('#projects details.proj'); if (d) d.open = true; }
  var nav = document.querySelector('nav.sections');
  var at = function (id) { if (id === 'top') return 0; var el = document.getElementById(id); return el ? el.getBoundingClientRect().top + scrollY - (nav ? nav.offsetHeight : 0) - 12 : 0; };
  var k = +q.get('t') || 0, e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  scrollTo(0, at(q.get('from') || 'top') + (at(q.get('to') || 'top') - at(q.get('from') || 'top')) * e);
})();</script>`;
const html = fs.readFileSync(report, 'utf8');
const end = html.lastIndexOf('</html>');
fs.writeFileSync(path.join(here, 'gif-report.html'), html.slice(0, end) + driver + html.slice(end));

fs.writeFileSync(path.join(here, 'gif-frame.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${W}"><title>Report GIF frame</title><style>
*{box-sizing:border-box;margin:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#111113}
.win{position:absolute;left:28px;top:24px;right:28px;bottom:0;border:1px solid #2c2c31;border-bottom:0;border-radius:14px 14px 0 0;overflow:hidden;background:#0e0e10}
.bar{height:30px;display:flex;align-items:center;gap:7px;padding-left:14px;background:#18181b;border-bottom:1px solid #2c2c31}.bar i{width:10px;height:10px;border-radius:50%;background:#3a3a3c}
iframe{display:block;width:100%;height:calc(100% - 30px);border:0}</style></head>
<body><div class="win"><div class="bar"><i></i><i></i><i></i></div><iframe id="f"></iframe></div>
<script>document.getElementById('f').src = 'gif-report.html' + location.hash;</script></body></html>`);

// [seconds, from, to, open]: holds have from === to.
const SCRIPT = [[1.6, 'top', 'top', 0], [1.8, 'top', 'projects', 0], [0.6, 'projects', 'projects', 0], [2.2, 'projects', 'projects', 1], [1.8, 'projects', 'advice', 1], [2.4, 'advice', 'advice', 1]];
const frames = [];
for (const [sec, from, to, open] of SCRIPT) {
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) frames.push(from === to ? { from, to, t: 0, open } : { from, to, t: i / (n - 1), open });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gif-'));
const url = (f) => 'file:///' + path.join(here, 'gif-frame.html').replace(/\\/g, '/') + `#from=${f.from}&to=${f.to}&t=${f.t.toFixed(4)}&open=${f.open}`;
const shoot = (f, i, slot) => new Promise((resolve, reject) => execFile(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
  `--force-device-scale-factor=${SCALE}`, `--window-size=${W},${H}`, '--virtual-time-budget=1500', `--user-data-dir=${path.join(dir, 'p' + slot)}`,
  `--screenshot=${path.join(dir, String(i).padStart(4, '0') + '.png')}`, url(f)], (err) => err ? reject(err) : resolve()));

(async () => {
  // Identical held frames are shot once and copied.
  const key = (f) => `${f.from}|${f.to}|${f.t.toFixed(4)}|${f.open}`;
  const first = new Map();
  const todo = frames.map((f, i) => ({ f, i })).filter(({ f, i }) => !first.has(key(f)) && first.set(key(f), i));
  for (let k = 0; k < todo.length; k += 4) await Promise.all(todo.slice(k, k + 4).map(({ f, i }, slot) => shoot(f, i, slot)));
  frames.forEach((f, i) => { const src = first.get(key(f)); if (src !== i) fs.copyFileSync(path.join(dir, String(src).padStart(4, '0') + '.png'), path.join(dir, String(i).padStart(4, '0') + '.png')); });
  const out = path.join(here, '..', 'media', 'marketplace', 'report.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`written media/marketplace/report.gif (${frames.length} frames, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
})();
