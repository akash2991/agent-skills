'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DUMP_DIR = path.join(ROOT, 'skills');            // flat skill dump (source of truth)
const AGENTS_DIR = path.join(ROOT, 'agents');          // personas (source of truth)
const ORG_DIR_SRC = path.join(ROOT, 'org');            // ordered parts emitted as one always-on ORG.md
const REPORTS_DIR = path.join(ROOT, 'agents-reports');  // one uniform report template per role, beside agents/
const CONTROL_PLANE_DIR = path.join(ROOT, 'control-plane'); // SQLite store, CLI, UI, adapters
const TEMPLATES_DIR = path.join(ROOT, 'templates');    // stamped into a target project: global-docs, service-docs, commands
const REFERENCES_DIR = path.join(ROOT, 'references');  // shared checklists + PM interface
const DOCS_DIR = path.join(ROOT, 'docs');
const BUILD_DIR = path.join(ROOT, 'build');
const SELECTED_DIR = path.join(BUILD_DIR, 'skills');   // select output: build/skills/<category>/<name>/
const DIST_DIR = path.join(ROOT, 'dist');              // build output: dist/<target>/
const MANIFEST = path.join(ROOT, 'manifest.json');
const DEFAULT_CATEGORY = 'general';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function exists(p) { return fs.existsSync(p); }
function isDir(p) { return exists(p) && fs.statSync(p).isDirectory(); }
function listDirs(p) { return isDir(p) ? fs.readdirSync(p).filter(d => !d.startsWith('.') && isDir(path.join(p, d))).sort() : []; }

function walk(dir, base = dir) {
  if (!isDir(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.DS_Store' || e.name === '.gitkeep') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Copy a tree; transform(rel, buffer) may return buffer|string|null(skip). Returns written relative paths.
function copyTree(src, dest, transform) {
  const written = [];
  for (const rel of walk(src)) {
    let content = fs.readFileSync(path.join(src, rel));
    if (transform) { const t = transform(rel, content); if (t === null) continue; content = t; }
    const to = path.join(dest, rel);
    ensureDir(path.dirname(to));
    fs.writeFileSync(to, content);
    written.push(rel);
  }
  return written;
}

function render(text, vars) { return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)); }
function splitList(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }

function loadManifest() {
  const m = readJson(MANIFEST);
  m.skills = m.skills || [];
  m.personas = m.personas || [];
  m.targets = m.targets || [];
  m.orgDir = m.orgDir || '.agent-brain';
  return m;
}

module.exports = { ROOT, DUMP_DIR, AGENTS_DIR, ORG_DIR_SRC, REPORTS_DIR, CONTROL_PLANE_DIR, TEMPLATES_DIR, REFERENCES_DIR, DOCS_DIR, BUILD_DIR, SELECTED_DIR, DIST_DIR, MANIFEST, DEFAULT_CATEGORY,
  readJson, writeJson, ensureDir, rmrf, exists, isDir, listDirs, walk, copyTree, render, splitList, loadManifest };
