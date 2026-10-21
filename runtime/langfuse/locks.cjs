'use strict';

// A process-owned Lamport bakery lock. Unique claim files avoid deleting or
// renaming a replacement owner's lock during crash recovery (the ABA race).
// Only dead process identities are ignored; a paused/live owner is never stolen.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const PATTERN = /^(\d+)-([a-f0-9]{32})\.json$/;
const privateOwner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function processStart(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 200,
    env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}
function alive(owner) {
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  // A reused PID is not the process that published the claim. If birth time
  // cannot be established, conservatively preserve the live-looking owner.
  const current = owner.start ? processStart(owner.pid) : null;
  return !current || current === owner.start;
}
function read(file, name) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.nlink === 0) { const error = new Error('Claim changed during read'); error.code = 'EAGAIN'; throw error; }
    if (!stat.isFile() || !privateOwner(stat) || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 1024) throw new Error('Unsafe lock claim');
    const buffer = Buffer.alloc(1025), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const owner = JSON.parse(buffer.subarray(0, length).toString('utf8')), match = PATTERN.exec(name);
    if (!match || owner.pid !== Number(match[1]) || owner.token !== match[2] || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.choosing !== 'boolean' || !Number.isSafeInteger(owner.ticket) || owner.ticket < 0
      || !(owner.start === null || typeof owner.start === 'string' && owner.start.length <= 128)) throw new Error('Invalid lock claim');
    return owner;
  } finally { fs.closeSync(fd); }
}
function claimLock(stateDir, kind, { deadlineAt = Date.now() + 5000 } = {}) {
  if (!['queue', 'flush', 'context'].includes(kind)) throw new Error('Invalid lock kind');
  const directory = path.join(stateDir, `${kind}-claims`);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat) || stat.mode & 0o077) throw new Error('Unsafe lock directory');
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex'), start: processStart(process.pid), choosing: true, ticket: 0 };
  const name = `${owner.pid}-${owner.token}.json`, file = path.join(directory, name);
  const write = () => {
    const temporary = path.join(directory, `.${owner.token}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  const release = () => { try { fs.unlinkSync(file); } catch {} };
  const peers = () => {
    const names = fs.readdirSync(directory);
    if (names.length > 256) throw new Error('Lock claim capacity exceeded');
    const result = [];
    for (const entry of names) {
      if (Date.now() >= deadlineAt) throw new Error('Lock budget exceeded');
      if (entry === name || /^\.[a-f0-9]{32}\.tmp$/.test(entry)) continue;
      if (!PATTERN.test(entry)) throw new Error('Invalid lock entry');
      const candidate = path.join(directory, entry);
      let peer;
      for (;;) {
        try { peer = read(candidate, entry); break; }
        catch (error) {
          if (error.code === 'ENOENT') break;
          if (error.code !== 'EAGAIN' || Date.now() >= deadlineAt) throw error;
        }
      }
      if (!peer) continue;
      if (!alive(peer)) { try { fs.unlinkSync(candidate); } catch {} continue; }
      result.push({ ...peer, name: entry });
    }
    return result;
  };
  try {
    write(); // Publish choosing before observing ticket numbers.
    owner.ticket = 1 + Math.max(0, ...peers().map(peer => peer.ticket));
    owner.choosing = false;
    write();
    return { release, blocked: () => peers().some(peer => peer.choosing || peer.ticket < owner.ticket || peer.ticket === owner.ticket && peer.name < name) };
  } catch (error) { release(); throw error; }
}
module.exports = { claimLock };
