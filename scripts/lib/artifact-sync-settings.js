'use strict';

// The one settings change a default `agent-brain pull` makes (docs/harness-layout.md): it registers the artifact
// sync (documentation W12) as a Claude Code Stop and SubagentStop hook and as a Pi extension. Only these entries are
// added or replaced; every other key, hook, and extension in the project's settings is left as it was.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MARK = 'documentation/scripts/artifact-sync.js';
const CLAUDE_EVENTS = ['Stop', 'SubagentStop'];
const CLAUDE_COMMAND = 'f="$CLAUDE_PROJECT_DIR/.claude/skills/documentation/scripts/artifact-sync.js"; [ ! -f "$f" ] || node "$f" hook';
const PI_EXTENSION = '../.agents/skills/documentation/scripts/artifact-sync-pi.js';

function readJson(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch { throw new Error(`${file} is not valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must be an object`);
  return value;
}

function mergeClaude(settings) {
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('.claude/settings.json hooks must be an object');
  }
  const hooks = structuredClone(settings.hooks || {});
  for (const event of CLAUDE_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`.claude/settings.json hooks.${event} must be an array`);
    // Already registered, exactly once and current: leave the event as it is, wherever the entry sits.
    const ours = (hooks[event] || []).flatMap(entry => (Array.isArray(entry?.hooks) ? entry.hooks : [])).filter(h => typeof h?.command === 'string' && h.command.includes(MARK));
    if (ours.length === 1 && ours[0].command === CLAUDE_COMMAND) continue;
    const others = (hooks[event] || [])
      .map(entry => ({ ...entry, hooks: (Array.isArray(entry?.hooks) ? entry.hooks : []).filter(h => !(typeof h?.command === 'string' && h.command.includes(MARK))) }))
      .filter(entry => entry.hooks.length);
    others.push({ hooks: [{ type: 'command', command: CLAUDE_COMMAND, timeout: 10 }] });
    hooks[event] = others;
  }
  return { ...settings, hooks };
}

function mergePi(settings) {
  if (settings.extensions !== undefined && !Array.isArray(settings.extensions)) throw new Error('.pi/settings.json extensions must be an array');
  const current = settings.extensions || [];
  const ours = current.filter(e => typeof e === 'string' && e.includes('documentation/scripts/artifact-sync-pi.js'));
  if (ours.length === 1 && ours[0] === PI_EXTENSION) return settings;
  const extensions = current.filter(e => !ours.includes(e));
  extensions.push(PI_EXTENSION);
  return { ...settings, extensions };
}

// Reads and merges without writing, so a pull can refuse before it changes anything.
function planArtifactSyncSettings(targetRoot) {
  const claudeFile = path.join(targetRoot, '.claude', 'settings.json');
  const piFile = path.join(targetRoot, '.pi', 'settings.json');
  const claudeBefore = readJson(claudeFile);
  const piBefore = readJson(piFile);
  const writes = [];
  const claude = mergeClaude(claudeBefore);
  const pi = mergePi(piBefore);
  if (JSON.stringify(claude) !== JSON.stringify(claudeBefore)) writes.push({ rel: '.claude/settings.json', file: claudeFile, value: claude });
  if (JSON.stringify(pi) !== JSON.stringify(piBefore)) writes.push({ rel: '.pi/settings.json', file: piFile, value: pi });
  return writes;
}

function applyArtifactSyncSettings(writes) {
  for (const { file, value } of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, file);
  }
}

module.exports = { CLAUDE_COMMAND, PI_EXTENSION, mergeClaude, mergePi, planArtifactSyncSettings, applyArtifactSyncSettings };
