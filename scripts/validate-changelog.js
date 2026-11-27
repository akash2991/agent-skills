#!/usr/bin/env node
'use strict';

// The brain's version and changelog stay honest:
//   - package.json `version` is semver, and CHANGELOG.md's top section is that version;
//   - with --base <ref>, a change to anything a project receives moves the version
//     exactly one major, minor, or patch step past the base's.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseVersion, nextVersions, readBrainVersion, changelogErrors } = require('./lib/brain-version');

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// package.json `files` is what npx hands a project, so it is the list of what ships.
function shippedMatcher(files) {
  const include = files.filter(f => !f.startsWith('!')).map(globToRegExp);
  const exclude = files.filter(f => f.startsWith('!')).map(f => globToRegExp(f.slice(1)));
  return rel => include.some(re => re.test(rel)) && !exclude.some(re => re.test(rel));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// What a project receives from package.json itself: everything but the version and the dev scripts.
function shippedPackageFields(text) {
  const pkg = JSON.parse(text);
  delete pkg.version;
  delete pkg.scripts;
  return JSON.stringify(pkg);
}

function shippedChanges(root, base) {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const changed = new Set([
    ...git(root, ['diff', '--name-only', mergeBase]).split('\n'),
    ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')
  ].filter(Boolean));
  const headPackage = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const isShipped = shippedMatcher(JSON.parse(headPackage).files || []);
  const shipped = [...changed].filter(rel => rel !== 'CHANGELOG.md' && rel !== 'package.json' && isShipped(rel));
  if (changed.has('package.json')) {
    let basePackage = null;
    try { basePackage = git(root, ['show', `${mergeBase}:package.json`]); } catch { /* new file */ }
    if (basePackage === null || shippedPackageFields(basePackage) !== shippedPackageFields(headPackage)) shipped.push('package.json');
  }
  return shipped.sort();
}

function validate({ root, base }) {
  const errors = [];
  let version;
  try { version = readBrainVersion(root); } catch (err) { return { errors: [err.message] }; }
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return { version, errors: ['CHANGELOG.md is missing'] };
  errors.push(...changelogErrors(fs.readFileSync(changelogPath, 'utf8'), version));

  if (base) {
    let baseVersion;
    try { baseVersion = JSON.parse(git(root, ['show', `${base}:package.json`])).version; }
    catch (err) { return { version, errors: [...errors, `cannot read package.json at ${base}: ${err.message.trim()}`] }; }
    const shipped = shippedChanges(root, base);
    if (!parseVersion(baseVersion)) {
      errors.push(`package.json at ${base} has version ${JSON.stringify(baseVersion)}, not semver X.Y.Z`);
    } else if (version === baseVersion) {
      if (shipped.length) {
        errors.push(`files a project receives changed, but the version is still ${baseVersion} (as on ${base}). Bump package.json to one of ${nextVersions(baseVersion).join(', ')} and add its CHANGELOG.md section. Changed:\n${shipped.map(f => `  ${f}`).join('\n')}`);
      }
    } else if (!nextVersions(baseVersion).includes(version)) {
      errors.push(`version ${version} is not one step past ${baseVersion} on ${base}; expected one of ${nextVersions(baseVersion).join(', ')}`);
    }
    return { version, baseVersion, shipped, errors };
  }
  return { version, errors };
}

function main(argv) {
  let base = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1] && !argv[i + 1].startsWith('-')) base = argv[++i];
    else {
      console.error('Usage: node scripts/validate-changelog.js [--base <git-ref>]');
      return 2;
    }
  }
  const result = validate({ root: path.resolve(__dirname, '..'), base });
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    return 1;
  }
  console.log(base
    ? `brain ${result.version}: changelog matches; ${result.version === result.baseVersion ? `nothing a project receives changed since ${base}` : `one step past ${result.baseVersion} on ${base}`}.`
    : `brain ${result.version}: changelog matches.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { validate, shippedMatcher, globToRegExp };
