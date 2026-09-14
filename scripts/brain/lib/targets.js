'use strict';
// Per-tool layout. One source of truth (skills/, agents/, templates/) is transformed into these shapes.
// Fields:
//   alwaysOn         — file the tool loads on every session; written as a managed block. Every
//                      target uses AGENTS.md, so a repository has one organization document.
//   pointers         — harness-specific always-on files that only point at AGENTS.md, so a tool
//                      that reads its own file still finds the organization without a second copy
//   skillsDir        — where SKILL.md directories go (flat: <skillsDir>/<name>/SKILL.md)
//   mcp              — repo-level MCP config: file path, top-level key, per-server shape, env-var reference syntax; null when the tool only has a global config
//   commands         — where user-facing commands live and how a command file is written, or null.
//                      `scope: 'global'` means the harness only discovers commands under a home
//                      directory, never inside a repository: the build still emits the repo copy as
//                      the version-controlled source, and injection installs it to `home` (honouring
//                      `homeEnv`) so the command actually resolves. `why` explains the constraint.
//   hooks            — repo-level config that wires automatic usage capture, or null when the
//                      harness has no hook mechanism (then usage stays UNKNOWN until it does)

// Personas ship only as skills. Firstmate runs each role as its own session with the harness, model,
// and effort chosen for that task, so no target carries subagent files, spawn modes, or routing notes.
// Canonical server shape from a skill's mcp.json: { type: 'http', url, headers? }.
// Each tool references environment variables differently inside JSON config.
const TARGETS = {
  'claude-code': {
    label: 'Claude Code',
    commands: { dir: '.claude/commands', file: n => `${n}.md`, write: (name, description, body, hint) => `---\ndescription: ${description}\nargument-hint: ${hint}\n---\n\n${body}` },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: 'CLAUDE.md', kind: 'md' }],
    skillsDir: '.claude/skills',
    hooks: {
      file: '.claude/settings.json', key: 'hooks',
      build: orgDir => ({
        SessionStart: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${orgDir}/control-plane/hook.js" session-start` }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${orgDir}/control-plane/hook.js" tool` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${orgDir}/control-plane/hook.js" turn` }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${orgDir}/control-plane/hook.js" turn` }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${orgDir}/control-plane/hook.js" session-end` }] }]
      })
    },
    mcp: { file: '.mcp.json', key: 'mcpServers', envRef: v => `\${${v}}`, server: s => ({ type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
  },
  codex: {
    label: 'Codex',
    commands: {
      dir: '.codex/prompts', file: n => `${n}.md`,
      write: (name, description, body, hint) => `---\ndescription: ${description}\nargument-hint: ${hint}\n---\n\n${body}`,
      // Codex resolves custom prompts only under $CODEX_HOME/prompts (default ~/.codex/prompts).
      // Repo-local .codex/prompts is a requested feature, not a shipped one (openai/codex#4734,
      // openai/codex#9848), so a prompt left in the project is never discovered. The body uses
      // repository-relative paths, so one installed copy works in every injected repository.
      scope: 'global', homeEnv: 'CODEX_HOME', home: '~/.codex', installDir: 'prompts',
      why: 'Codex discovers custom prompts only under $CODEX_HOME/prompts; repo-local .codex/prompts is not read (openai/codex#4734, #9848).',
    },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    skillsDir: '.agents/skills',
    mcp: null, // global ~/.codex/config.toml only; see references/tool-auth.md
  },
  cursor: {
    label: 'Cursor',
    commands: { dir: '.cursor/commands', file: n => `${n}.md`, write: (name, description, body) => `# ${description}\n\n${body}` },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: '.cursor/rules/agent-brain.mdc', kind: 'mdc' }],
    skillsDir: '.cursor/skills',
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers', envRef: v => `\${env:${v}}`, server: s => ({ url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
  },
  gemini: {
    label: 'Gemini CLI',
    commands: { dir: '.gemini/commands', file: n => `${n}.toml`, write: (name, description, body) => `description = ${JSON.stringify(description)}\n\nprompt = """\n${body}\n"""\n` },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: 'GEMINI.md', kind: 'md' }],
    skillsDir: '.gemini/skills',
    mcp: { file: '.gemini/settings.json', key: 'mcpServers', envRef: v => `$${v}`, server: s => ({ httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
  },
  opencode: {
    label: 'OpenCode',
    commands: { dir: '.opencode/command', file: n => `${n}.md`, write: (name, description, body) => `---\ndescription: ${description}\n---\n\n${body}` },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    skillsDir: '.opencode/skills',
    mcp: { file: 'opencode.json', key: 'mcp', extra: { $schema: 'https://opencode.ai/config.json' }, envRef: v => `{env:${v}}`, server: s => ({ type: 'remote', url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) }) },
  },
  copilot: {
    label: 'GitHub Copilot',
    commands: { dir: '.github/prompts', file: n => `${n}.prompt.md`, write: (name, description, body) => `---\ndescription: ${description}\n---\n\n${body}` },
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: '.github/copilot-instructions.md', kind: 'md' }],
    skillsDir: '.github/skills',
    mcp: { file: '.vscode/mcp.json', key: 'servers', envRef: v => `\${env:${v}}`, server: s => ({ type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
  },
};

// Codex and OpenCode share AGENTS.md; give them one label so the managed block does not flip-flop.
TARGETS.codex.toolLabel = 'Codex / OpenCode';
TARGETS.opencode.toolLabel = 'Codex / OpenCode';

module.exports = { TARGETS };
