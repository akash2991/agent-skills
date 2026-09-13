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

// Injection needs a build to inject. Producing one here rather than failing keeps the test
// independent of whether someone has run `npm run all` first.
function ensureBuild() {
  if (fs.existsSync(path.join(ROOT, 'build', 'product', 'claude-code', 'AGENTS.md'))) return;
  execFileSync('node', [path.join(ROOT, 'scripts', 'brain', 'select.js')], { cwd: ROOT, stdio: 'ignore' });
  execFileSync('node', [path.join(ROOT, 'scripts', 'brain', 'build.js')], { cwd: ROOT, stdio: 'ignore' });
}
ensureBuild();

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
  const commands = fs.readdirSync(path.join(repo, '.claude', 'commands'));
  assert.ok(commands.includes('brain-pm.md') && commands.includes('brain-em.md') && commands.includes('brain-swe-backend.md'),
    'every role gets its own command, because the user invokes roles directly');
  assert.ok(!commands.includes('brain-ceo.md'), 'there is no entry-point role');
  assert.ok(commands.every(c => c.startsWith('brain-')),
    'every command is namespaced brain- so it cannot collide with another tool');
});

test('a file the brain no longer produces is retired, not left behind', () => {
  const repo = scratch();
  inject(repo);
  // Pretend a previous version shipped a command that has since been renamed away.
  const stale = path.join(repo, '.claude', 'commands', 'brain-init.md');
  fs.writeFileSync(stale, 'a command from an older version of the brain');
  const summaryFile = path.join(repo, '.agent-brain', 'injected.json');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  summary.targets['claude-code'].files.push('.claude/commands/brain-init.md');
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

test('the organization document is the same file whatever tool reads it', () => {
  // AGENTS.md is shared: Codex and OpenCode both read it, and injecting several tools into one
  // repository writes it several times. If it carried a tool name or one tool's paths, the last
  // target written would tell every other tool something false about itself.
  const built = path.join(ROOT, 'build', 'product');
  const targets = fs.readdirSync(built).filter(t => fs.existsSync(path.join(built, t, 'AGENTS.md')));
  assert.ok(targets.length > 1, 'need more than one target built to prove this');
  const first = fs.readFileSync(path.join(built, targets[0], 'AGENTS.md'), 'utf8');
  for (const t of targets.slice(1)) {
    assert.equal(fs.readFileSync(path.join(built, t, 'AGENTS.md'), 'utf8'), first,
      `AGENTS.md differs between ${targets[0]} and ${t}, so it is not safe to share`);
  }
  // Tool-specific guidance belongs in the per-tool command files, which are never shared.
  const claude = fs.readFileSync(path.join(built, 'claude-code', '.claude', 'commands', 'brain-pm.md'), 'utf8');
  const codex = fs.readFileSync(path.join(built, 'codex', '.codex', 'prompts', 'brain-pm.md'), 'utf8');
  assert.notEqual(claude, codex, 'the per-tool commands must carry what the shared file cannot');
});

test('a harness whose commands live outside the repository gets them installed and cleaned', () => {
  // Codex reads prompts only from $CODEX_HOME/prompts, never from the repository, so a repo-local
  // copy is not a command at all. Installing must happen by default, and a command the brain no
  // longer produces must be removed from that directory or a renamed one keeps answering forever.
  const repo = scratch();
  const home = scratch();
  const prompts = path.join(home, 'prompts');
  fs.mkdirSync(prompts, { recursive: true });
  fs.writeFileSync(path.join(prompts, 'brain-gone.md'), 'a command from an older version');
  fs.writeFileSync(path.join(prompts, 'somebody-elses.md'), 'not ours, must survive');

  execFileSync('node', [INJECT, repo, '--targets', 'codex'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });

  const after = fs.readdirSync(prompts);
  assert.ok(after.includes('brain-pm.md'), 'commands must be installed where the harness looks');
  assert.ok(!after.includes('brain-gone.md'), 'a retired brain command must not keep answering');
  assert.ok(after.includes('somebody-elses.md'), 'only brain-* files are ours to remove');
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
