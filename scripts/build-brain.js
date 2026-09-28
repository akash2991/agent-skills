#!/usr/bin/env node
'use strict';

const path = require('path');
const { buildBrain } = require('./lib/build-brain');

function usage() {
  console.log('Usage: node scripts/build-brain.js [--out <dir>]');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const outIdx = args.indexOf('--out');
if (outIdx !== -1 && (!args[outIdx + 1] || args[outIdx + 1].startsWith('-'))) {
  console.error('missing value for --out');
  process.exit(2);
}
const allowed = new Set(['--out']);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') { i++; continue; }
  if (args[i].startsWith('-') || !allowed.has(args[i])) {
    console.error(`unknown argument: ${args[i]}`);
    usage();
    process.exit(2);
  }
}

try {
  const out = outIdx === -1 ? undefined : path.resolve(args[outIdx + 1]);
  const result = buildBrain({ out });
  console.log(`built ${result.out}: ${result.skills} skills, ${result.personas} personas`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
