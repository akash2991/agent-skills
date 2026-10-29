#!/usr/bin/env node
'use strict';

// Builds docs/flow-map.html from docs/flow-map.json: one self-contained page that shows how many flows are
// deterministic, agent-taken, or mixed, today and after conversion. The classes are computed here, not in the page.
//   node scripts/build-flow-map.js           write docs/flow-map.html
//   node scripts/build-flow-map.js --check   exit 1 when the committed page is out of date or the data is invalid

const fs = require('fs');
const path = require('path');
const { build } = require('./lib/flow-map');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'docs', 'flow-map.json');
const TEMPLATE = path.join(ROOT, 'docs', 'flow-map.template.html');
const OUT = path.join(ROOT, 'docs', 'flow-map.html');

function render(root = ROOT) {
  const model = build(JSON.parse(fs.readFileSync(DATA, 'utf8')), root);
  // "<" is escaped so no step text can close the script element.
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  return fs.readFileSync(TEMPLATE, 'utf8').replace('__FLOW_DATA__', () => json);
}

if (require.main === module) {
  try {
    const html = render();
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== html) {
        console.error('docs/flow-map.html is out of date: run node scripts/build-flow-map.js');
        process.exit(1);
      }
      console.log('docs/flow-map.html is up to date');
    } else {
      fs.writeFileSync(OUT, html);
      console.log(`wrote ${path.relative(ROOT, OUT)}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { render };
