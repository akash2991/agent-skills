#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { findRuntime } = require('./bootstrap.js');

async function main(argv, options = {}) {
  const [command, ...args] = argv;
  if (!['context', 'launch'].includes(command)) throw new Error('Usage: brain-trace.cjs context status|set ... | launch ...');
  const entry = (options.findRuntime || findRuntime)(options.cwd || process.cwd());
  if (!entry) throw new Error('No opted-in brain runtime found');
  const dir = path.dirname(entry);
  if (command === 'context') return require(path.join(dir, 'context-cli.cjs')).runContext(args, options);
  return require(path.join(dir, 'launch.cjs')).launch(args, options);
}
if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('Usage: brain-trace.cjs context status|set [--persona name] [--ticket TEAM-123]\n       brain-trace.cjs launch --pane ID --harness pi|claude --name NAME [--cwd PATH] [--model ID] [--effort LEVEL] [--persona NAME] [--ticket TEAM-123]');
  } else {
    main(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result?.status && result.status !== 'adapter-started') process.exitCode = 1; })
      .catch(() => { console.error('Brain tracing operation unavailable or invalid; no context was guessed.'); process.exitCode = 1; });
  }
}
module.exports = { main };
