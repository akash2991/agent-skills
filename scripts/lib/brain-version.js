'use strict';

// The brain's own version: package.json `version` (semver X.Y.Z) and the root
// CHANGELOG.md. Not the upstream plugin version in plugin.json.

const fs = require('fs');
const path = require('path');

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEADING_RE = /^## (\S+) - (\d{4}-\d{2}-\d{2})[ \t]*$/;
const ENTRY_RE = /^- [A-Z][A-Z0-9]*-\d+ — \S/;
const GROUPS = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

function parseVersion(text) {
  const match = typeof text === 'string' && text.match(SEMVER_RE);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a semver version: ${JSON.stringify(x ? b : a)}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The three versions a single change may move to.
function nextVersions(version) {
  const [major, minor, patch] = parseVersion(version);
  return [`${major + 1}.0.0`, `${major}.${minor + 1}.0`, `${major}.${minor}.${patch + 1}`];
}

function readBrainVersion(root) {
  const file = path.join(root, 'package.json');
  let version;
  try { version = JSON.parse(fs.readFileSync(file, 'utf8')).version; }
  catch (err) { throw new Error(`cannot read the brain version from ${file}: ${err.message}`); }
  if (!parseVersion(version)) throw new Error(`${file}: version ${JSON.stringify(version)} is not semver X.Y.Z`);
  return version;
}

// Sections in file order (newest first): { version, date, body, line }.
function parseChangelog(text) {
  const sections = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  lines.forEach((line, index) => {
    if (/^## /.test(line)) {
      const match = line.match(HEADING_RE);
      current = { version: match ? match[1] : null, date: match ? match[2] : null, heading: line, line: index + 1, lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
  });
  for (const section of sections) {
    section.body = section.lines.join('\n').trim();
    delete section.lines;
  }
  return sections;
}

// Everything the changelog must satisfy on its own; returns error strings.
function changelogErrors(text, version) {
  const errors = [];
  const sections = parseChangelog(text);
  if (!sections.length) return ['CHANGELOG.md has no "## X.Y.Z - YYYY-MM-DD" section'];
  sections.forEach((section, i) => {
    const where = `CHANGELOG.md:${section.line}`;
    if (!section.version || !parseVersion(section.version)) {
      errors.push(`${where}: heading must be "## X.Y.Z - YYYY-MM-DD", got ${JSON.stringify(section.heading)}`);
      return;
    }
    const previous = sections[i - 1];
    if (previous && previous.version && parseVersion(previous.version) && compareVersions(previous.version, section.version) <= 0) {
      errors.push(`${where}: ${section.version} must be lower than ${previous.version} above it (newest first, no duplicates)`);
    }
    const body = section.body.split('\n').filter(line => line.trim());
    const entries = body.filter(line => line.startsWith('- '));
    if (!entries.length) errors.push(`${where}: ${section.version} has no entry`);
    for (const line of body) {
      if (line.startsWith('### ')) {
        if (!GROUPS.has(line.slice(4).trim())) errors.push(`${where}: ${section.version} group ${JSON.stringify(line)} is not one of ${[...GROUPS].join(', ')}`);
      } else if (line.startsWith('- ')) {
        if (!ENTRY_RE.test(line)) errors.push(`${where}: ${section.version} entry must read "- <TICKET-n> — <what changed>", got ${JSON.stringify(line)}`);
      } else if (!/^\s+\S/.test(line)) {
        errors.push(`${where}: ${section.version} has a line that is neither a group, an entry, nor an entry's continuation: ${JSON.stringify(line)}`);
      }
    }
  });
  if (sections[0].version !== version) {
    errors.push(`CHANGELOG.md: the top section is ${sections[0].version || JSON.stringify(sections[0].heading)}, but package.json is at ${version}`);
  }
  return errors;
}

// Sections newer than `from` (exclusive) up to `to` (inclusive), newest first.
// A missing or non-semver `from` means everything up to `to`.
function sectionsBetween(text, from, to) {
  const lower = parseVersion(from) ? from : null;
  return parseChangelog(text).filter(section => parseVersion(section.version)
    && compareVersions(section.version, to) <= 0
    && (!lower || compareVersions(section.version, lower) > 0));
}

function formatSections(sections) {
  return sections.map(section => `${section.version} - ${section.date}\n${section.body.split('\n').filter(line => line.trim()).map(line => `  ${line}`).join('\n')}`).join('\n\n');
}

// One line that says how the installed version relates to the incoming one.
function describeDrift(installed, incoming) {
  if (!installed) return { kind: 'unversioned', line: `brain: unversioned install → ${incoming}` };
  const order = compareVersions(installed, incoming);
  if (order === 0) return { kind: 'same', line: `brain: ${incoming} (same version)` };
  if (order > 0) return { kind: 'downgrade', line: `brain: ${installed} → ${incoming} (downgrade)` };
  const [a, b] = [parseVersion(installed), parseVersion(incoming)];
  const level = a[0] !== b[0] ? 'major' : a[1] !== b[1] ? 'minor' : 'patch';
  return { kind: level, line: `brain: ${installed} → ${incoming} (${level})` };
}

module.exports = {
  parseVersion,
  compareVersions,
  nextVersions,
  readBrainVersion,
  parseChangelog,
  changelogErrors,
  sectionsBetween,
  formatSections,
  describeDrift
};
