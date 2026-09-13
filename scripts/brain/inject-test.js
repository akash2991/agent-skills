'use strict';
// Injection is the step that touches somebody else's repository, so its guarantees are the ones
// worth pinning: it never deletes what it did not write, it retires what it no longer produces, and
// a seed belongs to the project the moment it exists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const INJECT = path.join(ROOT, 'scripts', 'brain', 'inject.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-inject-'));
}
function inject(repo, extra = []) {
  return execFileSync('node', [INJECT, repo, '--targets', 'claude-code', ...extra], { cwd: ROOT, encoding: 'utf8' });
}

test('injection is idempotent and leaves a project runnable', () => {
  const repo = scratch();
  inject(repo);
  const first = fs.readdirSync(path.join(repo, '.claude', 'skills')).length;
  inject(repo);
  assert.equal(fs.readdirSync(path.join(repo, '.claude', 'skills')).length, first);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'commands', 'brain-init.md')),
    'the entry command is namespaced brain-init so it cannot collide with another tool');
});

test('a file the brain no longer produces is retired, not left behind', () => {
  const repo = scratch();
  inject(repo);
  // Pretend a previous version shipped a command that has since been renamed away.
  const stale = path.join(repo, '.claude', 'commands', 'brain.md');
  fs.writeFileSync(stale, 'an older name for the entry command');
  const summaryFile = path.join(repo, '.agent-brain', 'injected.json');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  summary.targets['claude-code'].files.push('.claude/commands/brain.md');
  fs.writeFileSync(summaryFile, JSON.stringify(summary));

  inject(repo);
  assert.ok(!fs.existsSync(stale),
    'a renamed command must not keep answering in an injected repository');
});

test('a seed is never retired, however the record reads', () => {
  const repo = scratch();
  inject(repo);
  const seed = path.join(repo, '.agent-brain', 'docs', 'CONVENTIONS.md');
  fs.writeFileSync(seed, '# our own conventions\n\nwritten by the project, not the brain\n');

  // A kept seed drops out of the per-run file list, so the record alone would mark it removable.
  // It must survive anyway: its content belongs to the project from the moment it exists.
  const summaryFile = path.join(repo, '.agent-brain', 'injected.json');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  summary.targets['claude-code'].files.push('.agent-brain/docs/CONVENTIONS.md');
  fs.writeFileSync(summaryFile, JSON.stringify(summary));

  inject(repo);
  assert.equal(fs.readFileSync(seed, 'utf8'), '# our own conventions\n\nwritten by the project, not the brain\n');
});

test('a project file the brain never wrote is untouched', () => {
  const repo = scratch();
  const mine = path.join(repo, 'README.md');
  fs.writeFileSync(mine, '# my project\n');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));

  inject(repo);
  assert.equal(fs.readFileSync(mine, 'utf8'), '# my project\n');
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
  const commands = JSON.stringify(settings.hooks.Stop);
  assert.match(commands, /echo mine/, "the project's own hook must survive the merge");
  assert.match(commands, /hook\.js/, "and the brain's usage capture must be added alongside it");
});

test('each project gets its own control plane', () => {
  const a = scratch();
  const b = scratch();
  inject(a);
  inject(b);
  const dbOf = repo => path.join(repo, '.agent-brain', 'control-plane', 'brain.db');
  const brain = repo => path.join(repo, '.agent-brain', 'control-plane', 'brain.js');
  execFileSync('node', [brain(a), 'context', '--role', 'ceo', '--harness', 'claude-code', '--model', 'm'], { cwd: a, encoding: 'utf8' });
  // Two projects must not share state: a CEO claimed in one cannot block the other, and neither
  // can see the other's agents or spend.
  const out = execFileSync('node', [brain(b), 'context', '--role', 'ceo', '--harness', 'claude-code', '--model', 'm'], { cwd: b, encoding: 'utf8' });
  assert.match(out, /You are the ceo/);
  assert.ok(fs.existsSync(dbOf(a)) && fs.existsSync(dbOf(b)));
  assert.notEqual(fs.realpathSync(dbOf(a)), fs.realpathSync(dbOf(b)));
});
