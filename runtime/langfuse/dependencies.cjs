'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

// Installer contract: copy these exact package.json/package-lock.json bytes to
// dependencyCacheDir(), then run `npm ci --ignore-scripts --no-audit --no-fund`
// there. Never install at agent startup. Cache identity depends only on the
// committed lock, not the checkout, cwd, or PI_CODING_AGENT_DIR.
const lockBytes = fs.readFileSync(path.join(__dirname, 'package-lock.json'));
const packageBytes = fs.readFileSync(path.join(__dirname, 'package.json'));
const LOCK_FINGERPRINT = createHash('sha256').update(lockBytes).digest('hex');
function dependencyCacheDir({ home = os.homedir() } = {}) {
  return path.join(home, '.cache', 'agent-brain', 'langfuse', LOCK_FINGERPRINT);
}
// Only the dynamic cache copies are hostile inputs. Trusted bundled manifests
// above remain the byte-exact authority; no install or content traversal here.
function readCacheMetadata(file, cap) {
  const before = fs.lstatSync(file);
  const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap;
  const same = stat => regular(stat) && stat.dev === before.dev && stat.ino === before.ino &&
    stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  if (!regular(before) || !Number.isInteger(fs.constants.O_NONBLOCK) || !Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error('Unsafe cache metadata');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!same(fs.fstatSync(fd))) throw new Error('Replaced cache metadata');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used !== before.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) throw new Error('Changed cache metadata');
    return bytes.subarray(0, used);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function loadDependencies({ dependencyRoot = dependencyCacheDir() } = {}) {
  try {
    const root = fs.realpathSync(dependencyRoot);
    for (const [file, expected] of [['package-lock.json', lockBytes], ['package.json', packageBytes]]) {
      if (!readCacheMetadata(path.join(root, file), expected.length).equals(expected)) throw new Error();
    }
    const requireFromCache = createRequire(path.join(root, 'package.json'));
    const load = name => {
      const resolved = fs.realpathSync(requireFromCache.resolve(name));
      if (!resolved.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error();
      return requireFromCache(name);
    };
    return {
      ...load('@opentelemetry/api'),
      ...load('@opentelemetry/sdk-trace-node'),
      ...load('@opentelemetry/resources'),
      LangfuseSpanProcessor: load('@langfuse/otel').LangfuseSpanProcessor
    };
  } catch { throw new Error('Metadata tracing dependencies unavailable; install the pinned runtime cache'); }
}

module.exports = { dependencyCacheDir, loadDependencies, LOCK_FINGERPRINT };
