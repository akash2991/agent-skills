'use strict';

// Reading and writing a project's native harness settings (.claude/settings.json, .pi/settings.json), shared by the
// Langfuse opt-in and the branch guard. A settings file must be a regular file holding a JSON object; it is replaced
// atomically, keeping its mode.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readSettings(file, missingValue = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe native settings');
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Native settings must contain valid JSON (contents omitted)'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native settings must be an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return missingValue;
    throw error;
  }
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe native settings path');
    mode = stat.mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  // A new file gets what the umask allows; an existing file keeps its mode, which creation alone would cut by the umask.
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: mode === null ? 0o644 : mode, flag: 'wx' });
  if (mode !== null) fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

module.exports = { readSettings, atomicJSON };
