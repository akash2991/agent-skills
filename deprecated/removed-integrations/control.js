'use strict';
// Runtime control of live agents through Herdr (https://herdr.dev, Apache-2.0). Herdr owns the real
// agent terminals; this module only maps an agent's `runtime`/`runtime_ref` binding in the control
// plane onto Herdr's CLI operations. Focus is read-only; steering a blocked agent can be refused by
// Herdr; interrupt and stop require explicit confirmation, and stop closes the agent's pane, which
// terminates every process in it. Stopping a whole Herdr session stays a manual, separately
// authorized operation.
const { spawnSync } = require('node:child_process');

const UNKNOWN = 'UNKNOWN';

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
}

function controlAgent(agent, control, run = defaultRun) {
  if (agent.runtime !== 'herdr' || !agent.runtime_ref || agent.runtime_ref === UNKNOWN) {
    throw new Error(`${agent.agent_id} has no Herdr runtime binding`);
  }
  let args;
  if (control.action === 'focus') args = ['agent', 'focus', agent.runtime_ref];
  else if (control.action === 'steer') {
    if (!control.text) throw new Error('steer requires text');
    args = ['agent', 'prompt', agent.runtime_ref, control.text];
  } else if (control.action === 'interrupt') {
    if (!control.confirm) throw new Error('interrupt requires --confirm');
    args = ['agent', 'send-keys', agent.runtime_ref, 'ctrl+c'];
  } else if (control.action === 'stop') {
    if (!control.confirm) throw new Error('stop requires --confirm');
    let paneId = /^w[^:]+:p[^:]+$/.test(agent.runtime_ref) ? agent.runtime_ref : '';
    if (!paneId) {
      const lookup = run('herdr', ['agent', 'get', agent.runtime_ref]);
      if (lookup.error) throw lookup.error;
      if (lookup.status !== 0) throw new Error((lookup.stderr || lookup.stdout || `herdr exited ${lookup.status}`).trim());
      let parsed;
      try { parsed = JSON.parse(lookup.stdout); }
      catch { throw new Error('Herdr agent lookup did not return JSON'); }
      paneId = parsed?.result?.agent?.pane_id || parsed?.agent?.pane_id || '';
      if (!paneId) throw new Error('Herdr agent lookup did not include pane_id');
    }
    args = ['pane', 'close', paneId];
  } else throw new Error(`unsupported control action "${control.action}"`);

  const result = run('herdr', args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `herdr exited ${result.status}`).trim());
  return { action: control.action, target: agent.agent_id, runtime_ref: agent.runtime_ref, stdout: (result.stdout || '').trim() };
}

module.exports = { controlAgent, defaultRun };
