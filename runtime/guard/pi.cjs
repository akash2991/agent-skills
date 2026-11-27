'use strict';

// Pi extension for the branch guard (guard.cjs): it blocks a `bash` tool call the guard refuses, and one the guard
// fails on while checking.

const { checkCommand } = require('./guard.cjs');

module.exports = function branchGuard(pi) {
  pi.on('tool_call', event => {
    if (!event || event.toolName !== 'bash') return undefined;
    const command = event.input ? event.input.command : undefined;
    if (typeof command !== 'string') return undefined;
    let refusal;
    try { refusal = checkCommand(command); } catch (error) {
      refusal = `Blocked by the branch guard (FAC-47): it failed while checking this command (${error.message}).`;
    }
    return refusal ? { block: true, reason: refusal } : undefined;
  });
};
