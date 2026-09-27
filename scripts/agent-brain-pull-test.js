'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildBrain, assertSafeOutput, splitFrontmatter } = require('./lib/build-brain');
const { pullInstall, planInstall, validateRelPath, mergeProjectAgents, STATE_PATH } = require('./lib/pull-install');

const ROOT = path.resolve(__dirname, '..');

const temporaryDirs = [];
test.after(() => {
  for (const dir of temporaryDirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-brain-${name}-`));
  temporaryDirs.push(dir);
  return dir;
}

function sourceFixture() {
  const root = tmpDir('source');
  for (const entry of ['manifest.json', 'project', 'skills', 'agents', 'references', 'templates', 'docs', '.claude', '.gemini', '.pi', '.codex', 'commands']) {
    fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  }
  return root;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function state(target) {
  return readJson(path.join(target, STATE_PATH));
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'agent-brain.js'), ...args], {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, HOME: opts.home || tmpDir('home') },
    encoding: 'utf8'
  });
}

test('fresh install uses full tool-local copies, state, idempotence, and no global writes', () => {
  const target = tmpDir('fresh');
  const home = tmpDir('home');
  const res = runCli(['pull', '--target', target], { home });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(target, 'SOUL.md')));
  assert.ok(fs.existsSync(path.join(target, '.agents/skills/coding-standards/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(target, 'skills')));
  assert.ok(!fs.existsSync(path.join(target, 'agents')));
  for (const host of ['.pi', '.hermes', '.gemini']) {
    for (const dir of ['skills', 'references', 'templates']) assert.ok(!fs.existsSync(path.join(target, host, dir)), `unnecessary copy: ${host}/${dir}`);
  }
  assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'brain.md')));
  assert.ok(fs.existsSync(path.join(target, '.gemini', 'commands', 'brain.toml')));
  assert.ok(fs.existsSync(path.join(target, '.pi', 'prompts', 'brain.md')));
  assert.ok(fs.existsSync(path.join(target, '.codex', 'prompts', 'brain.md')));
  assert.ok(!fs.existsSync(path.join(target, 'README.md')), 'consumer README must not be installed');
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'installer must not write global codex prompts');

  for (const host of ['.agents', '.claude']) {
    assert.deepEqual(fs.readFileSync(path.join(target, host, 'skills/coding-standards/SKILL.md')), fs.readFileSync(path.join(ROOT, 'skills/coding-standards/SKILL.md')));
    assert.deepEqual(fs.readFileSync(path.join(target, host, 'references/security-checklist.md')), fs.readFileSync(path.join(ROOT, 'references/security-checklist.md')));
    assert.deepEqual(fs.readFileSync(path.join(target, host, 'templates/ADR.md')), fs.readFileSync(path.join(ROOT, 'templates/ADR.md')));
  }
  for (const host of ['.agents', '.claude', '.gemini', '.pi']) {
    assert.deepEqual(fs.readFileSync(path.join(target, host, 'agents/backend-engineer.md')), fs.readFileSync(path.join(ROOT, 'agents/backend-engineer.md')));
  }
  assert.match(fs.readFileSync(path.join(target, '.claude/commands/brain.md'), 'utf8'), /\.claude\/skills\//);
  assert.match(fs.readFileSync(path.join(target, '.pi/prompts/brain.md'), 'utf8'), /\.pi\/agents\//);
  for (const file of ['.pi/prompts/brain.md', '.codex/prompts/brain.md', '.gemini/commands/brain.toml']) {
    const command = fs.readFileSync(path.join(target, file), 'utf8');
    assert.match(command, /\.agents\/skills\//);
    assert.doesNotMatch(command, /\.(pi|hermes|gemini)\/skills\//);
  }
  assert.match(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), /\.agents\/skills\//);

  const firstState = state(target);
  assert.equal(firstState.schema, 1);
  assert.ok(firstState.files.length > 50);
  assert.ok(firstState.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256) && ['0644', '0755'].includes(f.mode)));
  const executableScript = firstState.files.find(f => f.path === '.agents/skills/development-setup/scripts/cloud-up.sh');
  assert.equal(executableScript && executableScript.mode, '0755');
  assert.notEqual(fs.statSync(path.join(target, executableScript.path)).mode & 0o111, 0);

  const second = runCli(['pull', '--target', target], { home });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already up to date/);
  assert.deepEqual(state(target), firstState);
});

test('migration replaces wrappers and removes only previously managed root copies', () => {
  const target = tmpDir('old-layout');
  const oldFiles = ['skills/coding-standards/SKILL.md', 'agents/backend-engineer.md'];
  const entries = oldFiles.map(rel => {
    const content = fs.readFileSync(path.join(ROOT, rel));
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), content);
    return { path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex'), mode: '0644' };
  });
  fs.mkdirSync(path.join(target, '.agent-brain'));
  fs.writeFileSync(path.join(target, STATE_PATH), JSON.stringify({ schema: 1, files: entries }));
  fs.mkdirSync(path.join(target, '.claude/skills/coding-standards'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude/skills/coding-standards/SKILL.md'), 'Read ../../../skills/coding-standards/SKILL.md');
  pullInstall({ sourceRoot: ROOT, target });
  assert.ok(!fs.existsSync(path.join(target, 'skills')));
  assert.ok(!fs.existsSync(path.join(target, 'agents')));
  assert.deepEqual(fs.readFileSync(path.join(target, '.claude/skills/coding-standards/SKILL.md')), fs.readFileSync(path.join(ROOT, 'skills/coding-standards/SKILL.md')));
  assert.equal(pullInstall({ sourceRoot: ROOT, target }).plan.writes.length, 0);
});

test('existing harness folders do not trigger extra copies; managed duplicates are retired', () => {
  const target = tmpDir('shared-discovery');
  const entries = [];
  for (const host of ['.pi', '.hermes', '.gemini']) {
    for (const file of ['skills/adrs/SKILL.md', 'references/security-checklist.md', 'templates/ADR.md']) {
      const rel = `${host}/${file}`;
      const content = fs.readFileSync(path.join(ROOT, file));
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.writeFileSync(path.join(target, rel), content);
      entries.push({ path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex'), mode: '0644' });
    }
    fs.mkdirSync(path.join(target, host, 'skills/custom'), { recursive: true });
    fs.writeFileSync(path.join(target, host, 'skills/custom/SKILL.md'), 'unrelated third-party skill');
    fs.writeFileSync(path.join(target, host, 'settings.json'), '{"keep":"unchanged"}\n');
  }
  fs.mkdirSync(path.join(target, '.agent-brain'));
  fs.writeFileSync(path.join(target, STATE_PATH), JSON.stringify({ schema: 1, files: entries }));
  const result = pullInstall({ sourceRoot: ROOT, target });
  assert.equal(result.plan.prunes.length, 9);
  for (const host of ['.pi', '.hermes', '.gemini']) {
    assert.ok(!fs.existsSync(path.join(target, host, 'skills/adrs')));
    assert.ok(!fs.existsSync(path.join(target, host, 'references')));
    assert.equal(fs.readFileSync(path.join(target, host, 'skills/custom/SKILL.md'), 'utf8'), 'unrelated third-party skill');
    assert.equal(fs.readFileSync(path.join(target, host, 'settings.json'), 'utf8'), '{"keep":"unchanged"}\n');
  }
  assert.ok(fs.existsSync(path.join(target, '.agents/skills/adrs/SKILL.md')));
  assert.equal(pullInstall({ sourceRoot: ROOT, target }).plan.writes.length, 0);
});

test('build copies Terraform sources but excludes generated state and local settings', () => {
  const source = sourceFixture();
  const dir = path.join(source, 'skills/development-setup/terraform');
  fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
  for (const file of ['terraform.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', '.terraform/private']) fs.writeFileSync(path.join(dir, file), 'do not distribute');
  const target = tmpDir('terraform-target');
  pullInstall({ sourceRoot: source, target });
  const installed = path.join(target, '.agents/skills/development-setup/terraform');
  assert.ok(fs.existsSync(path.join(installed, 'main.tf')));
  for (const file of ['terraform.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', '.terraform']) assert.ok(!fs.existsSync(path.join(installed, file)));
});

test('dry-run is nonmutating', () => {
  const target = tmpDir('dryrun');
  const res = runCli(['pull', '--target', target, '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /would install/);
  assert.ok(!fs.existsSync(path.join(target, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(target, '.agent-brain')));
});

test('ambiguous AGENTS.md refuses before partial writes', () => {
  const target = tmpDir('conflict');
  fs.writeFileSync(path.join(target, 'AGENTS.md'), 'local file\n');
  const res = runCli(['pull', '--target', target]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /exactly one "## This project" heading/);
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), 'local file\n');
  assert.ok(!fs.existsSync(path.join(target, 'SOUL.md')));
  assert.ok(!fs.existsSync(path.join(target, '.agent-brain')));
});

test('brain files are replaced on first install and subsequent pulls without backups', () => {
  const target = tmpDir('replace');
  const rel = '.agents/skills/test-driven-development/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
  fs.writeFileSync(path.join(target, rel), 'old copied skill\n');
  fs.writeFileSync(path.join(target, '.env.example'), 'OLD_EXAMPLE=old\n');
  fs.writeFileSync(path.join(target, '.env'), 'PROJECT_PRIVATE=untouched\n');
  pullInstall({ sourceRoot: ROOT, target });
  const expected = fs.readFileSync(path.join(ROOT, 'skills/test-driven-development/SKILL.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), expected);
  fs.writeFileSync(path.join(target, rel), 'local edit discarded\n');
  pullInstall({ sourceRoot: ROOT, target });
  assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), expected);
  assert.deepEqual(fs.readFileSync(path.join(target, '.env.example')), fs.readFileSync(path.join(ROOT, 'project/.env.example')));
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'PROJECT_PRIVATE=untouched\n');
  assert.deepEqual(fs.readdirSync(path.join(target, '.agent-brain')), ['install-state.json']);
});

test('updates and retired file pruning ignore local edits to brain-owned files', () => {
  const target = tmpDir('update-prune');
  pullInstall({ sourceRoot: ROOT, target });
  const tmp = tmpDir('build');
  const buildDir = path.join(tmp, 'build');
  buildBrain({ root: ROOT, out: buildDir });
  fs.writeFileSync(path.join(buildDir, 'AGENTS.md'), '# New shared instructions\n' + fs.readFileSync(path.join(buildDir, 'AGENTS.md'), 'utf8'));
  fs.rmSync(path.join(buildDir, '.codex', 'prompts', 'brain.md'));
  const plan = planInstall(ROOT, target, buildDir);
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.writes.includes('AGENTS.md'));
  assert.ok(plan.prunes.includes('.codex/prompts/brain.md'));

  fs.appendFileSync(path.join(target, '.codex', 'prompts', 'brain.md'), '\nlocal edit\n');
  const editedRetired = planInstall(ROOT, target, buildDir);
  assert.deepEqual(editedRetired.conflicts, []);
  assert.ok(editedRetired.prunes.includes('.codex/prompts/brain.md'));
});

test('pullInstall applies updates and prunes unmodified retired files', () => {
  const target = tmpDir('apply-update-prune');
  pullInstall({ sourceRoot: ROOT, target });
  const source = sourceFixture();
  const manifest = readJson(path.join(source, 'manifest.json'));
  manifest.skills = manifest.skills.filter(s => s !== 'test-driven-development');
  fs.writeFileSync(path.join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'project', 'SOUL.md'), '# Changed soul\n');

  const result = pullInstall({ sourceRoot: source, target });
  assert.match(result.message, /prune retired/);
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), '# Changed soul\n');
  assert.ok(!fs.existsSync(path.join(target, '.agents/skills/test-driven-development/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(target, '.claude', 'skills', 'test-driven-development', 'SKILL.md')));
  assert.ok(!state(target).files.some(f => f.path.includes('test-driven-development')));
});

test('first install adopts preexisting identical files', () => {
  const target = tmpDir('adopt');
  fs.copyFileSync(path.join(ROOT, 'project', 'SOUL.md'), path.join(target, 'SOUL.md'));
  const result = pullInstall({ sourceRoot: ROOT, target });
  assert.match(result.message, /adopt identical:\n  SOUL\.md/);
  assert.ok(state(target).files.some(f => f.path === 'SOUL.md'));
});

test('symlink path components are refused', () => {
  const target = tmpDir('symlink');
  const outside = tmpDir('outside');
  fs.mkdirSync(path.join(target, '.agents'));
  fs.symlinkSync(outside, path.join(target, '.agents/skills'), 'dir');
  const res = runCli(['pull', '--target', target]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /path component is not a directory/);
  assert.ok(!fs.existsSync(path.join(target, '.agent-brain')));

  const stateTarget = tmpDir('state-symlink');
  fs.symlinkSync(outside, path.join(stateTarget, '.agent-brain'), 'dir');
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target: stateTarget }), /state directory is not a directory/);
  assert.ok(!fs.existsSync(path.join(outside, 'install-state.json')));
});

test('tampered state is rejected as untrusted input', () => {
  const target = tmpDir('tamper');
  pullInstall({ sourceRoot: ROOT, target });
  const stateFile = path.join(target, STATE_PATH);
  const cleanState = state(target);
  const s = structuredClone(cleanState);
  s.files[0].sha256 = 'not-a-hash';
  fs.writeFileSync(stateFile, JSON.stringify(s));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /malformed hash/);

  s.files[0].sha256 = 'a'.repeat(64);
  s.files[0].path = '..\\escape';
  fs.writeFileSync(stateFile, JSON.stringify(s));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /backslash/);

  s.files[0].path = 'C:/escape';
  fs.writeFileSync(stateFile, JSON.stringify(s));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /absolute paths/);

  const duplicate = structuredClone(cleanState);
  duplicate.files.push({ ...duplicate.files[0] });
  fs.writeFileSync(stateFile, JSON.stringify(duplicate));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /duplicate path/);

  const reserved = structuredClone(cleanState);
  reserved.files[0].path = '.agent-brain/install-state.json';
  fs.writeFileSync(stateFile, JSON.stringify(reserved));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /reserved state path/);
});

test('state cannot manage or prune VCS and outside-layout paths', () => {
  const target = tmpDir('state-layout');
  fs.mkdirSync(path.join(target, '.git'), { recursive: true });
  const gitHead = path.join(target, '.git', 'HEAD');
  fs.writeFileSync(gitHead, 'ref: refs/heads/main\n');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(gitHead)).digest('hex');
  fs.mkdirSync(path.join(target, '.agent-brain'), { recursive: true });
  fs.writeFileSync(path.join(target, STATE_PATH), JSON.stringify({ schema: 1, files: [{ path: '.git/HEAD', sha256: hash, mode: '0644' }] }));

  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /reserved or unsafe path|outside managed brain layout/);
  assert.equal(fs.readFileSync(gitHead, 'utf8'), 'ref: refs/heads/main\n');
});

test('dangling symlinks at managed paths and state paths are refused without writes', () => {
  const finalTarget = tmpDir('dangling-final');
  fs.symlinkSync(path.join(finalTarget, 'missing'), path.join(finalTarget, 'AGENTS.md'));
  const finalRes = runCli(['pull', '--target', finalTarget]);
  assert.notEqual(finalRes.status, 0);
  assert.match(finalRes.stderr, /not a regular file/);
  assert.ok(!fs.existsSync(path.join(finalTarget, 'SOUL.md')));
  assert.ok(!fs.existsSync(path.join(finalTarget, '.agent-brain')));

  const parentTarget = tmpDir('dangling-parent');
  fs.mkdirSync(path.join(parentTarget, '.agents'));
  fs.symlinkSync(path.join(parentTarget, 'missing-dir'), path.join(parentTarget, '.agents/skills'));
  const parentRes = runCli(['pull', '--target', parentTarget]);
  assert.notEqual(parentRes.status, 0);
  assert.match(parentRes.stderr, /path component is not a directory/);
  assert.ok(!fs.existsSync(path.join(parentTarget, 'SOUL.md')));

  const stateDirTarget = tmpDir('dangling-state-dir');
  fs.symlinkSync(path.join(stateDirTarget, 'missing-state-dir'), path.join(stateDirTarget, '.agent-brain'));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target: stateDirTarget }), /state directory is not a directory/);

  const stateFileTarget = tmpDir('dangling-state-file');
  fs.mkdirSync(path.join(stateFileTarget, '.agent-brain'));
  fs.symlinkSync(path.join(stateFileTarget, 'missing-state-file'), path.join(stateFileTarget, STATE_PATH));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target: stateFileTarget }), /state file is not a regular file/);
  assert.ok(!fs.existsSync(path.join(stateFileTarget, 'AGENTS.md')));
});

test('source and target overlap is refused before mutation', () => {
  const source = sourceFixture();
  const child = path.join(source, 'tmp-overlap-target');
  fs.mkdirSync(child, { recursive: true });
  assert.throws(() => pullInstall({ sourceRoot: source, target: child }), /overlapping source and target/);
  assert.ok(!fs.existsSync(path.join(child, '.agent-brain')));

  const aliasParent = tmpDir('alias-parent');
  const alias = path.join(aliasParent, 'source-link');
  fs.symlinkSync(source, alias, 'dir');
  assert.throws(() => pullInstall({ sourceRoot: source, target: path.join(alias, 'tmp-overlap-target') }), /overlapping source and target/);
});

test('source frontmatter preserves CRLF exactly and invalid frontmatter fails', () => {
  const crlf = '---\r\nname: sample\r\ndescription: Use when testing.\r\n---\r\n# Body\r\n';
  assert.equal(splitFrontmatter(crlf).frontmatter, '---\r\nname: sample\r\ndescription: Use when testing.\r\n---\r\n');
  assert.throws(() => splitFrontmatter('---\nname: missing-description\n---\n# Body\n'), /requires name and description frontmatter/);
});

test('builder output protections reject source descendants, aliases, symlinks, and nonempty external dirs before deletion', () => {
  const source = sourceFixture();
  const sentinel = path.join(source, 'skills', 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep');
  assert.throws(() => buildBrain({ root: source, out: path.join(source, 'skills') }), /overlapping source/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');

  const aliasParent = tmpDir('build-alias');
  const alias = path.join(aliasParent, 'source-link');
  fs.symlinkSync(source, alias, 'dir');
  assert.throws(() => buildBrain({ root: source, out: path.join(alias, 'docs') }), /overlapping source/);
  assert.ok(fs.existsSync(path.join(source, 'docs', 'skill-anatomy.md')));

  const external = tmpDir('external-out');
  fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
  assert.throws(() => buildBrain({ root: source, out: external }), /external output must be empty/);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');

  const symlinkOut = path.join(tmpDir('symlink-out'), 'out');
  fs.symlinkSync(tmpDir('symlink-out-real'), symlinkOut, 'dir');
  assert.throws(() => buildBrain({ root: source, out: symlinkOut }), /output must be a directory/);
});

test('case-alias source output is rejected when filesystem resolves it', (t) => {
  const source = sourceFixture();
  const variant = source.replace(/agent-brain-source-/, 'AGENT-BRAIN-SOURCE-');
  if (variant === source || !fs.existsSync(variant)) t.skip('filesystem is case-sensitive for the temp path');
  assert.equal(fs.realpathSync.native(variant), fs.realpathSync.native(source));
  assert.throws(() => buildBrain({ root: source, out: path.join(variant, 'skills') }), /overlapping source/);
});

test('package tarball includes dot assets and CLI works from extracted package', () => {
  const packDir = tmpDir('pack');
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT, encoding: 'utf8' });
  const tarball = path.join(packDir, JSON.parse(out)[0].filename);
  const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  assert.match(list, /package\/\.claude\/commands\/brain\.md/);
  assert.match(list, /package\/\.gemini\/commands\/brain\.toml/);
  assert.match(list, /package\/\.pi\/prompts\/brain\.md/);
  assert.match(list, /package\/\.codex\/prompts\/brain\.md/);
  assert.match(list, /package\/project\/\.env\.example/);
  assert.match(list, /package\/scripts\/agent-brain\.js/);

  const extract = tmpDir('extract');
  execFileSync('tar', ['-xzf', tarball, '-C', extract]);
  const target = tmpDir('package-target');
  const res = spawnSync(process.execPath, [path.join(extract, 'package', 'scripts', 'agent-brain.js'), 'pull', '--target', target], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(target, '.agents', 'skills', 'coding-standards', 'SKILL.md')));

  const binTarget = tmpDir('npm-bin-target');
  const binResult = spawnSync('npm', ['exec', '--yes', '--offline', '--cache', tmpDir('npm-cache'), '--package', tarball, '--', 'agent-brain', 'pull'], { cwd: binTarget, encoding: 'utf8' });
  assert.equal(binResult.status, 0, binResult.stderr);
  assert.ok(fs.existsSync(path.join(binTarget, STATE_PATH)));
});

test('foreign state cannot claim Git internals or arbitrary project files', () => {
  const target = tmpDir('foreign-state');
  fs.mkdirSync(path.join(target, '.git'));
  const head = 'ref: refs/heads/main\n';
  fs.writeFileSync(path.join(target, '.git/HEAD'), head);
  fs.mkdirSync(path.join(target, '.agent-brain'));
  fs.writeFileSync(path.join(target, STATE_PATH), JSON.stringify({ schema: 1, files: [{ path: '.git/HEAD', sha256: crypto.createHash('sha256').update(head).digest('hex'), mode: '0644' }] }));
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /reserved or unsafe path/);
  assert.equal(fs.readFileSync(path.join(target, '.git/HEAD'), 'utf8'), head);
  assert.ok(!fs.existsSync(path.join(target, 'AGENTS.md')));
  for (const name of ['README.md', 'package.json', 'src/app.js', '.hg/store', 'skills/foo/.git/config', 'references/C:secret', 'references/NUL', 'references/file.']) {
    assert.throws(() => validateRelPath(name), /invalid/);
  }
});

test('dangling symlinks at files, parents, and state are refused before writes', () => {
  for (const rel of ['AGENTS.md', '.agents/skills', '.agent-brain', STATE_PATH]) {
    const target = tmpDir('dangling');
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(path.join(target, 'missing'), dest);
    assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /not a (regular file|directory)/);
    assert.ok(fs.lstatSync(dest).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(target, 'SOUL.md')));
  }
});

test('realpath aliases cannot bypass source overlap or erase source via build output', () => {
  const source = sourceFixture();
  const aliases = tmpDir('aliases');
  const alias = path.join(aliases, 'source');
  fs.symlinkSync(source, alias, 'dir');
  fs.mkdirSync(path.join(source, 'consumer'));
  assert.throws(() => pullInstall({ sourceRoot: source, target: path.join(alias, 'consumer') }), /overlapping/);
  assert.ok(!fs.existsSync(path.join(source, 'consumer', STATE_PATH)));
  const before = fs.readFileSync(path.join(source, 'docs/skill-anatomy.md'));
  for (const out of [source, path.dirname(source), path.join(source, 'skills'), path.join(alias, 'docs')]) {
    assert.throws(() => buildBrain({ root: source, out }), /refusing output overlapping/);
  }
  assert.deepEqual(fs.readFileSync(path.join(source, 'docs/skill-anatomy.md')), before);
  const external = tmpDir('nonempty-output');
  fs.writeFileSync(path.join(external, 'keep'), 'local');
  assert.throws(() => assertSafeOutput(source, external), /must be empty/);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'local');
  const caseVariant = path.join(path.dirname(source), path.basename(source).toUpperCase());
  if (fs.existsSync(caseVariant) && fs.statSync(caseVariant).ino === fs.statSync(source).ino) {
    assert.throws(() => pullInstall({ sourceRoot: source, target: caseVariant }), /overlapping/);
  }
});

test('updates, identical adoption and pruning work end to end', () => {
  const source = sourceFixture();
  const target = tmpDir('end-to-end');
  fs.writeFileSync(path.join(source, 'references/retired.md'), 'old reference\n');
  fs.copyFileSync(path.join(source, 'project/SOUL.md'), path.join(target, 'SOUL.md'));
  const first = pullInstall({ sourceRoot: source, target });
  assert.ok(first.plan.adopts.includes('SOUL.md'));
  fs.appendFileSync(path.join(source, 'project/SOUL.md'), '\nupdated\n');
  fs.unlinkSync(path.join(source, 'references/retired.md'));
  const second = pullInstall({ sourceRoot: source, target });
  assert.ok(second.plan.writes.includes('SOUL.md'));
  assert.ok(second.plan.prunes.includes('references/retired.md'));
  assert.match(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), /updated/);
  assert.ok(!fs.existsSync(path.join(target, 'references/retired.md')));
  // A retired file replaced with a broken symlink must also block the update.
  fs.writeFileSync(path.join(source, 'references/retired.md'), 'old reference\n');
  pullInstall({ sourceRoot: source, target });
  fs.unlinkSync(path.join(source, 'references/retired.md'));
  fs.unlinkSync(path.join(target, 'references/retired.md'));
  fs.symlinkSync(path.join(target, 'missing'), path.join(target, 'references/retired.md'));
  assert.throws(() => pullInstall({ sourceRoot: source, target }), /not a regular file/);
});

test('AGENTS.md updates shared content while preserving only the project section', () => {
  const target = tmpDir('project-section');
  const projectSection = '## This project\n\nFreedo is a brownfield project.\n';
  fs.writeFileSync(path.join(target, 'AGENTS.md'), '# Old shared rules\n\n' + projectSection);
  fs.writeFileSync(path.join(target, '.env.example'), 'OLD_EXAMPLE=old\n');
  fs.mkdirSync(path.join(target, '.agent-brain'));
  // Upgrade from the earlier preservation-based installer without manual edits.
  fs.writeFileSync(path.join(target, STATE_PATH), JSON.stringify({ schema: 1, files: [], localFiles: ['AGENTS.md', '.env.example'] }));
  pullInstall({ sourceRoot: ROOT, target });
  const installed = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  assert.ok(installed.startsWith('# Agent Organization'));
  assert.ok(installed.endsWith(projectSection));
  assert.ok(!installed.includes('Old shared rules'));
  assert.equal(state(target).localFiles, undefined);
  assert.deepEqual(fs.readFileSync(path.join(target, '.env.example')), fs.readFileSync(path.join(ROOT, 'project/.env.example')));
  assert.equal(pullInstall({ sourceRoot: ROOT, target }).plan.writes.length, 0);
  fs.appendFileSync(path.join(target, 'AGENTS.md'), 'Project-only edit\n');
  pullInstall({ sourceRoot: ROOT, target });
  assert.ok(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8').endsWith('Project-only edit\n'));
});

test('AGENTS migration repairs only exact installed brain paths in project notes', () => {
  const target = tmpDir('project-paths');
  fs.writeFileSync(path.join(target, 'AGENTS.md'), '# Old shared\n\n## This project\nBrownfield note. Run `skills/linear/scripts/create-workflow.sh`. Keep `skills/custom/tool.sh`.\n');
  pullInstall({ sourceRoot: ROOT, target });
  const installed = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  assert.match(installed, /Brownfield note\. Run `\.agents\/skills\/linear\/scripts\/create-workflow\.sh`\. Keep `skills\/custom\/tool\.sh`/);
});

test('project section merging keeps source sections after it and rejects duplicates', () => {
  const source = '# Shared\n\n## This project\nDefault\n\n## More shared rules\nNew\n';
  const current = '# Old\n\n## This project\nLocal\n\n## More shared rules\nOld\n';
  assert.equal(mergeProjectAgents(source, current), '# Shared\n\n## This project\nLocal\n\n## More shared rules\nNew\n');
  assert.throws(() => mergeProjectAgents(source, current + '\n## This project\nDuplicate\n'), /exactly one/);
});

test('source frontmatter accepts CRLF and rejects missing metadata', () => {
  const frontmatter = '---\r\nname: example\r\ndescription: Example skill\r\n---\r\n';
  assert.equal(splitFrontmatter(`${frontmatter}body`).frontmatter, frontmatter);
  assert.throws(() => splitFrontmatter('# No metadata'), /requires name and description/);
});
