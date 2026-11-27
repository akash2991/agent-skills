'use strict';

const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { compareVersions, nextVersions, readBrainVersion, changelogErrors, sectionsBetween, describeDrift } = require('./lib/brain-version');
const { validate, shippedMatcher } = require('./validate-changelog');
const { pullInstall, installStatus, STATE_PATH, CHANGELOG_PATH } = require('./lib/pull-install');
const { validateManagedRelPath } = require('./lib/install-paths');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = readBrainVersion(ROOT);

const temporaryDirs = [];
test.after(() => {
  for (const dir of temporaryDirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `brain-version-${name}-`));
  temporaryDirs.push(dir);
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function log(...sections) {
  return `# Changelog\n\nIntro.\n\n${sections.map(([version, entry]) => `## ${version} - 2026-01-02\n\n### Changed\n- ${entry}\n`).join('\n')}`;
}

// A copy of the brain at a later version, with one changelog section per step.
function laterSource(steps) {
  const root = tmpDir('source');
  for (const entry of ['manifest.json', 'package.json', 'CHANGELOG.md', 'project', 'skills', 'agents', 'references', 'templates', 'runtime', '.claude', '.gemini', '.pi', '.codex', 'commands']) {
    fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true, filter: src => !/(^|[\\/])(node_modules|\.terraform|terraform\.tfvars|[^/\\]*\.tfplan)$/.test(src) });
  }
  let changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  let version = CURRENT;
  for (const [version_, entry] of steps) {
    version = version_;
    changelog = changelog.replace(/^## /m, `## ${version} - 2026-12-01\n\n### Changed\n- ${entry}\n\n## `);
  }
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  const pkg = readJson(path.join(root, 'package.json'));
  pkg.version = version;
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return root;
}

test('versions compare and step by semver', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.throws(() => compareVersions('1.2', '1.2.0'), /not a semver version/);
  assert.throws(() => compareVersions('1.2.0', 'v1.2.0'), /not a semver version/);
  assert.deepEqual(nextVersions('1.4.7'), ['2.0.0', '1.5.0', '1.4.8']);
  assert.equal(describeDrift(null, '1.0.0').kind, 'unversioned');
  assert.equal(describeDrift('1.0.0', '1.0.0').kind, 'same');
  assert.equal(describeDrift('1.0.0', '1.0.1').line, 'brain: 1.0.0 → 1.0.1 (patch)');
  assert.equal(describeDrift('1.0.9', '1.1.0').kind, 'minor');
  assert.equal(describeDrift('1.9.9', '2.0.0').kind, 'major');
  assert.equal(describeDrift('2.0.0', '1.9.9').kind, 'downgrade');
});

test('the changelog must open with the package version, newest first, with ticketed entries', () => {
  assert.deepEqual(changelogErrors(log(['1.1.0', 'FAC-2 — second'], ['1.0.0', 'FAC-1 — first']), '1.1.0'), []);
  assert.match(changelogErrors(log(['1.0.0', 'FAC-1 — first']), '1.1.0').join('\n'), /top section is 1\.0\.0, but package\.json is at 1\.1\.0/);
  assert.match(changelogErrors(log(['1.0.0', 'FAC-1 — a'], ['1.1.0', 'FAC-2 — b']), '1.0.0').join('\n'), /1\.1\.0 must be lower than 1\.0\.0/);
  assert.match(changelogErrors(log(['1.0.0', 'FAC-1 — a'], ['1.0.0', 'FAC-2 — b']), '1.0.0').join('\n'), /must be lower than/);
  assert.match(changelogErrors(log(['1.0.0', 'reworded things']), '1.0.0').join('\n'), /entry must read "- <TICKET-n> — <what changed>"/);
  assert.match(changelogErrors('# Changelog\n\n## 1.0.0 - 2026-01-02\n\n### Changed\n', '1.0.0').join('\n'), /1\.0\.0 has no entry/);
  assert.match(changelogErrors('# Changelog\n\n## Unreleased\n\n- FAC-1 — a\n', '1.0.0').join('\n'), /heading must be "## X\.Y\.Z - YYYY-MM-DD"/);
  assert.match(changelogErrors('# Changelog\n\n## 1.0.0 - 2026-01-02\n\n### Tweaked\n- FAC-1 — a\n', '1.0.0').join('\n'), /group "### Tweaked" is not one of/);
  assert.match(changelogErrors('# Changelog\n', '1.0.0').join('\n'), /has no "## X\.Y\.Z - YYYY-MM-DD" section/);
  assert.deepEqual(changelogErrors('# Changelog\n\n## 1.0.0 - 2026-01-02\n\n### Fixed\n- FAC-1 — a long entry\n  that wraps\n', '1.0.0'), []);
});

test('sectionsBetween returns what an update brings: after the installed version, up to the incoming one', () => {
  const text = log(['2.0.0', 'FAC-4 — d'], ['1.1.0', 'FAC-3 — c'], ['1.0.1', 'FAC-2 — b'], ['1.0.0', 'FAC-1 — a']);
  assert.deepEqual(sectionsBetween(text, '1.0.0', '1.1.0').map(s => s.version), ['1.1.0', '1.0.1']);
  assert.deepEqual(sectionsBetween(text, '1.1.0', '1.1.0'), []);
  assert.deepEqual(sectionsBetween(text, null, '1.0.1').map(s => s.version), ['1.0.1', '1.0.0']);
  assert.equal(sectionsBetween(text, '1.0.1', '2.0.0')[0].body, '### Changed\n- FAC-4 — d');
});

test('what ships is what package.json files lists', () => {
  const shipped = shippedMatcher(readJson(path.join(ROOT, 'package.json')).files);
  for (const rel of ['skills/linear/SKILL.md', 'skills/linear/scripts/deep/x.js', 'agents/scout.md', 'project/AGENTS.md', 'manifest.json', 'scripts/lib/pull-install.js', '.claude/commands/brain-status.md', 'runtime/langfuse/pi.js', 'CHANGELOG.md']) {
    assert.ok(shipped(rel), `${rel} ships`);
  }
  // Near misses of the exclusions still ship, as npm packs them.
  for (const rel of ['skills/a/not.terraform/guide.md', 'skills/a/myterraform.tfvars', 'skills/a/b/c/deep.md', 'references/café.md', 'references/a\u2028b.md', 'skills/a\nb/c\r\u2029d.md', 'templates/a?b.md']) {
    assert.ok(shipped(rel), `${rel} ships`);
  }
  for (const rel of ['docs/pull-install.md', 'AGENTS.md', 'evals/cases/linear.json', 'scripts/run-evals.js', '.claude/commands/ship.md', 'skills/development-setup/.terraform/x', 'skills/a/b/.terraform/c/d', 'skills/a/terraform.tfvars', 'skills/a/b/x.tfstate.backup', 'infra/dev-machines/main.tf', 'runtime/langfuse/sub/x.js', 'skillsx/a.md']) {
    assert.ok(!shipped(rel), `${rel} does not ship`);
  }
});

test('the shipped-file matcher agrees with what npm packs', () => {
  const always = new Set(['package.json', 'README.md', 'LICENSE']);
  const shipped = shippedMatcher(readJson(path.join(ROOT, 'package.json')).files);
  const packed = new Set(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }))[0].files.map(file => file.path));
  assert.ok(packed.size > 100);
  for (const rel of packed) assert.ok(always.has(rel) || shipped(rel), `npm packs ${rel}, so it ships`);
  // The other direction needs the list of source files; outside a git checkout there is none to compare.
  let tracked;
  try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { return; }
  for (const rel of tracked) {
    if (!always.has(rel) && fs.existsSync(path.join(ROOT, rel))) assert.equal(shipped(rel), packed.has(rel), `${rel}: matcher and npm disagree`);
  }
});

test('this repository passes its own check', () => {
  assert.deepEqual(validate({ root: ROOT }).errors, []);
});

test('against a base, a shipped change must move the version one step; other changes need none', () => {
  const repo = tmpDir('repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const pkg = (version, extra = {}) => `${JSON.stringify({ name: 'b', version, files: ['skills/**', 'CHANGELOG.md'], scripts: { t: 'x' }, ...extra }, null, 2)}\n`;
  const errors = () => validate({ root: repo, base: 'main' }).errors.join('\n');

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  write('package.json', pkg('1.0.0'));
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first']));
  write('skills/a/SKILL.md', 'a\n');
  write('docs/x.md', 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  assert.equal(errors(), '');

  write('docs/x.md', 'changed\n');
  write('package.json', pkg('1.0.0', { scripts: { t: 'y' } }));
  assert.equal(errors(), '', 'docs and dev scripts are not shipped');

  write('skills/a/SKILL.md', 'changed\n');
  assert.match(errors(), /files a project receives changed, but the version is still 1\.0\.0[\s\S]*skills\/a\/SKILL\.md/);
  git('checkout', '-q', '--', 'skills/a/SKILL.md');
  write('skills/b/SKILL.md', 'untracked\n');
  assert.match(errors(), /skills\/b\/SKILL\.md/, 'an untracked shipped file counts');
  fs.rmSync(path.join(repo, 'skills/b'), { recursive: true });
  write('package.json', pkg('1.0.0', { files: ['skills/**', 'CHANGELOG.md', 'agents/**'] }));
  assert.match(errors(), /version is still 1\.0\.0[\s\S]*package\.json/, 'a change to what ships counts');

  write('skills/a/SKILL.md', 'changed\n');
  write('package.json', pkg('1.0.1'));
  assert.match(errors(), /top section is 1\.0\.0, but package\.json is at 1\.0\.1/);
  write('CHANGELOG.md', log(['1.0.1', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first']));
  assert.equal(errors(), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'bump');
  assert.equal(errors(), '', 'committed or not, the result is the same');

  // Back at the base version: git quotes a path holding a double quote in line output; it must still count.
  write('package.json', pkg('1.0.0'));
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first']));
  git('checkout', '-q', 'main', '--', 'skills/a/SKILL.md');
  assert.equal(errors(), '');
  write('skills/q"uoted/SKILL.md', 'untracked\n');
  assert.match(errors(), /\n  skills\/q"uoted\/SKILL\.md(\n|$)/, 'an untracked path git would quote counts');
  git('add', '-A');
  assert.match(errors(), /\n  skills\/q"uoted\/SKILL\.md(\n|$)/, 'a tracked path git would quote counts');
  git('reset', '-q', '--hard');
  // Moved unchanged, so git would report a rename and name only the new path.
  git('checkout', '-q', 'main', '--', 'skills/a/SKILL.md');
  git('mv', 'skills/a/SKILL.md', 'docs/a.md');
  write('package.json', pkg('1.0.0'));
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first']));
  assert.match(errors(), /version is still 1\.0\.0[\s\S]*skills\/a\/SKILL\.md/, 'a shipped file moved out of what ships counts');
  git('reset', '-q', '--hard');

  // With a step, the released sections stay verbatim below exactly one new section.
  const kept = /the sections released on main must stay as they are, in place, below the new one/;
  write('CHANGELOG.md', log(['1.0.1', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first, reworded']));
  assert.match(errors(), kept, 'a released entry reworded');
  write('CHANGELOG.md', log(['1.0.1', 'FAC-2 — fix']));
  assert.match(errors(), kept, 'a released section deleted');
  write('CHANGELOG.md', log(['1.0.1', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first'], ['0.9.0', 'FAC-0 — invented history']));
  assert.match(errors(), kept, 'an older release invented');
  write('package.json', pkg('1.1.0'));
  write('CHANGELOG.md', log(['1.1.0', 'FAC-2 — fix'], ['1.0.1', 'FAC-9 — a release that never was'], ['1.0.0', 'FAC-1 — first']));
  assert.match(errors(), /a version step adds exactly one section above those on main; found 2/);
  // The released text kept byte for byte, but joined to the new entry's line: its heading would vanish.
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first']).replace('## ', '## 1.1.0 - 2026-01-03\n\n### Fixed\n- FAC-2 — fix. ## '));
  assert.match(errors(), kept, 'a released heading swallowed into the new entry');
  write('CHANGELOG.md', log(['1.1.0', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first']).replace('Intro.', 'A reworded intro.'));
  assert.equal(errors(), '', 'the preamble may change together with a step');

  // Without a step, the changelog is untouched: it ships, and nothing else would announce the change.
  const frozen = /CHANGELOG\.md differs from the one on main, but the version did not step/;
  git('checkout', '-q', 'main', '--', '.');
  assert.equal(errors(), '');
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first']).replace('Intro.', 'A reworded intro.'));
  assert.match(errors(), frozen, 'a preamble edit');
  write('CHANGELOG.md', log(['1.0.0', 'FAC-1 — first'], ['0.9.0', 'FAC-0 — invented history']));
  assert.match(errors(), frozen, 'an older release invented');
  write('CHANGELOG.md', log(['1.0.0', 'FAC-7 — another story']));
  assert.match(errors(), frozen, 'the released entry replaced');
  git('reset', '-q', '--hard');

  write('package.json', pkg('1.2.0'));
  write('CHANGELOG.md', log(['1.2.0', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first']));
  assert.match(errors(), /1\.2\.0 is not one step past 1\.0\.0 on main; expected one of 2\.0\.0, 1\.1\.0, 1\.0\.1/);

  // main moves to the version this branch claimed: the branch must step again.
  git('checkout', '-q', '--', '.');
  git('checkout', '-q', 'main');
  write('package.json', pkg('1.0.1'));
  write('CHANGELOG.md', log(['1.0.1', 'FAC-3 — other'], ['1.0.0', 'FAC-1 — first']));
  write('skills/c/SKILL.md', 'c\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main moves');
  git('checkout', '-q', 'change');
  assert.match(errors(), /files a project receives changed, but the version is still 1\.0\.1/);
  assert.match(errors(), frozen, 'the branch claimed main\'s version with its own entry');
  // Stepping past main without merging it would drop main's section from the record.
  write('package.json', pkg('1.0.2'));
  write('CHANGELOG.md', log(['1.0.2', 'FAC-2 — fix'], ['1.0.0', 'FAC-1 — first']));
  assert.match(errors(), /the sections released on main must stay[\s\S]*If main moved, merge it into this branch/);
  write('CHANGELOG.md', log(['1.0.2', 'FAC-2 — fix'], ['1.0.1', 'FAC-3 — other'], ['1.0.0', 'FAC-1 — first']));
  assert.equal(errors(), '');
  // A branch that never touched the version, behind a main that moved on.
  git('checkout', '-q', '--', '.');
  git('checkout', '-q', '-b', 'docs-only', 'main~1');
  write('docs/x.md', 'docs only\n');
  assert.match(errors(), /version 1\.0\.0 is behind 1\.0\.1 on main; merge main into this branch/);
  assert.match(validate({ root: repo, base: 'missing-ref' }).errors.join('\n'), /cannot read package\.json at missing-ref/);
});

test('a pull records the version, installs the changelog beside the state, and leaves a project CHANGELOG.md alone', () => {
  const target = tmpDir('target');
  fs.writeFileSync(path.join(target, 'CHANGELOG.md'), 'the project\'s own\n');
  const first = pullInstall({ sourceRoot: ROOT, target });
  assert.equal(readJson(path.join(target, STATE_PATH)).brain.version, CURRENT);
  assert.equal(readJson(path.join(target, STATE_PATH)).schema, 1);
  assert.deepEqual(fs.readFileSync(path.join(target, CHANGELOG_PATH)), fs.readFileSync(path.join(ROOT, 'CHANGELOG.md')));
  assert.equal(fs.readFileSync(path.join(target, 'CHANGELOG.md'), 'utf8'), 'the project\'s own\n');
  assert.match(first.message, new RegExp(`^brain: unversioned install → ${CURRENT.replaceAll('.', '\\.')}\nchangelog: \\.agent-brain/CHANGELOG\\.md\n`));
  assert.match(pullInstall({ sourceRoot: ROOT, target }).message, new RegExp(`^brain: ${CURRENT.replaceAll('.', '\\.')} \\(same version\\)\n`));
  assert.throws(() => validateManagedRelPath('CHANGELOG.md', 'install path'), /outside managed brain layout/);
  assert.throws(() => validateManagedRelPath('CHANGELOG.md', 'state path'), /outside managed brain layout/);
  assert.throws(() => validateManagedRelPath('.agent-brain/install-state.json', 'state path'), /reserved state path/);
});

test('an update names both versions and prints the changelog between them; dry-run records nothing', () => {
  const target = tmpDir('target');
  pullInstall({ sourceRoot: ROOT, target });
  const [, minor] = nextVersions(CURRENT);
  const [, , minorPatch] = nextVersions(minor);
  const source = laterSource([[minor, 'FAC-900 — a new rule'], [minorPatch, 'FAC-901 — a fix to it']]);

  const preview = pullInstall({ sourceRoot: source, target, dryRun: true });
  assert.ok(preview.message.startsWith(`brain: ${CURRENT} → ${minorPatch} (minor)\nchanges since ${CURRENT}:\n\n${minorPatch} - 2026-12-01\n  ### Changed\n  - FAC-901 — a fix to it\n\n${minor} - 2026-12-01\n  ### Changed\n  - FAC-900 — a new rule\n`), preview.message);
  assert.doesNotMatch(preview.message, /FAC-52/, 'what was already installed is not repeated');
  assert.equal(readJson(path.join(target, STATE_PATH)).brain.version, CURRENT);

  const applied = pullInstall({ sourceRoot: source, target });
  assert.deepEqual(applied.plan.writes, [CHANGELOG_PATH]);
  assert.equal(readJson(path.join(target, STATE_PATH)).brain.version, minorPatch);

  const back = pullInstall({ sourceRoot: ROOT, target, dryRun: true });
  assert.ok(back.message.startsWith(`brain: ${minorPatch} → ${CURRENT} (downgrade)\nthis downgrade removes:\n\n${minorPatch} - 2026-12-01\n`), back.message);
  assert.match(back.message, /FAC-900 — a new rule/);
  const statusBack = installStatus({ sourceRoot: ROOT, target });
  assert.equal(statusBack.behind, false);
  assert.match(statusBack.message, /a pull would downgrade it\n\nthe downgrade would remove:\n\n.*\n  ### Changed\n  - FAC-901 — a fix to it\n\n.*\n  ### Changed\n  - FAC-900 — a new rule/);

  // An edited or missing installed changelog is not evidence of what was released.
  const installed = path.join(target, CHANGELOG_PATH);
  fs.writeFileSync(installed, fs.readFileSync(installed, 'utf8').replace('FAC-900 — a new rule', 'FAC-999 — locally edited history'));
  for (const message of [pullInstall({ sourceRoot: ROOT, target, dryRun: true }).message, installStatus({ sourceRoot: ROOT, target }).message]) {
    assert.doesNotMatch(message, /FAC-999|FAC-901|this downgrade removes:\n|would remove:/);
    assert.match(message, /cannot list what this downgrade removes: \.agent-brain\/CHANGELOG\.md is missing or was edited since the install/);
  }
  fs.rmSync(installed);
  for (const message of [pullInstall({ sourceRoot: ROOT, target, dryRun: true }).message, installStatus({ sourceRoot: ROOT, target }).message]) {
    assert.match(message, /cannot list what this downgrade removes/);
  }
  assert.equal(pullInstall({ sourceRoot: ROOT, target }).plan.version, CURRENT, 'the downgrade itself still applies');
  assert.equal(readJson(path.join(target, STATE_PATH)).brain.version, CURRENT);
});

test('an install from before versioning updates cleanly, and a malformed recorded version is refused', () => {
  const target = tmpDir('target');
  pullInstall({ sourceRoot: ROOT, target });
  const statePath = path.join(target, STATE_PATH);
  // A real install from before versioning has neither the version nor the changelog.
  const old = readJson(statePath);
  delete old.brain;
  old.files = old.files.filter(file => file.path !== CHANGELOG_PATH);
  fs.rmSync(path.join(target, CHANGELOG_PATH));
  fs.writeFileSync(statePath, `${JSON.stringify(old, null, 2)}\n`);
  assert.match(installStatus({ sourceRoot: ROOT, target }).message, /^installed: unversioned \(installed before the brain had versions\)\navailable: .*\nbehind: by an unknown amount/);
  const upgraded = pullInstall({ sourceRoot: ROOT, target });
  assert.match(upgraded.message, /^brain: unversioned install → /);
  assert.deepEqual(upgraded.plan.writes, [CHANGELOG_PATH]);
  assert.equal(readJson(statePath).brain.version, CURRENT);
  assert.ok(readJson(statePath).files.some(file => file.path === CHANGELOG_PATH));

  fs.writeFileSync(statePath, `${JSON.stringify({ ...old, brain: { version: 'latest' } })}\n`);
  assert.throws(() => pullInstall({ sourceRoot: ROOT, target }), /brain\.version is not semver/);
  assert.throws(() => installStatus({ sourceRoot: ROOT, target }), /brain\.version is not semver/);
});

test('status reports drift and local edits, and changes nothing', () => {
  const target = tmpDir('target');
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'agent-brain.js'), ...args], { encoding: 'utf8' });

  const absent = cli('status', '--target', target);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /^brain: not installed in /);
  assert.equal(cli('status', '--target', target, '--check').status, 1);
  assert.deepEqual(fs.readdirSync(target), []);

  pullInstall({ sourceRoot: ROOT, target });
  const snapshot = () => execFileSync('find', [target, '-type', 'f', '-exec', 'shasum', '{}', '+'], { encoding: 'utf8' });
  const before = snapshot();
  const clean = cli('status', '--target', target, '--check');
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, new RegExp(`^installed: ${CURRENT.replaceAll('.', '\\.')}\navailable: ${CURRENT.replaceAll('.', '\\.')}\nup to date\ntarget: `));

  const [major] = nextVersions(CURRENT);
  const source = laterSource([[major, 'FAC-902 — a rule removed']]);
  const behind = installStatus({ sourceRoot: source, target });
  assert.equal(behind.behind, true);
  assert.ok(behind.message.startsWith(`installed: ${CURRENT}\navailable: ${major}\nbehind: a major update; run agent-brain pull to update\n\nchanges since ${CURRENT}:\n\n${major} - 2026-12-01\n  ### Changed\n  - FAC-902 — a rule removed`), behind.message);
  assert.equal(snapshot(), before, 'status writes nothing');

  fs.appendFileSync(path.join(target, 'SOUL.md'), 'local edit\n');
  fs.rmSync(path.join(target, '.claude/commands/brain.md'));
  const edited = cli('status', '--target', target, '--check');
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /edited since install \(a pull replaces these\):\n  SOUL\.md\n/);
  assert.match(edited.stdout, /missing since install \(a pull restores these\):\n  \.claude\/commands\/brain\.md\n/);
  assert.equal(cli('status', '--target', target).status, 0, 'without --check, status only reports');

  // A project's own part of AGENTS.md and models.json is its to edit: reported apart, and no failure.
  const own = tmpDir('target');
  pullInstall({ sourceRoot: ROOT, target: own });
  fs.appendFileSync(path.join(own, 'AGENTS.md'), '\nA note in this project\'s own section.\n');
  const models = readJson(path.join(own, 'models.json'));
  models.artifacts = [{ path: 'docs/x.md', sources: ['src/**'] }];
  fs.writeFileSync(path.join(own, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  const owned = cli('status', '--target', own, '--check');
  assert.equal(owned.status, 0, owned.stdout + owned.stderr);
  assert.doesNotMatch(owned.stdout, /edited since install/);
  assert.match(owned.stdout, /the project's own part changed since install \(a pull keeps it\):\n  AGENTS\.md: its "## This project" section\n  models\.json: its artifacts\n/);
  assert.equal(pullInstall({ sourceRoot: ROOT, target: own }).plan.writes.length, 0, 'and a pull indeed keeps both');
  assert.equal(cli('status', '--target', own, '--check').status, 0, 'still clean after that pull recorded the merged files');

  // The other side: an edit to the brain's part of either file is one a pull overwrites, and it fails the check.
  const overwritten = (rel, edit, why) => {
    const file = path.join(own, rel);
    const saved = fs.readFileSync(file);
    const mode = fs.statSync(file).mode;
    edit(file, saved.toString('utf8'));
    const res = cli('status', '--target', own, '--check');
    assert.equal(res.status, 1, `${why}: ${res.stdout}`);
    assert.match(res.stdout, new RegExp(`edited since install \\(a pull replaces these\\):\\n(  .*\\n)*  ${rel.replace('.', '\\.')}\\n`), why);
    assert.doesNotMatch(res.stdout, /the project's own part changed/, why);
    const preview = () => pullInstall({ sourceRoot: ROOT, target: own, dryRun: true });
    if (why.includes('refuses')) assert.throws(preview, { code: 'PULL_CONFLICT' }, why);
    else assert.ok(preview().plan.writes.includes(rel) || preview().plan.adopts.includes(rel) || why === 'a changed mode', `${why}: a pull would write ${rel}`);
    fs.writeFileSync(file, saved);
    fs.chmodSync(file, mode);
    assert.equal(cli('status', '--target', own, '--check').status, 0, `${why}: restored`);
  };
  overwritten('AGENTS.md', (file, text) => fs.writeFileSync(file, `A line above everything.\n${text}`), 'an edit outside the project section');
  overwritten('AGENTS.md', (file, text) => fs.writeFileSync(file, `${text.replace('# ', '#  ')}\nAnd a note in the project's own section.\n`), 'an edit to the shared text beside a project edit');
  overwritten('AGENTS.md', (file, text) => fs.writeFileSync(file, `${text}\n## This project\n`), 'a second project heading, which a pull refuses');
  overwritten('AGENTS.md', file => fs.chmodSync(file, 0o755), 'a changed mode');
  overwritten('models.json', (file, text) => { const m = JSON.parse(text); m['code-reviewer'].model = 'something-else'; fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`); }, 'a brain-owned model changed');
  overwritten('models.json', (file, text) => { const m = JSON.parse(text); m.artifacts = { not: 'a list' }; fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`); }, 'artifacts that are not a list, which a pull replaces');
  overwritten('models.json', (file, text) => { const m = JSON.parse(text); delete m.artifacts; fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`); }, 'artifacts deleted, which a pull restores');
  overwritten('models.json', file => fs.writeFileSync(file, '{ not json'), 'malformed JSON, which a pull refuses');

  // An install whose state has no record of the brain's part cannot tell the two apart, so it does not pass.
  const statePath = path.join(own, STATE_PATH);
  const noOwned = readJson(statePath);
  for (const file of noOwned.files) delete file.owned;
  fs.writeFileSync(statePath, `${JSON.stringify(noOwned, null, 2)}\n`);
  assert.equal(cli('status', '--target', own, '--check').status, 0, 'nothing changed yet');
  fs.appendFileSync(path.join(own, 'AGENTS.md'), '\nOne more note in the project section.\n');
  const unknown = cli('status', '--target', own, '--check');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /edited since install \(a pull replaces these\):\n  AGENTS\.md\n/);
  fs.writeFileSync(statePath, `${JSON.stringify({ ...noOwned, files: noOwned.files.map(file => file.path === 'AGENTS.md' ? { ...file, owned: 'nope' } : file) })}\n`);
  assert.equal(cli('status', '--target', own).status, 2, 'a malformed owned hash is refused');

  assert.equal(cli('status', '--bogus').status, 2);
});
