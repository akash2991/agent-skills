'use strict';

// Branch guard (FAC-47): the shell check, both harness adapters, the settings registration, and the pull that ships it.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const { checkCommand } = require('../runtime/guard/guard.cjs');
const piExtension = require('../runtime/guard/pi.cjs');
const { CLAUDE_GUARD_COMMAND, CLAUDE_GUARD_MATCHER, PI_GUARD_EXTENSION, checkGuardSettings, withGuard, installGuard } = require('./lib/guard-install');

const dirs = [];
test.after(() => { for (const dir of dirs.reverse()) fs.rmSync(dir, { recursive: true, force: true }); });
function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `branch-guard-${name}-`));
  dirs.push(dir);
  return dir;
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

// Each line is one command; every one must be refused.
const BLOCKED = [
  // The 2026-11-15 slip, verbatim.
  'git worktree remove .../langfuse-fac7 && git branch -d "$B" || git branch -D "$B"',
  'gh pr merge 35 --merge --delete-branch --match-head-commit abc123',
  // git branch delete flags
  'git branch * x',
  'git -calias.x=status x',
  'git -c alias.x="branch -D" x topic',
  'git branch -d feature', 'git branch -D feature', 'git branch --delete feature', 'git branch --del feature',
  'git branch -df feature', 'git branch -rd origin/feature', 'git branch -v -D feature',
  'git -C ../repo branch -D feature', 'git --git-dir=.git branch -D x', 'git -c core.pager=cat branch -D x', 'git --no-pager branch -D x',
  '/usr/bin/git branch -D x', 'GIT_TRACE=1 git branch -D x', 'env FOO=1 git branch -D x', 'sudo -u bob git branch -D x', 'command git branch -D x',
  'nohup git branch -D x &', 'time git branch -D x', '! git branch -D x', 'if true; then git branch -D x; fi',
  'for b in a b; do git branch -D $b; done', 'f() { git branch -D x; }; f', '(git branch -D x)', '{ git branch -D x; }',
  'git status; git branch -D x', 'git status\ngit branch -D x', 'git fetch | git branch -D x', 'git fetch & git branch -D x',
  'git br\\\nanch -D x', 'git "branch" "-D" x', "git 'branch' '-D' x", 'git b\\ranch -\\D x',
  // values the shell only knows when it runs
  'git branch "$FLAG" x', 'git branch $FLAG x', 'git branch ${FLAG} x', 'git branch "$(echo -D)" x', 'git branch `echo -D` x',
  "git branch $'-D' x", 'git branch -{D,x} y', 'G=git; $G branch -D x', '"$GIT" branch -D x', 'git $SUB -D x',
  'echo feature | xargs git branch -D', 'git branch --merged | xargs git branch -d', 'printf "%s" x | xargs -I{} git branch {}',
  // commands inside substitutions and strings that a shell runs
  'x=$(git branch -D foo)', 'echo "$(git branch -D foo)"', 'echo `git branch -D foo`', 'diff <(git branch -D x) /dev/null',
  'echo $(( $(git branch -D x) + 1 ))', 'echo ${X:-$(git branch -D x)}',
  'bash -c "git branch -D x"', 'bash -lc \'git branch -D x\'', 'sh -ec "git branch -D x"', 'zsh -c "git worktree remove ../x"',
  'su -c "git branch -D x" me', 'eval git branch -D x', 'eval "git branch -D x"', 'env -S "git branch -D x"', 'watch -n 5 git worktree prune',
  'cat <<EOF | bash\ngit branch -D x\nEOF', 'bash <<\'EOF\'\ngit worktree remove ../x\nEOF', 'echo "git branch -D x" | sh', 'bash -c "$CMD git branch -D"',
  'cat <<EOF\n$(git branch -D x)\nEOF', 'cat <<EOF\n`git branch -D x`\nEOF', 'bash -c "bash -c \\"git branch -D x\\""',
  // worktrees and refs
  'git worktree remove ../x', 'git worktree remove --force ../x', 'git worktree prune', 'git worktree prune -n',
  'git -C .. worktree remove x', 'git worktree "$OP" ../x', 'git update-ref -d refs/heads/x', 'git update-ref -d refs/heads/x abc',
  'git update-ref --stdin < cmds', 'echo "delete refs/heads/x" | git update-ref --stdin', 'git update-ref -m why -d refs/heads/x',
  // gh
  'gh pr merge 1 -d', 'gh pr merge 1 --merge -d', 'gh pr merge 1 -md', 'gh pr merge 1 -sd', 'gh pr merge 1 --delete-branch=true',
  'gh pr merge --delete-branch', 'gh pr -R o/r merge 1 -d', 'gh pr merge -R o/r 1 --delete-branch', 'gh pr merge 1 --merge "$FLAGS"',
  'GH_TOKEN=x gh pr merge 1 -d', 'gh pr merge 1 -m && git branch -d x',
  'gh pr merge 46 --merge --body "$(printf \'a -d b\')"', // a substituted value could be -d
  // inline aliases, and text that cannot be parsed but names the commands
  'git -c alias.nuke="branch -D" nuke x', 'git -c "$ALIAS" nuke x', 'git branch -D "unterminated', 'gh pr merge 1 -d "unterminated',
];

// Every one must run.
const ALLOWED = [
  'git status', 'git branch', 'git branch -a', 'git branch -vv', 'git branch -r', 'git branch --list "FAC-*"', 'git branch --show-current',
  'git branch --merged origin/main', 'git branch --contains abc', 'git branch -m old new', 'git branch new-branch', 'git branch new main',
  'git branch --edit-description', 'git branch -- -D', 'git checkout -b "$B" origin/main', 'git switch -c "$B"', 'git worktree add ../x -b y',
  'git worktree add -b "$B" "../$B" origin/main', 'git worktree list', 'git worktree list --porcelain', 'git worktree lock ../x',
  'git update-ref refs/heads/x abc', 'git log --oneline -5', 'git commit -m "fix: drop the git branch -D fallback"',
  'git commit -m "$(cat <<\'EOF\'\nfix: never git branch -D\n\nCo-Authored-By: x\nEOF\n)"',
  'gh pr merge 46 --merge --match-head-commit 88d332b', 'gh pr merge 46 -m', 'gh pr merge 46 --merge --delete-branch=false',
  'gh pr view 46 --json state', 'gh pr create -d --title t --body b', 'gh pr create --title "x" --body "$(cat <<\'EOF\'\nRun git branch -D x, gh pr merge --delete-branch\nEOF\n)"',
  'gh pr create --body-file body.md', 'gh pr list', 'gh api repos/o/r/pulls/1',
  'echo "git branch -D x"', 'echo git branch', 'printf "%s\\n" "gh pr merge 1 -d"', 'grep -rn "worktree remove" docs', 'rg "update-ref -d"',
  'cat > notes.md <<\'EOF\'\ngit branch -D x\ngh pr merge --delete-branch\nEOF', 'cat <<EOF > notes.md\ngit branch -D x\nEOF',
  'node skills/development-setup/scripts/agent-env.js teardown FAC-1-x --owner a',
  'node skills/git-workflow-and-versioning/scripts/merge-pr.js 46', 'bash scripts/build.sh', 'sh -c "npm test"', 'bash -c "git status"',
  'cd "$W" && git status && git log --oneline -3', 'for f in *.js; do node --check "$f"; done', 'echo $PATH', 'ls -la # git branch -D x',
  'x=1; echo $((x + 1))', 'git branch --merged | grep -v main', 'npm run build 2>&1 | tail -5', 'git diff > out.patch',
  'echo "$(git branch --show-current)"', 'eval "$(ssh-agent -s)"',
];

test('the guard refuses every spelling of a branch delete, worktree removal and merge --delete-branch', () => {
  for (const command of BLOCKED) {
    const refusal = checkCommand(command);
    assert.ok(refusal, `should block: ${JSON.stringify(command)}`);
    assert.match(refusal, /merge-pr\.js/);
    assert.match(refusal, /agent-env\.js teardown/);
  }
});

test('the guard lets ordinary commands run, including text that only mentions the blocked commands', () => {
  for (const command of ALLOWED) assert.equal(checkCommand(command), null, `should allow: ${JSON.stringify(command)}`);
  assert.equal(checkCommand(undefined), null);
});

test('an unknown value is named in the refusal so the agent can write it literally', () => {
  assert.match(checkCommand('git branch "$FLAG" x'), /write it literally/);
  assert.doesNotMatch(checkCommand('git branch -D x'), /write it literally/);
});

function hook(input, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'runtime/guard/claude-hook.cjs')], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}
const decision = res => (res.stdout.trim() ? JSON.parse(res.stdout).hookSpecificOutput : null);

test('the Claude hook denies a refused command and stays silent for an allowed one', () => {
  const blocked = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git branch -D x' } }));
  assert.equal(blocked.status, 0);
  assert.equal(decision(blocked).permissionDecision, 'deny');
  assert.equal(decision(blocked).hookEventName, 'PreToolUse');
  assert.match(decision(blocked).permissionDecisionReason, /branch guard/);
  const allowed = hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  const noCommand = hook(JSON.stringify({ tool_name: 'Monitor', tool_input: {} }));
  assert.equal(noCommand.status, 0);
  assert.equal(noCommand.stdout, '');
});

test('the Claude hook denies a tool call it cannot read', () => {
  const res = hook('not json');
  assert.equal(res.status, 0);
  assert.equal(decision(res).permissionDecision, 'deny');
});

test('the registered Claude command blocks (exit 2) when the guard file is missing or crashes', () => {
  const project = tmpDir('claude-cmd');
  const run = () => spawnSync('sh', ['-c', CLAUDE_GUARD_COMMAND], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
  assert.equal(run().status, 2, 'a missing guard must block');
  fs.mkdirSync(path.join(project, '.agent-brain/guard'), { recursive: true });
  for (const f of ['guard.cjs', 'claude-hook.cjs', 'pi.cjs']) fs.copyFileSync(path.join(ROOT, 'runtime/guard', f), path.join(project, '.agent-brain/guard', f));
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  fs.writeFileSync(path.join(project, '.agent-brain/guard/guard.cjs'), 'throw new Error("broken")');
  assert.equal(run().status, 2, 'a crashing guard must block');
});

test('the Pi extension blocks a refused bash call and ignores other tools', () => {
  let handler;
  piExtension({ on(event, fn) { assert.equal(event, 'tool_call'); handler = fn; } });
  const blocked = handler({ toolName: 'bash', input: { command: 'gh pr merge 1 --delete-branch' } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /branch guard/);
  assert.equal(handler({ toolName: 'bash', input: { command: 'git status' } }), undefined);
  assert.equal(handler({ toolName: 'read', input: { path: 'git branch -D x' } }), undefined);
  assert.equal(handler({ toolName: 'bash', input: {} }), undefined);
});

test('registration keeps every other setting, replaces an old guard entry in place, and is idempotent', () => {
  const langfuse = { type: 'command', command: 'node "$HOME/.cache/agent-brain/bootstrap/bootstrap-claude.cjs"', timeout: 8 };
  const own = { type: 'command', command: 'node my-hook.js' };
  const current = {
    claude: { enabledPlugins: { x: true }, hooks: { SessionStart: [{ hooks: [langfuse] }], PreToolUse: [
      { matcher: '^(?:Agent|Task|Skill)$', hooks: [langfuse] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.agent-brain/guard/claude-hook.cjs"' }, own] },
      { matcher: 'Edit', hooks: [own] },
    ] } },
    pi: { packages: ['npm:x'], extensions: ['../.agent-brain/observability/pi.js', './.agent-brain/guard/pi.cjs', 'mine.ts'] },
  };
  const next = withGuard(current);
  assert.deepEqual(next.claude.enabledPlugins, { x: true });
  assert.deepEqual(next.claude.hooks.SessionStart, current.claude.hooks.SessionStart);
  assert.deepEqual(next.claude.hooks.PreToolUse, [
    { matcher: '^(?:Agent|Task|Skill)$', hooks: [langfuse] },
    { matcher: CLAUDE_GUARD_MATCHER, hooks: [{ type: 'command', command: CLAUDE_GUARD_COMMAND, timeout: 10 }] },
    { matcher: 'Bash', hooks: [own] },
    { matcher: 'Edit', hooks: [own] },
  ]);
  assert.deepEqual(next.pi, { packages: ['npm:x'], extensions: ['../.agent-brain/observability/pi.js', PI_GUARD_EXTENSION, 'mine.ts'] });
  assert.deepEqual(withGuard(next), next, 'a second registration changes nothing');
  assert.deepEqual(withGuard({ claude: {}, pi: {} }), {
    claude: { hooks: { PreToolUse: [{ matcher: CLAUDE_GUARD_MATCHER, hooks: [{ type: 'command', command: CLAUDE_GUARD_COMMAND, timeout: 10 }] }] } },
    pi: { extensions: [PI_GUARD_EXTENSION] },
  });
});

test('unsafe or invalid settings are refused', () => {
  const cases = [
    ['.claude/settings.json', '{not json'],
    ['.claude/settings.json', '[]'],
    ['.claude/settings.json', JSON.stringify({ hooks: [] })],
    ['.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: {} } })],
    ['.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })],
    ['.pi/settings.json', JSON.stringify({ extensions: 'x' })],
  ];
  for (const [rel, text] of cases) {
    const target = tmpDir('bad');
    fs.mkdirSync(path.join(target, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), text);
    assert.throws(() => checkGuardSettings(target), undefined, `${rel}: ${text}`);
  }
  const linked = tmpDir('link');
  fs.mkdirSync(path.join(linked, '.claude'));
  fs.writeFileSync(path.join(linked, 'real.json'), '{}');
  fs.symlinkSync(path.join(linked, 'real.json'), path.join(linked, '.claude/settings.json'));
  assert.throws(() => checkGuardSettings(linked), /Unsafe/);
  const linkedDir = tmpDir('linkdir');
  fs.mkdirSync(path.join(linkedDir, 'elsewhere'));
  fs.symlinkSync(path.join(linkedDir, 'elsewhere'), path.join(linkedDir, '.pi'));
  assert.throws(() => checkGuardSettings(linkedDir), /Unsafe/);
});

function pull(target, extra = []) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/agent-brain.js'), 'pull', '--target', target, ...extra], { encoding: 'utf8', env: { ...process.env, HOME: tmpDir('home') } });
}

test('agent-brain pull ships the guard and registers it in both harnesses, keeping existing settings', () => {
  const target = tmpDir('pull');
  writeJson(path.join(target, '.claude/settings.json'), { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node mine.js' }] }] } });
  writeJson(path.join(target, '.pi/settings.json'), { extensions: ['mine.ts'] });
  const res = pull(target);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Branch guard: registered/);
  for (const f of ['guard.cjs', 'claude-hook.cjs', 'pi.cjs']) assert.deepEqual(fs.readFileSync(path.join(target, '.agent-brain/guard', f)), fs.readFileSync(path.join(ROOT, 'runtime/guard', f)));
  const claude = readJson(path.join(target, '.claude/settings.json'));
  assert.deepEqual(claude.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(claude.hooks.PreToolUse.map(e => e.matcher), ['Edit', CLAUDE_GUARD_MATCHER]);
  // The pull also registers the artifact sync (documentation W12); the project's own entry stays first and the guard is there once.
  const extensions = readJson(path.join(target, '.pi/settings.json')).extensions;
  assert.equal(extensions[0], 'mine.ts');
  assert.deepEqual(extensions.filter(e => e === PI_GUARD_EXTENSION), [PI_GUARD_EXTENSION]);
  // The registered command, run the way Claude runs it, refuses from the installed copy.
  const run = spawnSync('sh', ['-c', CLAUDE_GUARD_COMMAND], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git branch -D x' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: target } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
  // The Pi entry resolves, relative to .pi/, to the installed extension.
  assert.ok(fs.existsSync(path.resolve(target, '.pi', PI_GUARD_EXTENSION)));
  const before = fs.statSync(path.join(target, '.claude/settings.json')).mtimeMs;
  const again = pull(target);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already registered/);
  assert.equal(fs.statSync(path.join(target, '.claude/settings.json')).mtimeMs, before);
});

test('pull refuses invalid settings before writing any brain file, and dry-run writes nothing', () => {
  const target = tmpDir('refuse');
  fs.mkdirSync(path.join(target, '.claude'));
  fs.writeFileSync(path.join(target, '.claude/settings.json'), '{oops');
  const res = pull(target);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /valid JSON/);
  assert.deepEqual(fs.readdirSync(target), ['.claude']);
  const dry = tmpDir('dry');
  const out = pull(dry, ['--dry-run']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /would register the branch guard/);
  assert.deepEqual(fs.readdirSync(dry), []);
});

test('this repository registers the guard from its source', () => {
  const claude = readJson(path.join(ROOT, '.claude/settings.json'));
  const entry = claude.hooks.PreToolUse.find(e => e.matcher === CLAUDE_GUARD_MATCHER);
  assert.ok(entry, 'PreToolUse guard entry');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/runtime/guard/claude-hook.cjs" || exit 2', timeout: 10 }]);
  const run = spawnSync('sh', ['-c', entry.hooks[0].command], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git worktree prune' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const pi = readJson(path.join(ROOT, '.pi/settings.json'));
  assert.ok(pi.extensions.includes('../runtime/guard/pi.cjs'));
  assert.ok(fs.existsSync(path.resolve(ROOT, '.pi', '../runtime/guard/pi.cjs')));
});
