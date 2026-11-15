#!/usr/bin/env node
'use strict';

// This CLI accepts stdin JSON only. No payload (including parse errors) is ever
// logged. Supported actor additionalContext is the only stdout; ordinary Bash
// input and native permission decisions are never changed.
const { handleClaudeHook } = require('./claude.cjs');
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function readPayload(input = process.stdin, timeoutMs = 750) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', fail);
    };
    const fail = () => { cleanup(); reject(new Error('Claude metadata hook input unavailable.')); };
    const data = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) { fail(); return; }
      chunks.push(buffer);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Claude metadata hook input unavailable.')); }
    };
    const timer = setTimeout(fail, timeoutMs);
    input.on('data', data);
    input.once('end', end);
    input.once('error', fail);
  });
}

async function main() {
  try {
    const output = await handleClaudeHook(await readPayload());
    if (output) await new Promise(resolve => process.stdout.write(JSON.stringify(output), resolve));
  } catch {
    // Exit zero: observability failures must never block a tool or session.
    await new Promise(resolve => process.stderr.write('Claude metadata hook unavailable.\n', resolve));
  }
}

if (require.main === module) {
  // Delivery runs in a detached process; exit as soon as the bounded hook
  // returns. This is best effort, not a SIGKILL guarantee.
  // Backstop under Claude's 8-second native timeout.
  setTimeout(() => process.exit(0), 7500).unref();
  main().then(() => process.exit(0), () => process.exit(0));
}
module.exports = { MAX_INPUT_BYTES, readPayload, main };
