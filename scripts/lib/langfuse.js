'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Official integration, pinned because its trace schema is experimental.
const LANGFUSE_PACKAGE = 'npm:@langfuse/pi-observability-plugin@0.1.2';

function preflightLangfuse(target, run = spawnSync) {
  // Pi owns settings, not the brain's replace/prune manifest. Refuse unsafe
  // destinations before delegating to its native package installer.
  for (const [rel, directory] of [['.pi', true], ['.pi/settings.json', false]]) {
    const abs = path.join(target, rel);
    let stat;
    try { stat = fs.lstatSync(abs); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Langfuse setup refused unsafe path: ${rel}`);
    }
  }
  const settings = path.join(target, '.pi/settings.json');
  if (fs.existsSync(settings)) {
    let value;
    try { value = JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Pi settings must contain valid JSON (contents omitted for privacy)'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi settings must be a JSON object');
    if (value.packages !== undefined && !Array.isArray(value.packages)) throw new Error('Pi settings packages must be an array');
  }
  const result = run('pi', ['--version'], { cwd: target, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) {
    throw new Error('--langfuse requires Pi on PATH. Install Pi first; no brain files were changed.');
  }
}

function installLangfuse(target, run = spawnSync) {
  // No shell, no key arguments, no credential/config copying, no trust grant.
  const result = run('pi', ['install', '--local', LANGFUSE_PACKAGE], {
    cwd: target, encoding: 'utf8', timeout: 120000
  });
  if (result.error || result.status !== 0) {
    // Never echo third-party stdout/stderr: it may contain local configuration.
    const trustHint = (result.stderr || '').includes('Project is not trusted')
      ? ' Pi requires project trust: review the installed resources, start Pi and make your trust decision, then retry.'
      : '';
    throw new Error(`Brain files installed, but Langfuse package setup failed.${trustHint} Retry in the target repo: pi install --local ${LANGFUSE_PACKAGE}`);
  }
  return `Langfuse: registered ${LANGFUSE_PACKAGE} in project Pi settings.\nStart a new trusted Pi session with Langfuse credentials configured. Registration is not proof of trace delivery.\nPrivacy: prompts, outputs, tool arguments/results and images are sent to Langfuse; arbitrary secrets are not automatically masked.\nDisable for a run with LANGFUSE_TRACING_ENABLED=false.`;
}

module.exports = { LANGFUSE_PACKAGE, preflightLangfuse, installLangfuse };
