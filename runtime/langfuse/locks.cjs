'use strict';

// A process-owned Lamport bakery lock. Claim names are never reused by another
// owner, so recovery cannot unlink a successor (the ABA race). No age-based GC:
// live/paused owners and identities we cannot disprove are always preserved.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const PATTERN = /^(\d+)-([a-f0-9]{32})\.json$/;
const TEMP = /^\.(\d+)-([a-f0-9]{64})-([a-f0-9]{32})\.tmp$/;
const LEGACY_TEMP = /^\.([a-f0-9]{32})\.tmp$/;
const CAPACITY = 256;
const privateOwner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const birthHash = start => createHash('sha256').update(start).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function processStart(pid) {
  try {
    const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 200,
      env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // Unsupported/failed lookups must never create a new null-birth claim.
    return /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) +(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} +\d{2}:\d{2}:\d{2} +\d{4}$/.test(start) ? start : null;
  } catch { return null; }
}
function alive(owner, hashed = false) {
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  // Legacy null-birth records are deliberately conservative: an existing PID
  // is insufficient evidence for recovery. An operator must stop that owner
  // (or clean the private state offline); neither age nor a new lookup helps.
  const current = owner.start ? processStart(owner.pid) : null;
  return !current || (hashed ? birthHash(current) : current) === owner.start;
}
function safeFile(stat) {
  if (!stat.isFile() || !privateOwner(stat) || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 1024) throw new Error('Unsafe lock claim');
}
function inspect(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.nlink === 0) { const error = new Error('Claim changed during read'); error.code = 'EAGAIN'; throw error; }
    safeFile(stat);
    const buffer = Buffer.alloc(1025), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 1024) throw new Error('Unsafe lock claim');
    return { stat, text: buffer.subarray(0, length).toString('utf8') };
  } finally { fs.closeSync(fd); }
}
function record(text, pid, token) {
  const owner = JSON.parse(text);
  if (owner.pid !== pid || owner.token !== token || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.choosing !== 'boolean' || !Number.isSafeInteger(owner.ticket) || owner.ticket < 0
    || !(owner.start === null || typeof owner.start === 'string' && owner.start.length > 0 && owner.start.length <= 128)) throw new Error('Invalid lock claim');
  return owner;
}
function remove(file, expected) {
  try {
    const current = fs.lstatSync(file);
    // Publication replaces an inode atomically. Never delete an entry that
    // changed since inspection. Dead publishers cannot recreate their names;
    // live publishers are never collected, including partial temporary writes.
    if (!sameFile(current, expected)) return false;
    safeFile(current);
    fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}
function claimLock(stateDir, kind, { deadlineAt = Date.now() + 5000 } = {}) {
  if (!['queue', 'flush', 'context'].includes(kind)) throw new Error('Invalid lock kind');
  const budget = () => { if (Date.now() >= deadlineAt) throw new Error('Lock budget exceeded'); };
  budget();
  const start = processStart(process.pid);
  budget();
  if (!start) throw new Error('Process birth identity unavailable');
  const directory = path.join(stateDir, `${kind}-claims`);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat) || stat.mode & 0o077) throw new Error('Unsafe lock directory');
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex'), start, choosing: true, ticket: 0 };
  const name = `${owner.pid}-${owner.token}.json`, file = path.join(directory, name);
  // The filename carries birth identity even if killed before the first byte
  // is written. Old .token.tmp files instead require a complete valid record;
  // ambiguous legacy partials fail closed and require offline operator cleanup.
  const temporary = path.join(directory, `.${owner.pid}-${birthHash(start)}-${owner.token}.tmp`);
  let published;
  const verify = () => {
    const current = fs.lstatSync(file);
    safeFile(current);
    if (!published || !sameFile(current, published)) throw new Error('Lock claim ownership changed');
  };
  const write = () => {
    budget();
    let pending;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        pending = fs.fstatSync(fd);
        safeFile(pending);
        fs.writeFileSync(fd, JSON.stringify(owner));
      } finally { fs.closeSync(fd); }
      // Never overwrite an unexpected replacement or a link at our claim path.
      if (published) verify();
      else { try { fs.lstatSync(file); throw new Error('Lock claim already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      const current = fs.lstatSync(temporary);
      safeFile(current);
      if (!sameFile(current, pending)) throw new Error('Lock temporary ownership changed');
      fs.renameSync(temporary, file);
      published = pending;
    } finally { if (pending) remove(temporary, pending); }
  };
  const release = () => { if (published) remove(file, published); };
  const peers = () => {
    const result = [], occupants = new Set([name]);
    // Collect dead publications before counting admission; raw entries do not
    // consume capacity. Stream recovery within the caller's budget, keeping only
    // bounded live identities. Each publisher has at most a claim plus one
    // temporary. Recheck admission after publication for concurrent entrants.
    const entries = fs.opendirSync(directory);
    try {
      for (let entry; (entry = entries.readSync());) {
        budget();
        const entryName = entry.name, claim = PATTERN.exec(entryName), temp = TEMP.exec(entryName), legacy = LEGACY_TEMP.exec(entryName);
        if (!claim && !temp && !legacy) throw new Error('Invalid lock entry');
        const candidate = path.join(directory, entryName);
        let data;
        for (;;) {
          try { data = inspect(candidate); break; }
          catch (error) {
            if (error.code === 'ENOENT') break;
            if (error.code !== 'EAGAIN') throw error;
            budget();
          }
        }
        if (!data) continue;
        let peer;
        if (temp) {
          peer = { pid: Number(temp[1]), start: temp[2], token: temp[3] };
          if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0) throw new Error('Invalid lock temporary');
        } else if (claim) peer = record(data.text, Number(claim[1]), claim[2]);
        else {
          const parsed = JSON.parse(data.text);
          peer = record(data.text, parsed.pid, legacy[1]);
        }
        if (peer.pid === owner.pid && peer.token === owner.token) {
          occupants.add(name);
          continue;
        }
        if (!alive(peer, !!temp)) {
          if (!remove(candidate, data.stat)) throw new Error('Lock claim ownership changed during recovery');
          continue;
        }
        occupants.add(`${peer.pid}-${peer.token}.json`);
        if (occupants.size > CAPACITY) throw new Error('Lock claim capacity exceeded');
        if (claim) result.push({ ...peer, name: entryName });
      }
    } finally { entries.closeSync(); }
    budget();
    return result;
  };
  try {
    peers(); // Recover old temporaries even when they filled the old raw-entry cap.
    write(); // Publish choosing before observing ticket numbers.
    owner.ticket = 1 + Math.max(0, ...peers().map(peer => peer.ticket));
    if (!Number.isSafeInteger(owner.ticket)) throw new Error('Lock ticket capacity exceeded');
    owner.choosing = false;
    write();
    return { release, blocked: () => { verify(); return peers().some(peer => peer.choosing || peer.ticket < owner.ticket || peer.ticket === owner.ticket && peer.name < name); } };
  } catch (error) { release(); throw error; }
}
module.exports = { claimLock };
