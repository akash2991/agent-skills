'use strict';
// Minimal YAML frontmatter reader/writer: flat `key: value` pairs, optional quotes,
// and indented continuation lines. Enough for SKILL.md files; not a YAML parser.

function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  let last = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+\S/.test(line) && last) { data[last] += ' ' + line.trim(); continue; }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v === '>' || v === '|') v = '';
    data[kv[1]] = v;
    last = kv[1];
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

function quote(v) {
  const s = String(v);
  return /[:#"'\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function stringify(data, body) {
  const lines = Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${quote(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : '\n' + body}`;
}

module.exports = { parse, stringify };
