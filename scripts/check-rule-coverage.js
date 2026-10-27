#!/usr/bin/env node
'use strict';

// Fails when a rule ID from the convention skills (P, M, DS, L) is not cited by any flow step in docs/flow-map.json.
// A rule that no flow step names is a rule nobody is shown doing. Exit 0 when every ID is covered, 1 with the list.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS = ['git-workflow-and-versioning', 'linear', 'development-setup', 'continuous-delivery'];
const ID_ROW = /^\| ((?:P|M|DS|L)\d+) /gm;

function ruleIds(skillsDir = path.join(ROOT, 'skills')) {
  const ids = new Set();
  for (const s of SKILLS) {
    const text = fs.readFileSync(path.join(skillsDir, s, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(ID_ROW)) ids.add(m[1]);
  }
  return [...ids].sort();
}

// A flow step cites rule IDs in its third field, for example "P6 DS2 DS3". Matched as whole words.
function uncovered(ids, flowMap) {
  const cited = new Set();
  for (const flow of flowMap.flows) {
    for (const step of flow.steps) {
      for (const id of String(step[3] || '').split(/\s+/)) if (id) cited.add(id);
    }
  }
  return ids.filter(id => !cited.has(id));
}

if (require.main === module) {
  const flowMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'flow-map.json'), 'utf8'));
  const missing = uncovered(ruleIds(), flowMap);
  if (missing.length) {
    console.error(`rule IDs no flow step cites: ${missing.join(' ')}`);
    process.exit(1);
  }
  console.log('every convention rule ID is cited by a flow step');
}

module.exports = { ruleIds, uncovered };
