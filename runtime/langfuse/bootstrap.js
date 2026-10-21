'use strict';

// Optional, explicit user-level bootstrap for old Git worktree bases. It never
// traces unrelated projects or loads project code before native project trust.
const fs = require('node:fs');
const path = require('node:path');
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
function findPolicySync(cwd) {
  let root;
  try { root = fs.realpathSync(cwd); } catch { return null; }
  while (true) {
    const direct = runtimeAt(root);
    if (direct !== undefined) return direct;
    let stat;
    const git = path.join(root, '.git');
    try { stat = fs.lstatSync(git); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    if (stat) {
      if (stat.isDirectory() && !stat.isSymbolicLink()) return undefined;
      try {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 4096) return null;
        const match = /^gitdir: ([^\r\n]+)\s*$/.exec(fs.readFileSync(git, 'utf8'));
        if (!match) return null;
        const gitdir = path.resolve(root, match[1]);
        let commonDir;
        try { commonDir = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim(); }
        catch (error) {
          // Submodules/separate Git dirs need not have a principal checkout.
          // No declaration there is absence, not a project tracing refusal.
          return error.code === 'ENOENT' ? undefined : null;
        }
        if (!commonDir) return null;
        const common = path.resolve(gitdir, commonDir);
        return path.basename(common) === '.git' ? runtimeAt(path.dirname(common)) : undefined;
      } catch { return null; } // Never cross an unreadable/invalid Git boundary.
    }
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

// Discovery and direct loading share exactly the same cwd-sensitive tri-state
// policy. Resource registration (including -e) is not itself authorization.
function findRuntimeSync(cwd) { return findPolicySync(cwd) || null; }
function findRuntime(cwd) { return findRuntimeSync(cwd); }

function isTracingAllowed(ctx, { perRun = false, enabled = true } = {}) {
  try {
    if (!enabled || typeof ctx?.isProjectTrusted !== 'function' || !ctx.isProjectTrusted()) return false;
    const suppression = globalThis[Symbol.for('agent-brain.observability.legacy-suppression')];
    const legacy = suppression?.active ? suppression.original : process.env.LANGFUSE_TRACING_ENABLED;
    if ([process.env.BRAIN_TRACING_ENABLED, legacy].some(value => ['false', '0'].includes(String(value || '').toLowerCase()))) return false;
    const declaration = findPolicySync(ctx.cwd);
    return declaration !== null && (declaration !== undefined || perRun === true);
  } catch { return false; }
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
      if (globalThis[GUARD] || !isTracingAllowed(ctx)) return;
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
module.exports.findPolicySync = findPolicySync;
module.exports.isTracingAllowed = isTracingAllowed;
