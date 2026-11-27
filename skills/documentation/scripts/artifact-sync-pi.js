'use strict';

// Pi extension: when an agent finishes, hand off to artifact-sync.js hook (documentation W12) and return at once.
// The Claude Code equivalent is the Stop and SubagentStop hooks in .claude/settings.json.

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'artifact-sync.js');

module.exports = function artifactSync(pi) {
  pi.on('agent_end', async (_event, ctx) => {
    if (process.env.BRAIN_ARTIFACT_SYNC) return undefined;
    try {
      spawn(process.execPath, [SCRIPT, 'hook', '--cwd', (ctx && ctx.cwd) || process.cwd()], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* a hook never fails the agent */ }
    return undefined;
  });
};
