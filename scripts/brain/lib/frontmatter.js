'use strict';
// Minimal YAML frontmatter reader/writer: flat `key: value` pairs, optional quotes, block scalars,
// indented continuation lines, and single-level sequences. Enough for SKILL.md files; not a YAML
// parser. Sequences and block scalars are here because skills imported from elsewhere use both, and
// a round-trip that flattens them corrupts the file it was asked to copy.

const BLOCK_SCALAR = /^[|>][-+]?\d*$/; // >, >-, |, |+, |2 …

function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  let last = null;
  for (const line of m[1].split(/\r?\n/)) {
    // A sequence item continues the key above it, whether indented or flush-left.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && last) {
      if (!Array.isArray(data[last])) data[last] = data[last] ? [data[last]] : [];
      data[last].push(unquote(item[1].trim()));
      continue;
    }
    if (/^\s+\S/.test(line) && last) {
      if (Array.isArray(data[last])) continue; // an indented line after a sequence is not a value
      data[last] = data[last] ? `${data[last]} ${line.trim()}` : line.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    // A block scalar header carries no value; the indented lines that follow are the value.
    data[kv[1]] = BLOCK_SCALAR.test(v) ? '' : unquote(v);
    last = kv[1];
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

function unquote(v) {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v;
}

function quote(v) {
  const s = String(v);
  return /[:#"'\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function stringify(data, body) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${quote(item)}`);
      continue;
    }
    lines.push(`${k}: ${quote(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : '\n' + body}`;
}

// Our own parser is forgiving, but the harnesses that consume these files are not: pi and others
// run a real YAML parser and reject the whole skill. The rule that bites is a plain scalar holding
// `: `, which YAML reads as a nested mapping, so a description with a colon in it fails to load.
// This reports what a strict parser would refuse, so the build catches it before a user does.
function strictProblems(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return [];
  const problems = [];
  for (const [i, line] of m[1].split(/\r?\n/).entries()) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]+(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (!value || /^["'|>[]/.test(value)) continue;
    if (value.includes(': ')) {
      problems.push(`line ${i + 2}: \`${kv[1]}\` contains ": " but is not quoted, which a strict YAML parser reads as a nested mapping. Wrap the value in double quotes.`);
    }
    if (value.includes(' #')) {
      problems.push(`line ${i + 2}: \`${kv[1]}\` contains " #", which a strict YAML parser reads as a comment. Wrap the value in double quotes.`);
    }
  }
  return problems;
}

module.exports = { parse, stringify, strictProblems };
