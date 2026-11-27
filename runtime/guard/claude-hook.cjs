#!/usr/bin/env node
'use strict';

// Claude Code PreToolUse hook for the branch guard (guard.cjs). It reads the tool call from stdin and denies a
// command the guard refuses. Anything it cannot read is denied too, and the registered command ends in
// `|| exit 2`, so a missing or crashing hook blocks the call instead of letting it through.

const { checkCommand } = require('./guard.cjs');

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let command;
  try {
    const event = JSON.parse(input);
    command = event && event.tool_input ? event.tool_input.command : undefined;
  } catch (error) {
    deny(`Blocked by the branch guard (FAC-47): it could not read this tool call (${error.message}).`);
  }
  if (typeof command !== 'string') process.exit(0);
  let refusal;
  try { refusal = checkCommand(command); } catch (error) {
    deny(`Blocked by the branch guard (FAC-47): it failed while checking this command (${error.message}).`);
  }
  if (refusal) deny(refusal);
  process.exit(0);
});
