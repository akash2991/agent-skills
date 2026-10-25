#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { findRuntime, findPolicySync } = require('./bootstrap.js');

async function main(argv, options = {}) {
  const [command, ...args] = argv;
  if (!['context', 'launch', 'exec'].includes(command)) throw new Error('Usage: brain-trace.cjs context|launch|exec ...');
  const cwd = options.cwd || process.cwd();
  const entry = (options.findRuntime || findRuntime)(cwd) ||
    (args.includes('--actor') && findPolicySync(cwd) === undefined ? path.join(__dirname, 'pi.js') : null);
  if (!entry) throw new Error('No authorized brain runtime found');
  const dir = path.dirname(entry);
  if (command === 'context') return require(path.join(dir, 'context-cli.cjs')).runContext(args, options);
  if (command === 'launch') return require(path.join(dir, 'launch.cjs')).launch(args, options);
  return require(path.join(dir, 'exec.cjs')).exec(args, options);
}
if (require.main === module) {
  if (process.argv[2] === '--help' || (process.argv.length === 4 && process.argv[3] === '--help')) {
    console.log('Usage: brain-trace.cjs context [--actor NONCE] status|set [--persona name] [--ticket TEAM-123]\n       brain-trace.cjs launch [--actor NONCE] --pane ID --harness pi|claude --name NAME [--cwd PATH] [--model ID] [--effort LEVEL] [--persona NAME] [--ticket TEAM-123]\n       brain-trace.cjs exec --actor NONCE --harness pi|claude [--cwd PATH] -- NATIVE_ARGS');
  } else {
    main(process.argv.slice(2)).then(result => {
      if (process.argv[2] === 'exec') { require('./exec.cjs').exitWithResult(result); return; }
      console.log(JSON.stringify(result, null, 2));
      if (result?.status && result.status !== 'adapter-started') process.exitCode = 1;
    })
      .catch(() => { console.error('Brain tracing operation unavailable or invalid; no context was guessed.'); process.exitCode = 1; });
  }
}
module.exports = { main };
