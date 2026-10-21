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
function loadDependencies({ dependencyRoot = dependencyCacheDir() } = {}) {
  try {
    const root = fs.realpathSync(dependencyRoot);
    for (const [file, expected] of [['package-lock.json', lockBytes], ['package.json', packageBytes]]) {
      if (!fs.readFileSync(path.join(root, file)).equals(expected)) throw new Error();
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
