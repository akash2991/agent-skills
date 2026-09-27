'use strict';

const fs = require('fs');
const path = require('path');
const { lstatIfPresent, isWithin, canonicalPath, validateManagedRelPath } = require('./install-paths');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

function assertSafeOutput(root, outDir) {
  const source = canonicalPath(root);
  const st = lstatIfPresent(path.resolve(outDir));
  if (st && !st.isDirectory()) throw new Error(`output must be a directory, not a symlink or file: ${outDir}`);
  const out = canonicalPath(outDir);
  const defaultOut = path.join(source, 'build');
  if (isWithin(out, source) || (isWithin(source, out) && out !== defaultOut)) {
    throw new Error(`refusing output overlapping source files (only the default build/ is allowed): ${out}`);
  }
  // Only the designated build/ is disposable. Never recursively erase an
  // arbitrary nonempty external directory passed by mistake via --out.
  if (st && out !== defaultOut && fs.readdirSync(out).length) {
    throw new Error(`external output must be empty: ${out}`);
  }
}

function assertName(kind, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid ${kind} name in manifest: ${JSON.stringify(name)}`);
  }
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: p => !/(^|[\\/])(\.DS_Store|mcp\.json)$/.test(p)
  });
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function walkRegularFiles(root) {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push(abs);
      else throw new Error(`source contains nonregular file: ${abs}`);
    }
  }
  walk(root);
  return files;
}

function validateSourceTree(root, relRoot) {
  const absRoot = path.join(root, relRoot);
  for (const abs of walkRegularFiles(absRoot)) {
    validateManagedRelPath(toPosix(path.relative(root, abs)), 'source path');
  }
}

function brainCommandFiles(root, dir) {
  const ext = dir.endsWith('commands') && !dir.startsWith('.claude') ? 'toml' : 'md';
  return fs.readdirSync(path.join(root, dir)).filter(f => new RegExp(`^brain(-status)?\\.${ext}$`).test(f));
}

function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match || !/^name:\s*\S/m.test(match[0]) || !/^description:\s*\S/m.test(match[0])) {
    throw new Error('source skill/persona requires name and description frontmatter');
  }
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

function writeSkillWrapper(root, out, skill) {
  const canonical = path.join(root, 'skills', skill, 'SKILL.md');
  const { frontmatter } = splitFrontmatter(fs.readFileSync(canonical, 'utf8'));
  const body = [
    '',
    `This is a discovery wrapper for the canonical brain skill at \`../../../skills/${skill}/SKILL.md\`.`,
    '',
    `Read and use \`../../../skills/${skill}/SKILL.md\` as the source of truth. Resolve any relative references from the canonical skill directory \`skills/${skill}/\`, not from this wrapper directory.`,
    ''
  ].join('\n');
  for (const base of ['.agents/skills', '.claude/skills']) {
    const target = path.join(out, base, skill, 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${frontmatter}${body}`);
  }
}

function writePersonaWrapper(root, out, persona) {
  const canonical = path.join(root, 'agents', `${persona}.md`);
  const { frontmatter } = splitFrontmatter(fs.readFileSync(canonical, 'utf8'));
  const body = [
    '',
    `This is a discovery wrapper for the canonical brain persona at \`../../agents/${persona}.md\`.`,
    '',
    `Read and use \`../../agents/${persona}.md\` as the source of truth.`,
    ''
  ].join('\n');
  const target = path.join(out, '.claude/agents', `${persona}.md`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${frontmatter}${body}`);
}

function buildBrain(options = {}) {
  const root = canonicalPath(options.root || DEFAULT_ROOT);
  const requestedOut = path.resolve(options.out || path.join(root, 'build'));
  assertSafeOutput(root, requestedOut);
  const out = canonicalPath(requestedOut);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const skills = manifest.skills || [];
  const personas = manifest.personas || [];
  if (!Array.isArray(skills) || !Array.isArray(personas)) throw new Error('manifest skills and personas must be arrays');
  skills.forEach(s => assertName('skill', s));
  personas.forEach(p => assertName('persona', p));
  if (new Set(skills).size !== skills.length || new Set(personas).size !== personas.length) throw new Error('duplicate manifest entry');
  // Validate every selected entry and copied path before replacing a previously generated build.
  for (const s of skills) {
    validateSourceTree(root, path.join('skills', s));
    splitFrontmatter(fs.readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8'));
  }
  for (const p of personas) {
    const rel = `agents/${p}.md`;
    validateManagedRelPath(rel, 'source path');
    splitFrontmatter(fs.readFileSync(path.join(root, rel), 'utf8'));
  }
  validateSourceTree(root, 'references');
  validateSourceTree(root, 'templates');
  for (const rel of ['AGENTS.md', 'SOUL.md', '.env.example', 'docs/persona-anatomy.md', 'docs/skill-anatomy.md']) validateManagedRelPath(rel, 'source path');
  for (const dir of ['.claude/commands', '.gemini/commands', 'commands', '.pi/prompts', '.codex/prompts']) {
    for (const f of brainCommandFiles(root, dir)) validateManagedRelPath(`${dir}/${f}`, 'source path');
  }

  fs.rmSync(out, { recursive: true, force: true });

  let missing = 0;
  for (const s of skills) {
    const from = path.join(root, 'skills', s);
    if (!fs.existsSync(from)) { console.error(`  missing skill: ${s}`); missing++; continue; }
    copy(from, path.join(out, 'skills', s));
    writeSkillWrapper(root, out, s);
  }
  for (const p of personas) {
    const from = path.join(root, 'agents', `${p}.md`);
    if (!fs.existsSync(from)) { console.error(`  missing persona: ${p}`); missing++; continue; }
    copy(from, path.join(out, 'agents', `${p}.md`));
    writePersonaWrapper(root, out, p);
  }
  if (missing) {
    const err = new Error(`manifest references ${missing} missing item(s)`);
    err.code = 'MISSING_MANIFEST_INPUT';
    throw err;
  }

  for (const f of ['references', 'templates']) copy(path.join(root, f), path.join(out, f));
  copy(path.join(root, 'project', 'SOUL.md'), path.join(out, 'SOUL.md'));
  copy(path.join(root, 'project', '.env.example'), path.join(out, '.env.example'));
  const skillList = skills.map(s => `- \`skills/${s}/SKILL.md\``).join('\n');
  const org = fs.readFileSync(path.join(root, 'project', 'AGENTS.md'), 'utf8')
    .replace(/^<!-- brain:skills.*$/m, skillList);
  fs.writeFileSync(path.join(out, 'AGENTS.md'), org);

  for (const dir of ['.claude/commands', '.gemini/commands', 'commands', '.pi/prompts', '.codex/prompts']) {
    for (const f of brainCommandFiles(root, dir)) {
      copy(path.join(root, dir, f), path.join(out, dir, f));
    }
  }
  copy(path.join(root, 'docs', 'persona-anatomy.md'), path.join(out, 'docs', 'persona-anatomy.md'));
  copy(path.join(root, 'docs', 'skill-anatomy.md'), path.join(out, 'docs', 'skill-anatomy.md'));

  fs.writeFileSync(path.join(out, 'README.md'), `# Brain\n\nBuilt from manifest.json: ${skills.length} skills, ${personas.length} personas.\n\nInstall into a project with:\n\n\`\`\`sh\nnpx --yes --package=github:akash2991/agent-skills#main agent-brain pull\n\`\`\`\n\nThis README describes the generated bundle and is not installed into consumer repositories.\n`);

  return { out, skills: skills.length, personas: personas.length };
}

module.exports = { buildBrain, assertSafeOutput, splitFrontmatter };
