'use strict';

// Read-only SQLite queries for other agents' local stores (Antigravity, Cursor).
// Uses node:sqlite in-process when the runtime has it (Node 22.13+, 24). Editors that ship an
// older runtime run the same query in the system `node` instead. Without either, callers get
// an error and must treat the source as absent. Select only scalar columns (CAST blobs AS TEXT,
// json_extract what you need): rows cross a process boundary as JSON.
const { execFileSync } = require('child_process');

let mod;
function inProcess() {
  if (mod === undefined) {
    try { mod = require('node:sqlite'); } catch { mod = null; }
  }
  return mod;
}

const CHILD = "const{DatabaseSync}=require('node:sqlite');const[f,s,p]=JSON.parse(require('fs').readFileSync(0,'utf8'));" +
  "const d=new DatabaseSync(f,{readOnly:true});try{d.exec('PRAGMA busy_timeout = 5000');process.stdout.write(JSON.stringify(d.prepare(s).all(...p)))}finally{d.close()}";

function querySqlite(file, sql, params = [], { nodePath = 'node', timeout = 30000, forceChild = false } = {}) {
  const m = forceChild ? null : inProcess();
  if (m) {
    const db = new m.DatabaseSync(file, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(sql).all(...params).map((row) => ({ ...row })); } finally { db.close(); }
  }
  const out = execFileSync(nodePath, ['-e', CHILD], {
    input: JSON.stringify([file, sql, params]), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    timeout, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
  });
  return JSON.parse(out);
}

// True when a query can run one way or the other. Cached per process.
let available;
function sqliteAvailable({ nodePath = 'node' } = {}) {
  if (available !== undefined) return available;
  if (inProcess()) return (available = true);
  try {
    execFileSync(nodePath, ['-e', "require('node:sqlite')"], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
    available = true;
  } catch { available = false; }
  return available;
}

module.exports = { querySqlite, sqliteAvailable };
