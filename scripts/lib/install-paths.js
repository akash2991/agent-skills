'use strict';

const fs = require('fs');
const path = require('path');

// Unlike existsSync, this sees dangling symlinks and does not hide access errors.
function lstatIfPresent(file) {
  try { return fs.lstatSync(file); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Resolve existing ancestors as well as the final component, including aliases
// such as /tmp -> /private/tmp. Nonexistent output paths keep their suffix.
function canonicalPath(file) {
  const absolute = path.resolve(file);
  if (lstatIfPresent(absolute)) return fs.realpathSync.native(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error(`cannot resolve path: ${file}`);
  return path.join(canonicalPath(parent), path.basename(absolute));
}

function validateManagedRelPath(rel, label = 'path') {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error(`invalid ${label}: empty`);
  if (rel.includes('\\')) throw new Error(`invalid ${label}: backslash path separators are not allowed: ${rel}`);
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new Error(`invalid ${label}: absolute paths are not allowed: ${rel}`);
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error(`invalid ${label}: unsafe relative path: ${rel}`);
  if (parts[0] === '.agent-brain') throw new Error(`invalid ${label}: reserved state path: ${rel}`);
  const hasControlOrColon = /[\x00-\x1f\x7f:]/.test(rel);
  if (hasControlOrColon || parts.some(p => /[. ]$/.test(p) || /^(\.git|\.hg|\.svn|node_modules|\.agent-brain)$/i.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error(`invalid ${label}: reserved or unsafe path: ${rel}`);
  }
  const name = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const allowed = ['AGENTS.md', 'SOUL.md', '.env.example', 'docs/persona-anatomy.md', 'docs/skill-anatomy.md'].includes(rel)
    || new RegExp(`^skills/${name}/.+$`).test(rel)
    || new RegExp(`^agents/${name}\\.md$`).test(rel)
    || /^(references|templates)\/.+/.test(rel)
    || new RegExp(`^\\.(agents|claude|gemini|pi|hermes)/skills/${name}/.+$`).test(rel)
    || new RegExp(`^\\.(agents|claude|gemini|pi)/agents/${name}\\.md$`).test(rel)
    || /^\.(agents|claude|gemini|pi|hermes)\/(references|templates)\/.+/.test(rel)
    || /^(\.claude\/commands|\.pi\/prompts|\.codex\/prompts)\/brain(-status)?\.md$/.test(rel)
    || /^(\.gemini\/commands|commands)\/brain(-status)?\.toml$/.test(rel);
  if (!allowed) throw new Error(`invalid ${label}: outside managed brain layout: ${rel}`);
  return rel;
}

module.exports = { lstatIfPresent, isWithin, canonicalPath, validateManagedRelPath };
