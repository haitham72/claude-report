#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scanMonth, human } = require('./scan');

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd !== 'scan') {
    console.log('usage: claude-report scan [YYYY-MM]');
    process.exit(cmd ? 1 : 0);
  }
  const month = arg || currentMonth();
  const projects = scanMonth(month);
  const dir = path.join(__dirname, '..', 'out', month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ month, projects }, null, 2));

  console.log(`By project — ${month}`);
  for (const p of projects) {
    console.log(`${p.name.padEnd(28)} ${human(p.totalTokens).padStart(8)}  ${p.sessions} sessions, ${p.promptCount} prompts`);
  }
  console.log(`\nwritten: out/${month}/data.json`);
}

main();
