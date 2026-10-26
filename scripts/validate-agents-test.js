'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { personaTableNames } = require('./validate-agents');

const table = [
  '## Your personas',
  '',
  '| Persona | Does | Never |',
  '|---|---|---|',
  '| `product-manager` | idea → ticket | designs |',
  '| `backend-engineer` · `web-engineer` | code | reviews |',
  '| `scout` | reads | edits |',
  '',
  '## Your skills',
  '| `not-a-persona` | x | y |',
].join('\n');

test('persona names come from the first column of the personas table only', () => {
  assert.deepStrictEqual(personaTableNames(table), ['product-manager', 'backend-engineer', 'web-engineer', 'scout']);
});

test('a file without the section yields null', () => {
  assert.strictEqual(personaTableNames('# nothing'), null);
});

test('the real project/AGENTS.md matches the manifest', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const names = personaTableNames(fs.readFileSync(path.join(root, 'project', 'AGENTS.md'), 'utf8'));
  assert.deepStrictEqual([...names].sort(), [...manifest.personas].sort());
});
