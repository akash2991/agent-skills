'use strict';

// Registers the branch guard (runtime/guard, installed at .agent-brain/guard) in a project's native settings on every
// `agent-brain pull`: one Claude PreToolUse hook on Bash and Monitor, and one Pi extension entry. Every other setting and
// hook is kept, an existing guard entry is replaced in place, and a file whose content would not change is not written.
// An unsafe or invalid settings file is refused before any brain file is written (checkGuardSettings).

const fs = require('node:fs');
const path = require('node:path');
const { readSettings, atomicJSON } = require('./native-settings');

const GUARD_PATH = '.agent-brain/guard';
const CLAUDE_GUARD_MATCHER = '^(?:Bash|Monitor)$';
// `|| exit 2` makes a missing or crashing hook block the call: Claude treats exit 2 as a refusal.
const CLAUDE_GUARD_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.agent-brain/guard/claude-hook.cjs" || exit 2';
const PI_GUARD_EXTENSION = '../.agent-brain/guard/pi.cjs';
// An earlier registration is only what this installer writes: exactly its command, and exactly its extension path.
// Anything else, even a command that also runs the guard or a file with the same name elsewhere, is the project's.
const isGuardHook = hook => hook && hook.command === CLAUDE_GUARD_COMMAND;
const isGuardExtension = value => value === PI_GUARD_EXTENSION;

function checkGuardSettings(target) {
  for (const rel of ['.claude', '.pi']) {
    try {
      const stat = fs.lstatSync(path.join(target, rel));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe harness settings path: ${rel}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const claude = readSettings(path.join(target, '.claude/settings.json'));
  const pi = readSettings(path.join(target, '.pi/settings.json'));
  if (claude.hooks !== undefined && (!claude.hooks || typeof claude.hooks !== 'object' || Array.isArray(claude.hooks))) throw new Error('Invalid Claude hook settings: hooks must be an object');
  const pre = claude.hooks && claude.hooks.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) throw new Error('Invalid Claude hook settings: PreToolUse must be an array');
  for (const entry of pre || []) if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) throw new Error('Invalid Claude hook settings: each PreToolUse entry needs a hooks array');
  if (pi.extensions !== undefined && !Array.isArray(pi.extensions)) throw new Error('Invalid Pi settings: extensions must be an array');
  return { claude, pi };
}

// The settings with exactly one guard entry each, at the position of the first existing one, else at the end.
function withGuard({ claude, pi }, { claudeCommand = CLAUDE_GUARD_COMMAND, piExtension = PI_GUARD_EXTENSION } = {}) {
  const guardEntry = { matcher: CLAUDE_GUARD_MATCHER, hooks: [{ type: 'command', command: claudeCommand, timeout: 10 }] };
  const pre = [];
  let placed = false;
  for (const entry of (claude.hooks && claude.hooks.PreToolUse) || []) {
    const others = entry.hooks.filter(hook => !isGuardHook(hook));
    if (others.length !== entry.hooks.length && !placed) { pre.push(guardEntry); placed = true; }
    if (others.length) pre.push({ ...entry, hooks: others });
  }
  if (!placed) pre.push(guardEntry);
  const extensions = [];
  placed = false;
  for (const value of pi.extensions || []) {
    if (!isGuardExtension(value)) { extensions.push(value); continue; }
    if (!placed) { extensions.push(piExtension); placed = true; }
  }
  if (!placed) extensions.push(piExtension);
  return {
    claude: { ...claude, hooks: { ...(claude.hooks || {}), PreToolUse: pre } },
    pi: { ...pi, extensions },
  };
}

function installGuard(target) {
  for (const file of ['guard.cjs', 'claude-hook.cjs', 'pi.cjs']) {
    const stat = fs.lstatSync(path.join(target, GUARD_PATH, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Branch guard file is not a regular file: ${GUARD_PATH}/${file}`);
  }
  const current = checkGuardSettings(target);
  const next = withGuard(current);
  const written = [];
  for (const [key, rel] of [['claude', '.claude/settings.json'], ['pi', '.pi/settings.json']]) {
    if (JSON.stringify(next[key]) === JSON.stringify(current[key])) continue;
    atomicJSON(path.join(target, rel), next[key]);
    written.push(rel);
  }
  return `Branch guard: registered in .claude/settings.json (PreToolUse on Bash, Monitor) and .pi/settings.json (extension)${written.length ? `; updated ${written.join(', ')}` : '; already registered'}.`;
}

module.exports = { GUARD_PATH, CLAUDE_GUARD_MATCHER, CLAUDE_GUARD_COMMAND, PI_GUARD_EXTENSION, checkGuardSettings, withGuard, installGuard };
