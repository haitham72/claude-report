'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { querySqlite, sqliteAvailable } = require('../src/sqlite-read');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* Node 20 */ }

test('reads in-process and through the system node with the same rows', { skip: !sqlite || !sqliteAvailable() }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlr-')), 'x.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec("CREATE TABLE kv (key TEXT, value BLOB); INSERT INTO kv VALUES ('a', CAST('{\"n\":1}' AS BLOB)), ('b', CAST('{\"n\":2}' AS BLOB));");
  db.close();
  const sql = "SELECT key, json_extract(CAST(value AS TEXT), '$.n') AS n FROM kv WHERE key LIKE ? ORDER BY key";
  const inProc = querySqlite(file, sql, ['%']);
  const child = querySqlite(file, sql, ['%'], { forceChild: true });
  assert.deepStrictEqual(inProc, [{ key: 'a', n: 1 }, { key: 'b', n: 2 }]);
  assert.deepStrictEqual(child, inProc);
});

test('a missing database is an error, never an empty success', { skip: !sqliteAvailable() }, () => {
  assert.throws(() => querySqlite(path.join(os.tmpdir(), 'no-such-dir-sqlr', 'x.db'), 'SELECT 1'));
});
