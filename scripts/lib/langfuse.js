'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Official integration, pinned because its trace schema is experimental.
const LANGFUSE_PACKAGE = 'npm:@langfuse/pi-observability-plugin@0.1.2';
const CLAUDE_PLUGIN = 'langfuse-observability@langfuse-observability';
const CLAUDE_VERSION = '1.2.1';
const CLAUDE_MARKETPLACE = `langfuse/Claude-Observability-Plugin#v${CLAUDE_VERSION}`;

function preflightLangfuse(target, run = spawnSync) {
  // Harnesses own settings, not the brain's replace/prune manifest. Refuse
  // unsafe destinations before delegating to their native package installers.
  for (const [rel, directory] of [['.pi', true], ['.pi/settings.json', false], ['.claude', true], ['.claude/settings.json', false]]) {
    const abs = path.join(target, rel);
    let stat;
    try { stat = fs.lstatSync(abs); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Langfuse setup refused unsafe path: ${rel}`);
    }
  }
  for (const harness of ['.pi', '.claude']) {
    const settings = path.join(target, harness, 'settings.json');
    if (!fs.existsSync(settings)) continue;
    let value;
    try { value = JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error(`${harness} settings must contain valid JSON (contents omitted for privacy)`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${harness} settings must be a JSON object`);
    if (harness === '.pi' && value.packages !== undefined && !Array.isArray(value.packages)) throw new Error('Pi settings packages must be an array');
    if (harness === '.claude') {
      for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
        if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
          throw new Error(`Claude settings ${key} must be a JSON object`);
        }
      }
    }
  }
  const opts = { cwd: target, encoding: 'utf8', timeout: 10000 };
  for (const [command, label] of [['pi', 'Pi'], ['claude', 'Claude Code']]) {
    const result = run(command, ['--version'], opts);
    if (result.error || result.status !== 0) {
      throw new Error(`--langfuse requires ${label} on PATH. Install it first; no brain files were changed.`);
    }
  }
  // The official Claude hook uses uv script metadata, or a preinstalled SDK.
  const uv = run('uv', ['--version'], opts);
  if (uv.error || uv.status !== 0) {
    const python = run('python3', ['-c', 'import sys, importlib.metadata as m; v=tuple(map(int,m.version("langfuse").split(".")[:2])); assert sys.version_info >= (3,10) and (4,7) <= v < (5,0)'], opts);
    if (python.error || python.status !== 0) throw new Error('--langfuse requires uv on PATH, or Python 3.10+ with langfuse>=4.7,<5. No brain files were changed.');
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
    throw new Error(`Brain files installed, but Langfuse package setup failed.${trustHint} Retry in the target repo: pi install --local ${LANGFUSE_PACKAGE}, then rerun pull --langfuse to finish both harnesses.`);
  }
  const claudeRun = (args, step) => {
    const result = run('claude', args, { cwd: target, encoding: 'utf8', timeout: 180000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Brain files and Pi tracing installed, but Claude Langfuse ${step} failed. Rerun pull --langfuse after checking Claude's native plugin setup. No credentials were copied.`);
    }
    return result.stdout || '';
  };
  claudeRun(['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE, '--scope', 'project', '--json'], 'marketplace registration');
  // Never install from an unrelated marketplace sharing the official name.
  let marketplaces;
  try { marketplaces = JSON.parse(claudeRun(['plugin', 'marketplace', 'list', '--json'], 'marketplace verification')); }
  catch { throw new Error('Brain and Pi installed, but Claude marketplace verification failed (output omitted). Rerun pull --langfuse after reconciling native plugin setup.'); }
  if (!Array.isArray(marketplaces) || !marketplaces.some(m => m && m.name === 'langfuse-observability'
    && m.source === 'github' && typeof m.repo === 'string' && m.repo.toLowerCase() === 'langfuse/claude-observability-plugin' && m.ref === `v${CLAUDE_VERSION}`)) {
    throw new Error(`Brain and Pi installed, but Claude marketplace identity/version differs from ${CLAUDE_MARKETPLACE}. Reconcile it in Claude before retrying; no Claude plugin was installed by this run.`);
  }
  claudeRun(['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'project', '--json'], 'plugin installation');
  let plugins;
  try { plugins = JSON.parse(claudeRun(['plugin', 'list', '--json'], 'plugin verification')); }
  catch { throw new Error('Brain and Pi installed, but Claude plugin verification failed (output omitted). Check claude plugin list --json.'); }
  const sameProject = project => {
    try { return typeof project === 'string' && fs.realpathSync(project) === fs.realpathSync(target); }
    catch { return false; }
  };
  if (!Array.isArray(plugins) || !plugins.some(p => p && p.id === CLAUDE_PLUGIN && p.scope === 'project'
    && p.version === CLAUDE_VERSION && p.enabled === true && sameProject(p.projectPath))) {
    throw new Error(`Claude Langfuse plugin is not enabled at version ${CLAUDE_VERSION} for this project. Brain/Pi setup remains installed. Review claude plugin list --json and project/local overrides before retrying.`);
  }
  return `Langfuse: registered the official Pi and Claude Code plugins in project settings.\nConfigure credentials separately for each harness and start new trusted sessions. Registration is not proof of trace delivery.\nPrivacy: prompts, outputs, tool arguments/results and images are sent to Langfuse; arbitrary secrets are not automatically masked.\nPi: disable with LANGFUSE_TRACING_ENABLED=false. Claude: claude plugin disable ${CLAUDE_PLUGIN} --scope project.`;
}

module.exports = { LANGFUSE_PACKAGE, CLAUDE_PLUGIN, CLAUDE_VERSION, CLAUDE_MARKETPLACE, preflightLangfuse, installLangfuse };
