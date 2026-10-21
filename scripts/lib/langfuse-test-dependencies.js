'use strict';
const path = require('node:path');
const { dependencyCacheDir, loadDependencies } = require('../../runtime/langfuse/dependencies.cjs');

// CI prepares checkout-local SDKs; ordinary worktrees reuse the installer's
// byte-pinned private cache. Validate either source, never download on test start.
function testDependencyRoot() {
  for (const dependencyRoot of [path.resolve(__dirname, '../../runtime/langfuse'), dependencyCacheDir()]) {
    try { loadDependencies({ dependencyRoot }); return dependencyRoot; } catch {}
  }
  throw new Error('Prepare the pinned tracing SDKs in runtime/langfuse or the private dependency cache before running tests');
}
module.exports = { testDependencyRoot };
