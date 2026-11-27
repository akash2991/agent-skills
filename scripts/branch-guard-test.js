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
const LONG = 'a '.repeat(30000);
const BLOCKED = [
  // Round 2 (Opus): a guarded command in a git or gh command's quoted argument, fed to a shell; an option whose value can split.
  "git for-each-ref --format='git branch -D %(refname:short)' refs/heads/feature | sh",
  "git branch --merged main --format='git branch -d %(refname:short)' | grep -v main | bash",
  "eval \"$(git for-each-ref --format='git branch -D %(refname:short)' refs/heads/feature)\"",
  "bash -c \"$(git for-each-ref --format='git branch -D %(refname:short)' refs/heads/feature)\"",
  "sh <(git for-each-ref --format='git worktree remove %(refname:short)' refs/heads/feature)",
  "gh pr list --json number --jq '.[] | \"gh pr merge \\(.number) --squash --delete-branch\"' | sh",
  "git --git-dir=$X branch",
  "GIT_CONFIG_COUNT=1",
  "echo \"git branch -D x\" | xargs -L1 sh -c",
  // Round 2: push delete flags in every spelling; git in command position after a keyword or a wrapper.
  'git push -qd . victim', 'git push --del . victim', 'git push --mir ../other', 'if git $A; then echo; fi', 'time git $A', 'sudo git $A', 'find . -exec git $A \\;', 'find . -exec sh -c \'echo "$1"\' _ {} \\; -exec git $A \\;', 'gh pr merge 5 -sd', 'gh pr merge 5 -t$TITLE',
  // Round-1 synthesis: words after an env split string, an unquoted option value that can split, local push destinations.
  'env -S "git branch" -D victim', 'gh pr merge 5 -t $TITLE', 'gh pr merge 5 --body=$B', 'git push --repo=. --delete victim', 'git push --repo . :victim', 'git push repos/local.git :victim',
  'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0="branch -D" git x v', 'export GIT_CONFIG_PARAMETERS="\'alias.x=branch -D\'"; git x v',
  'sudo git branch -D x', 'bash -o pipefail -c "git branch -D x"', 'bash -c \'git branch -D "$1"\' _ victim',
  // Round-1 review: an unknown subcommand, the script after `-c`, git's own programs, update-ref with a zero value, a push
  // into the local repository, config through the environment, an arithmetic command, a command name in a variable.
  "git {branch,-D,victim}",
  "git $(echo branch -D victim)",
  "git `echo branch -D victim`",
  "f() { git \"$@\"; }; f branch -D victim",
  "echo \"branch -D victim\" | xargs git",
  "echo \"worktree remove ../wt\" | xargs git",
  "A=\"branch -D victim\"; git $A",
  "printf 'pr merge 5 -d' | xargs gh",
  "git $SUB victim",
  "gh $A",
  "gh pr $ACTION 5",
  "bash -c -- 'git branch -D victim'",
  "bash -c -x 'git branch -D victim'",
  "bash -o pipefail -c 'git branch -D victim'",
  "\"$(git --exec-path)/git-branch\" -D victim",
  "/usr/libexec/git-core/git-branch -D victim",
  "git-worktree remove ../x",
  "git-update-ref -d refs/heads/x",
  "git update-ref refs/heads/victim 0000000000000000000000000000000000000000",
  "git push . --delete victim",
  "git push . :victim",
  "git push \"$R\" :victim",
  "git push ../other +:victim",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=\"branch -D\" git x victim",
  "GIT_CONFIG_PARAMETERS=\"'alias.x=branch -D'\" git x victim",
  "(( a = 1 << 2 ))\ngit branch -D victim",
  "((git branch -D x); true)",
  "((git branch -D x); (true))",
  "git -c core.fsmonitor=\"git branch -D victim; false\" status",
  "X=\"git branch -D v\"; $X",
  "CMD=\"git branch -D x\"; eval $CMD",
  "CMD=\"git branch -D x\"; bash -c \"$CMD\"",
  "echo \"git branch -D x\" | sh",
  "X=\"git worktree prune\"; \"$@\"",
  "gh pr merge 5 -t \"$T\" -d",
  "gh pr merge 5 \"$FLAG\"",
  "gh pr merge 5 --body \"$B\" --delete-branch",
  `echo ${LONG}; git branch -D x`,
  // The 2026-11-15 slip, verbatim.
  'git worktree remove .../langfuse-fac7 && git branch -d "$B" || git branch -D "$B"',
  'gh pr merge 35 --merge --delete-branch --match-head-commit abc123',
  // A shell after a command that can run its arguments is still a shell.
  'sudo bash -c "git branch -D x"', 'FOO=1 bash -c "git branch -D x"', 'git bisect run bash -c "git branch -D x"', 'git branch -D bash',
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
  'gh pr merge 46 --merge "$(printf \'a -d b\')"', // a substituted value that is not an option's value could be -d
  // inline aliases, and text that cannot be parsed but names the commands
  'git -c alias.nuke="branch -D" nuke x', 'git -c "$ALIAS" nuke x', 'git branch -D "unterminated', 'gh pr merge 1 -d "unterminated',
];

// Every one must run.
const ALLOWED = [
  // Round 2 (Opus): a quoted value attached to a git or gh option; process substitution as a redirect target.
  "git --work-tree=\"$WT\" status",
  "git --git-dir=\"$HOME/.dotfiles\" --work-tree=\"$HOME\" status",
  "gh --repo=\"$R\" pr view 5",
  "while read b; do echo \"$b\"; done < <(git branch --list)",
  "ls | xargs -L1 sh -c",
  // Round 2: `git` as data in another program's arguments, positional parameters after a -c script, a checked git after a keyword.
  'git push -odeploy ../mirror HEAD', 'gh pr merge 5 --squash -t"Update"', 'find . -exec sh -c \'echo "$1"\' _ git branch -D {} \\;',
  'git push -q . HEAD:refs/heads/new', 'git push -d origin old', 'npm view git "$FIELD"', 'node -e \'console.log(process.argv.slice(1))\' git "$MODE"',
  'bash -c \'printf "%s\\n" "$@"\' _ git branch -D example', 'if git branch --show-current; then eval "$(ssh-agent -s)"; fi', 'gh pr merge 5 --squash -t"$TITLE"',
  // Round-1 synthesis: data is not a command.
  'sudo git branch feature/bash', 'echo git branch -D example', 'bash -c \'printf "%s" "$1"\' _ "git branch -D example"', 'rg GIT_CONFIG_COUNT',
  'git update-ref refs/heads/new HEAD 0000000000000000000000000000000000000000', 'git push git@github.com:a/b.git :old', 'env -S "git status" --short',
  'gh pr merge 5 --squash --body="$BODY"', 'node tool.js GIT_CONFIG_COUNT=1',
  // Round-1 review: a script file beside a git command, an option value that is never a flag, a harmless unknown command.
  "git worktree add ../wt -b feat && cd ../wt && bash scripts/setup.sh",
  "git switch -c fix/branch-guard && bash scripts/check.sh",
  "git worktree list && sh -e scripts/test.sh",
  "eval \"$(ssh-agent -s)\" && git worktree list",
  "git branch --show-current; bash -c \"echo $HOME\"",
  "gh pr merge 12 --squash -t \"$TITLE\"",
  "gh pr merge 12 --squash -b \"$BODY\"",
  "gh pr merge 46 --merge --body \"$(printf 'a -d b')\"",
  "gh pr merge 5 --squash --match-head-commit \"$SHA\"",
  "git update-ref refs/heads/x abc",
  "git push origin :old-remote-branch",
  "git push -u origin \"$(git branch --show-current)\"",
  "git push . HEAD:refs/heads/new",
  "(( a = 1 << 2 ))\ngit status",
  "for i in 1 2; do (( n++ )); done; git branch --list",
  "\"$BIN\" --version",
  "$EDITOR notes.md",
  "git branch --show-current; $RUNNER test",
  "B=$(git branch --show-current); echo \"$B\"",
  "gh api \"$URL\"",
  "gh pr view \"$N\"",
  "git checkout \"$B\"",
  "git worktree list | xargs echo",
  "find . -name \"*.js\" | xargs git add",
  "git -c user.name=x commit -m \"about git branch\"",
  `echo ${LONG}`,
  // A script file is not read, even when the line names a guarded command elsewhere.
  'echo "see the git branch docs" && bash scripts/setup.sh',
  // A shell's name as data: a branch name, a path, a search pattern.
  'git branch --list | grep -v bash', 'git branch feature/bash', 'git worktree add ../bash -b feature/bash', 'git checkout -b eval', 'which bash && git branch --list', 'GIT_PAGER=cat git branch feature/bash',
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

test('the guard refuses a branch delete, worktree removal and merge --delete-branch written as a command, through wrappers and unknown values', () => {
  for (const command of BLOCKED) {
    const refusal = checkCommand(command);
    assert.ok(refusal, `should block: ${JSON.stringify(command)}`);
    assert.match(refusal, /merge-pr\.js/);
    assert.match(refusal, /agent-env\.js teardown/);
  }
});

test('the guard lets ordinary commands run, including text that only mentions the blocked commands', () => {
  for (const command of ALLOWED) assert.equal(checkCommand(command), null, `should allow: ${JSON.stringify(command)}`);
  // A very long line is not parsed, so the check cannot outlast the hook's timeout.
  const started = Date.now();
  assert.equal(checkCommand(`echo ${'a '.repeat(400000)}`), null);
  assert.ok(Date.now() - started < 5000, 'a very long command is answered quickly');
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
  const vendored = { type: 'command', command: 'node ./vendor/runtime/guard/claude-hook.cjs' };
  // A project command that runs the guard and then something of its own is the project's, not this installer's.
  const audited = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.agent-brain/guard/claude-hook.cjs" && node audit.cjs' };
  const current = {
    claude: { enabledPlugins: { x: true }, hooks: { SessionStart: [{ hooks: [langfuse] }], PreToolUse: [
      { matcher: '^(?:Agent|Task|Skill)$', hooks: [langfuse] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: CLAUDE_GUARD_COMMAND, timeout: 3 }, own] },
      { matcher: 'Edit', hooks: [own] },
      { matcher: 'Bash', hooks: [vendored, audited] },
    ] } },
    pi: { packages: ['npm:x'], extensions: ['../.agent-brain/observability/pi.js', PI_GUARD_EXTENSION, 'mine.ts', PI_GUARD_EXTENSION, './vendor/runtime/guard/pi.cjs'] },
  };
  const next = withGuard(current);
  assert.deepEqual(next.claude.enabledPlugins, { x: true });
  assert.deepEqual(next.claude.hooks.SessionStart, current.claude.hooks.SessionStart);
  assert.deepEqual(next.claude.hooks.PreToolUse, [
    { matcher: '^(?:Agent|Task|Skill)$', hooks: [langfuse] },
    { matcher: CLAUDE_GUARD_MATCHER, hooks: [{ type: 'command', command: CLAUDE_GUARD_COMMAND, timeout: 10 }] },
    { matcher: 'Bash', hooks: [own] },
    { matcher: 'Edit', hooks: [own] },
    // A file of the same name somewhere else is the project's own hook and stays.
    { matcher: 'Bash', hooks: [vendored, audited] },
  ]);
  assert.deepEqual(next.pi, { packages: ['npm:x'], extensions: ['../.agent-brain/observability/pi.js', PI_GUARD_EXTENSION, 'mine.ts', './vendor/runtime/guard/pi.cjs'] });
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
  // A settings file keeps its mode, whatever the umask.
  for (const rel of ['.claude/settings.json', '.pi/settings.json']) fs.chmodSync(path.join(target, rel), 0o664);
  const umask = process.umask(0o022);
  const res = pull(target);
  process.umask(umask);
  for (const rel of ['.claude/settings.json', '.pi/settings.json']) assert.equal(fs.statSync(path.join(target, rel)).mode & 0o777, 0o664, rel);
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

test('a new settings file gets the mode the umask allows', () => {
  const file = path.join(tmpDir('newmode'), '.pi/settings.json');
  const umask = process.umask(0o077);
  require('./lib/native-settings').atomicJSON(file, { extensions: [] });
  process.umask(umask);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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
