'use strict';
// Synthetic JSON/native hooks and an in-process pinned-SDK exporter only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectContent, configurePrivacy } = require('../runtime/langfuse/privacy.cjs');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { handleClaudeHook } = require('../runtime/langfuse/claude.cjs');
const { flushOutbox } = require('../runtime/langfuse/export.cjs');
const FULL = { schema: 2, enabled: true, captureMode: 'full-content', capturePolicyVersion: 1,
  redactionPolicyVersion: 1, pii: 'retain', durableRetry: true };
const META = { schema: 1, enabled: true, captureMode: 'metadata-only' };
const variants = [
  ['image', data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })],
  ['document', data => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })],
  ['audio', data => ({ type: 'input_audio', input_audio: { format: 'wav', data } })],
  ['file', data => ({ type: 'file', file: { filename: 'synthetic.bin', file_data: data } })],
  ['inline', data => ({ inlineData: { mimeType: 'image/png', data } })],
  ['inline-snake', data => ({ inline_data: { mime_type: 'image/png', data } })],
  ['read-image', base64 => ({ type: 'image', file: { base64, type: 'image/png', originalSize: 64, dimensions: { width: 1, height: 1 } } })],
  ['read-pdf', base64 => ({ type: 'pdf', file: { filePath: 'synthetic.pdf', base64, originalSize: 64 } })],
  ['input-file', file_data => ({ type: 'input_file', file_data })],
  ['mcp-resource', blob => ({ type: 'resource', resource: { uri: 'synthetic://binary', mimeType: 'application/pdf', blob } })]
];
const cases = [...variants,
  ['image-mask-base64', variants[0][1], ['base64']],
  ['image-mask-data', variants[0][1], ['data']],
  ['read-image-mask-data', variants[6][1], ['data']],
  ['read-pdf-mask-base64', variants[7][1], ['base64']]
];
const files = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
function fixture(t, capturePolicy = FULL) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-content-media-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'), transcript = path.join(root, 'native.jsonl');
  fs.mkdirSync(cwd); fs.writeFileSync(transcript, '');
  const session = crypto.randomUUID();
  const flow = createFlow({ cwd, stateDir, harness: 'claude', env: {}, capturePolicy,
    flushOutbox: async () => ({ queued: 0, accepted: 0 }) });
  const hook = (event, extra = {}) => handleClaudeHook({ cwd, session_id: session, transcript_path: transcript,
    hook_event_name: event, ...extra }, { flow, env: {} });
  const disk = () => files(stateDir).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  return { root, cwd, stateDir, transcript, session, flow, hook, disk };
}
test('shared projection refuses native raw binary shapes but retains text, PII, references and tool schemas', () => {
  for (const [name, shape] of variants) {
    assert.deepEqual(projectContent({ content: [shape(Buffer.from(`SYNTHETIC_BINARY_${name}`).toString('base64'))] }), { status: 'unsupported' });
  }
  const ordinary = { text: 'image/audio/file data: zoe@example.invalid 123-45-6789',
    template: { type: 'image', data: 'describe the data field', mimeType: 'a schema field description' },
    tools: [{ type: 'image', description: 'Describe a binary format; this is not an actual media payload',
      properties: { source: { type: 'object', properties: { data: { type: 'string' } } },
        inlineData: { type: 'object', properties: { data: { type: 'string' }, mimeType: { type: 'string' } } } } }],
    document: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'ordinary text zoe@example.invalid' } },
    reference: { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } },
    textRead: { type: 'text', file: { filePath: 'synthetic.txt', content: 'zoe@example.invalid 123-45-6789' } },
    notebook: { type: 'notebook', file: { cells: [{ cell_type: 'markdown', source: 'zoe@example.invalid' }] } },
    resourceText: { type: 'resource', resource: { uri: 'synthetic://text', mimeType: 'text/plain', text: 'zoe@example.invalid' } } };
  assert.deepEqual(projectContent(ordinary), { status: 'captured', value: ordinary });
});
test('configured literal rewrites cannot disguise original native-media keys or discriminators', () => {
  try {
    for (const literal of ['base64', 'data', 'source', 'image', 'type', 'file', 'blob', 'inlineData']) {
      configurePrivacy({ sensitiveLiterals: [literal] });
      for (const [name, shape] of variants) assert.deepEqual(projectContent({ content: [shape('U1lOVEhFVElDX0JJTkFSWQ==')] }),
        { status: 'unsupported' }, `${literal}: ${name}`);
    }
  } finally { configurePrivacy(); }
  let reads = 0;
  const source = { type: 'base64', media_type: 'image/png' };
  Object.defineProperty(source, 'data', { enumerable: true, get() { reads++; throw Error('preclassification must not invoke getters'); } });
  assert.deepEqual(projectContent({ type: 'image', source }), { status: 'unsupported' });
  assert.equal(reads, 0);
});
for (const [name, shape, literals = []] of cases) test(`Claude ${name} raw media is unsupported before checkpoint/pending/outbox and pinned SDK export`, async t => {
  configurePrivacy({ sensitiveLiterals: literals });
  t.after(() => configurePrivacy());
  const f = fixture(t), data = Buffer.from(`SYNTHETIC_PRIVATE_BINARY_${name}`).toString('base64'), block = shape(data);
  await f.hook('SessionStart');
  fs.appendFileSync(f.transcript, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: f.session,
    timestamp: new Date().toISOString(), message: { role: 'user', content: [block] } }) + '\n');
  await f.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'root-media', tool_input: { file_path: 'synthetic-only' } });
  await f.hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'root-media', tool_response: { content: [block] } });
  assert.ok(!f.disk().includes(data), 'no raw base64 reaches managed open checkpoints or outbox');
  await f.hook('SubagentStart', { agent_id: 'pending-child', agent_type: 'scout' });
  await f.hook('PreToolUse', { agent_id: 'pending-child', tool_name: 'Read', tool_use_id: 'pending-media', tool_input: {} });
  await f.hook('PostToolUse', { agent_id: 'pending-child', tool_name: 'Read', tool_use_id: 'pending-media', tool_response: { content: [block] } });
  const pending = files(path.join(f.stateDir, 'adapters/pending'));
  assert.ok(pending.length > 0, 'unresolved child publication remains durably deferred');
  assert.ok(!f.disk().includes(data), 'no raw base64 reaches deferred records');
  await f.hook('Stop', { last_assistant_message: 'synthetic completed' });
  const entries = files(path.join(f.stateDir, 'outbox')).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(file, 'utf8')).record);
  assert.ok(entries.some(record => record.type === 'TOOL' && record.content.output.status === 'unsupported'));
  assert.ok(entries.some(record => record.type === 'SPAN' && record.content.input.status === 'unsupported'), 'transcript user block is explicitly refused');
  const seen = [];
  const result = await flushOutbox({ stateDir: f.stateDir,
    dependencyRoot: require('./lib/langfuse-test-dependencies.js').testDependencyRoot(),
    credentials: { publicKey: 'pk-lf-SYNTHETIC_ONLY', secretKey: 'sk-lf-SYNTHETIC_ONLY', baseUrl: 'https://invalid.invalid' },
    timeoutMs: 10000, exporterFactory: () => ({ export(spans, callback) { seen.push(...spans); callback({ code: 0 }); },
      async shutdown() {}, async forceFlush() {} }) });
  assert.ok(result.accepted > 0);
  assert.ok(!JSON.stringify(seen.map(span => span.attributes)).includes(data));
  assert.ok(seen.some(span => span.attributes['langfuse.observation.metadata.outputStatus'] === '"unsupported"'));
  assert.ok(seen.some(span => span.attributes['langfuse.observation.metadata.inputStatus'] === '"unsupported"'));
  assert.ok(!f.disk().includes(data));
});
test('actual Claude text Read responses retain PII rather than becoming media refusals', async t => {
  const f = fixture(t), response = { type: 'text', file: { filePath: 'synthetic.txt', content: 'Zoë zoe@example.invalid 123-45-6789' } };
  await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'text-read', tool_input: {} });
  await f.hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'text-read', tool_response: response });
  const records = files(path.join(f.stateDir, 'outbox')).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
    .filter(entry => entry.record.type === 'TOOL').sort((a, b) => b.revision - a.revision);
  const output = records[0].record.content.output;
  assert.equal(output.status, 'captured');
  assert.deepEqual(output.value.postToolUse, response);
});
test('Claude metadata-only hooks never inspect native raw media data', async t => {
  const f = fixture(t, META);
  let reads = 0;
  const source = { type: 'base64', media_type: 'image/png' };
  Object.defineProperty(source, 'data', { enumerable: true, get() { reads++; throw Error('metadata must not inspect body'); } });
  await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'metadata-read', tool_input: {} });
  await f.hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'metadata-read', tool_response: { content: [{ type: 'image', source }] } });
  assert.equal(reads, 0);
});
