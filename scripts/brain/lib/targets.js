'use strict';
// Per-tool layout. One source of truth (skills/, agents/, templates/) is transformed into these shapes.
// Fields:
//   alwaysOn         — file the tool loads on every session; written as a managed block. Every
//                      target uses AGENTS.md, so a repository has one organization document.
//   pointers         — harness-specific always-on files that only point at AGENTS.md, so a tool
//                      that reads its own file still finds the organization without a second copy
//   skillsDir        — where SKILL.md directories go (flat: <skillsDir>/<name>/SKILL.md)
//   agentsDir        — where persona subagent files go, or null when the tool has no subagents
//   agentFile        — file name for a persona subagent
//   agentFrontmatter — frontmatter for a persona subagent from the resolved persona data
//   mcp              — repo-level MCP config: file path, top-level key, per-server shape, env-var reference syntax; null when the tool only has a global config
//   commands         — where user-facing commands live and how a command file is written, or null.
//                      `scope: 'global'` means the harness only discovers commands under a home
//                      directory, never inside a repository: the build still emits the repo copy as
//                      the version-controlled source, and injection installs it to `home` (honouring
//                      `homeEnv`) so the command actually resolves. `why` explains the constraint.
//   hooks            — repo-level config that wires automatic usage capture, or null when the
//                      harness has no hook mechanism (then usage stays UNKNOWN until it does)
//   spawn            — 'main-only' (only the main session can spawn personas), 'nested' (any persona can spawn), 'single-session' (no subagents)
//   routingNote      — how the model and effort the coordinator chose are applied on this harness
//   delegationNote   — appended to the always-on file

// Subagent files carry no model: the spawner passes the model and effort the EM chose for the task,
// and the control plane records what actually ran.
// Canonical server shape from a skill's mcp.json: { type: 'http', url, headers? }.
// Each tool references environment variables differently inside JSON config.
const TARGETS = {
  'claude-code': {
    label: 'Claude Code',
    commands: { dir: '.claude/commands', file: n => `${n}.md`, write: (name, description, body, hint) => `---\ndescription: ${description}\nargument-hint: ${hint}\n---\n\n${body}` },
    spawn: 'main-only',
    routingNote: 'Routing execution on Claude Code: subagents cannot spawn subagents, so the CEO session is the only spawner. The EM decides the routing (tier, `model/effort` pair, review path) in the assignment packet; the CEO session spawns the persona with exactly that `model` and `effort` and never substitutes its own choice. With Agent Teams the lead session is the spawner in the same way.',
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: 'CLAUDE.md', kind: 'md' }],
    skillsDir: '.claude/skills',
    agentsDir: '.claude/agents',
    agentFile: name => `${name}.md`,
    agentFrontmatter: d => ({ name: d.name, description: d.description }),
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
    delegationNote: "On this tool: spawn subagents from `.claude/agents/` with the Agent tool, one assignment each. A subagent cannot spawn further subagents, so keep the depth at one.",
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
    spawn: 'single-session',
    routingNote: "Routing execution on Codex: one session plays every role. When the session reaches the EM's routing step it records the pair in the assignment packet and, if the harness exposes a model or effort switch, applies it before playing the staff engineer; otherwise it records the intended pair and the operator applies it. If this harness gains nested agent spawning, the EM executes its own routing directly.",
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    skillsDir: '.agents/skills',
    agentsDir: null,
    mcp: null, // global ~/.codex/config.toml only; see references/tool-auth.md
    delegationNote: "On this tool: there are no native subagents. Say what you would have delegated and let the user run it as a separate invocation.",
  },
  cursor: {
    label: 'Cursor',
    commands: { dir: '.cursor/commands', file: n => `${n}.md`, write: (name, description, body) => `# ${description}\n\n${body}` },
    spawn: 'single-session',
    routingNote: "Routing execution on Cursor: one session plays every role. The EM's routing decision is recorded in the assignment packet; the session switches model or effort where the tool allows before playing the staff engineer, otherwise the intended pair is recorded for the operator to apply.",
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: '.cursor/rules/agent-brain.mdc', kind: 'mdc' }],
    skillsDir: '.cursor/skills',
    agentsDir: null,
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers', envRef: v => `\${env:${v}}`, server: s => ({ url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: "On this tool: there are no native subagents. Say what you would have delegated and let the user run it as a separate invocation.",
  },
  gemini: {
    label: 'Gemini CLI',
    commands: { dir: '.gemini/commands', file: n => `${n}.toml`, write: (name, description, body) => `description = ${JSON.stringify(description)}\n\nprompt = """\n${body}\n"""\n` },
    spawn: 'main-only',
    routingNote: 'Routing execution on Gemini CLI: subagents cannot spawn subagents, so the main session is the only spawner. The EM decides the routing in the assignment packet; the main session spawns the persona with that decision and never substitutes its own.',
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: 'GEMINI.md', kind: 'md' }],
    skillsDir: '.gemini/skills',
    agentsDir: '.gemini/agents',
    agentFile: name => `${name}.md`,
    agentFrontmatter: d => ({ name: d.name, description: d.description }),
    mcp: { file: '.gemini/settings.json', key: 'mcpServers', envRef: v => `$${v}`, server: s => ({ httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: "On this tool: invoke a subagent from `.gemini/agents/` by name with the goal, the paths it owns, and the output you expect. A subagent cannot spawn further subagents.",
  },
  opencode: {
    label: 'OpenCode',
    commands: { dir: '.opencode/command', file: n => `${n}.md`, write: (name, description, body) => `---\ndescription: ${description}\n---\n\n${body}` },
    spawn: 'main-only',
    routingNote: "Routing execution on OpenCode: the main session spawns subagents; the EM's routing decision in the assignment packet is applied by the main session (the agent file's `model` is the default; the packet's pair overrides it where the tool allows).",
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    skillsDir: '.opencode/skills',
    agentsDir: '.opencode/agent',
    agentFile: name => `${name}.md`,
    agentFrontmatter: d => ({ description: d.description, mode: 'subagent' }),
    mcp: { file: 'opencode.json', key: 'mcp', extra: { $schema: 'https://opencode.ai/config.json' }, envRef: v => `{env:${v}}`, server: s => ({ type: 'remote', url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: "On this tool: invoke a subagent from `.opencode/agent/` with the goal, the paths it owns, and the output you expect.",
  },
  copilot: {
    label: 'GitHub Copilot',
    commands: { dir: '.github/prompts', file: n => `${n}.prompt.md`, write: (name, description, body) => `---\ndescription: ${description}\n---\n\n${body}` },
    spawn: 'main-only',
    routingNote: "Routing execution on GitHub Copilot: the main chat invokes custom agents; the EM's routing decision in the assignment packet is applied by the main chat where the tool allows a model choice, otherwise recorded for the operator.",
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    pointers: [{ path: '.github/copilot-instructions.md', kind: 'md' }],
    skillsDir: '.github/skills',
    agentsDir: '.github/agents',
    agentFile: name => `${name}.agent.md`,
    agentFrontmatter: d => ({ name: d.name, description: d.description }),
    mcp: { file: '.vscode/mcp.json', key: 'servers', envRef: v => `\${env:${v}}`, server: s => ({ type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: "On this tool: invoke a custom agent from `.github/agents/` with the goal, the paths it owns, and the output you expect. Where custom agents are unavailable, say what you would have delegated instead.",
  },
};

// Codex and OpenCode share AGENTS.md; give them one label so the managed block does not flip-flop.
TARGETS.codex.toolLabel = 'Codex / OpenCode';
TARGETS.opencode.toolLabel = 'Codex / OpenCode';

module.exports = { TARGETS };
