'use strict';

// Optional, explicit user-level bootstrap for old Git worktree bases. It never
// traces unrelated projects or loads project code before native project trust.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const GUARD = Symbol.for('agent-brain.observability.controller');

// undefined means no declaration; null means an explicit refusal (including
// unreadable/invalid declarations). Only absence permits principal fallback.
function runtimeAt(root) {
  const marker = path.join(root, '.agent-brain', 'tracing.json');
  let stat;
  try { stat = fs.lstatSync(marker); }
  catch (error) { return error.code === 'ENOENT' ? undefined : null; }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const config = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (config.schema !== 1 || config.enabled !== true || config.captureMode !== 'metadata-only') return null;
    if (config.runtime !== undefined && !['.agent-brain/observability', 'runtime/langfuse'].includes(config.runtime)) return null;
    const entry = path.join(root, config.runtime || '.agent-brain/observability', 'pi.js');
    return fs.statSync(entry).isFile() ? entry : null;
  } catch { return null; }
}

// Read-only lookup before project factories run: no subprocess, timer or
// project-code execution. Git worktree files identify the principal .git dir.
function findRuntimeSync(cwd) {
  let root;
  try { root = fs.realpathSync(cwd); } catch { return null; }
  while (true) {
    const direct = runtimeAt(root);
    if (direct !== undefined) return direct;
    try {
      const git = path.join(root, '.git');
      const stat = fs.lstatSync(git);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096) {
        const match = /^gitdir: ([^\r\n]+)\s*$/.exec(fs.readFileSync(git, 'utf8'));
        if (match) {
          const gitdir = path.resolve(root, match[1]);
          const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
          if (path.basename(common) === '.git') return runtimeAt(path.dirname(common)) || null;
        }
      }
      if (stat.isDirectory()) return null;
    } catch { /* Continue to a parent directory. */ }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

function findRuntime(cwd, git = execFileSync) {
  let start;
  try { start = fs.realpathSync(cwd); } catch { return null; }
  const candidates = [start];
  let current;
  try {
    const top = git('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) {
      const root = fs.realpathSync(top);
      // Check declarations from most to least specific, stopping at this Git
      // root. A nested refusal must beat both root opt-in and principal fallback.
      const relative = path.relative(root, start);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        current = root;
        for (let ancestor = start; ancestor !== root;) {
          ancestor = path.dirname(ancestor);
          candidates.push(ancestor);
        }
      }
    }
  } catch { /* Non-Git directories require their own explicit opt-in marker. */ }
  for (const root of candidates) {
    const entry = runtimeAt(root);
    if (entry !== undefined) return entry;
  }
  if (!current) return null;
  // Resolve the principal only after the current project's declaration has
  // been checked, even when invoked below its root.
  try {
    const output = git('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const principal = output.split('\n').find(line => line.startsWith('worktree '));
    if (principal) return runtimeAt(principal.slice(9)) || null;
  } catch { /* No principal fallback available. */ }
  return null;
}

module.exports = function brainWorktreeBootstrap(pi) {
  // In opted-in projects only, prevent the known legacy Pi plugin from
  // enabling itself during factory loading. Restore the user's actual setting
  // before the first-party adapter starts; unrelated projects are untouched.
  const optedIn = findRuntimeSync(process.cwd());
  const suppressionKey = Symbol.for('agent-brain.observability.legacy-suppression');
  const previous = globalThis[suppressionKey];
  const original = previous?.active ? previous.original : process.env.LANGFUSE_TRACING_ENABLED;
  if (optedIn) {
    globalThis[suppressionKey] = { active: true, original };
    process.env.LANGFUSE_TRACING_ENABLED = 'false';
    // Register the narrow tool schema early enough for native --tools
    // validation, but execute no project code until trust/startup completes.
    if (pi.registerTool) {
      const proxyKey = Symbol.for('agent-brain.observability.context-tool-proxy');
      const proxyOwner = {};
      globalThis[proxyKey] = proxyOwner;
      pi.on('session_shutdown', () => { if (globalThis[proxyKey] === proxyOwner) delete globalThis[proxyKey]; });
      pi.registerTool({ name: 'brain_context', label: 'Brain context',
      description: 'Set or query non-secret brain persona/ticket context in this opted-in project.',
      parameters: { type: 'object', properties: { persona: { type: 'string' }, ticketId: { type: 'string' } }, additionalProperties: false },
      execute: async (...args) => {
        const ctx = args[4];
        if (!ctx || typeof ctx.isProjectTrusted !== 'function' || !ctx.isProjectTrusted()) return { content: [{ type: 'text', text: 'Brain tracing requires project trust.' }], details: undefined };
        const tool = globalThis[GUARD]?.controller?.getContextTool?.();
        return tool ? tool.execute(...args) : { content: [{ type: 'text', text: 'Brain tracing is unavailable.' }], details: undefined };
      } });
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    if (optedIn) {
      if (original === undefined) delete process.env.LANGFUSE_TRACING_ENABLED;
      else process.env.LANGFUSE_TRACING_ENABLED = original;
      delete globalThis[suppressionKey];
    }
    try {
      if (globalThis[GUARD] || typeof ctx.isProjectTrusted !== 'function' || !ctx.isProjectTrusted()) return;
      const entry = findRuntime(ctx.cwd);
      if (!entry) return;
      // Requiring executable project code is delayed until the trust check.
      const factory = require(entry);
      const controller = (factory.default || factory)(pi);
      await controller?.start?.(ctx);
    } catch {
      if (ctx.hasUI) ctx.ui.setStatus('brain-tracing', 'brain tracing: bootstrap unavailable; no content exported');
    }
  });
};
module.exports.findRuntime = findRuntime;
module.exports.findRuntimeSync = findRuntimeSync;
