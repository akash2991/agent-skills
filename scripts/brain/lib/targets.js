'use strict';
// Per-tool layout. One source of truth (skills/, agents/, templates/) is transformed into these shapes.
// Fields:
//   alwaysOn         — file the tool loads on every session; written as a managed block
//   skillsDir        — where SKILL.md directories go (flat: <skillsDir>/<name>/SKILL.md)
//   agentsDir        — where persona subagent files go, or null when the tool has no subagents
//   agentFile        — file name for a persona subagent
//   agentFrontmatter — frontmatter for a persona subagent from the resolved persona data
//   mcp              — repo-level MCP config: file path, top-level key, per-server shape, env-var reference syntax; null when the tool only has a global config
//   commands         — where user-facing commands live and how a command file is written, or null
//   hooks            — repo-level config that wires automatic usage capture, or null when the
//                      harness has no hook mechanism (then usage stays UNKNOWN until it does)
//   spawn            — 'main-only' (only the main session can spawn personas), 'nested' (any persona can spawn), 'single-session' (no subagents)
//   routingNote      — how the EM's routing decision is executed on this harness; rendered into ORG.md and the model-routing skill
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
    alwaysOn: { path: 'CLAUDE.md', kind: 'md' },
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
    delegationNote: 'Delegation: the main session is the CEO. Spawn every other role as a subagent from `{{AGENTS_DIR}}/` (one per assignment) using the Agent tool; pass the ticket, goal, owned paths, and report format in the prompt. Subagents cannot spawn subagents, so the EM asks the CEO session to spawn engineers on its behalf and the CEO does so without taking over the EM\'s decisions.',
  },
  codex: {
    label: 'Codex',
    commands: { dir: '.codex/prompts', file: n => `${n}.md`, write: (name, description, body) => `# ${description}\n\n${body}` },
    spawn: 'single-session',
    routingNote: "Routing execution on Codex: one session plays every role. When the session reaches the EM's routing step it records the pair in the assignment packet and, if the harness exposes a model or effort switch, applies it before playing the staff engineer; otherwise it records the intended pair and the operator applies it. If this harness gains nested agent spawning, the EM executes its own routing directly.",
    alwaysOn: { path: 'AGENTS.md', kind: 'md' },
    skillsDir: '.agents/skills',
    agentsDir: null,
    mcp: null, // global ~/.codex/config.toml only; see references/tool-auth.md
    delegationNote: 'Delegation: this tool runs one session. Play each role in turn by invoking its persona skill, produce that role\'s report, then move to the next role. Keep the registry current for every role you play, as if each were a separate agent.',
  },
  cursor: {
    label: 'Cursor',
    commands: { dir: '.cursor/commands', file: n => `${n}.md`, write: (name, description, body) => `# ${description}\n\n${body}` },
    spawn: 'single-session',
    routingNote: "Routing execution on Cursor: one session plays every role. The EM's routing decision is recorded in the assignment packet; the session switches model or effort where the tool allows before playing the staff engineer, otherwise the intended pair is recorded for the operator to apply.",
    alwaysOn: { path: '.cursor/rules/agent-brain.mdc', kind: 'mdc' },
    skillsDir: '.cursor/skills',
    agentsDir: null,
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers', envRef: v => `\${env:${v}}`, server: s => ({ url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: 'Delegation: this tool runs one session. Play each role in turn by invoking its persona skill, produce that role\'s report, then move to the next role. Keep the registry current for every role you play, as if each were a separate agent.',
  },
  gemini: {
    label: 'Gemini CLI',
    commands: { dir: '.gemini/commands', file: n => `${n}.toml`, write: (name, description, body) => `description = ${JSON.stringify(description)}\n\nprompt = """\n${body}\n"""\n` },
    spawn: 'main-only',
    routingNote: 'Routing execution on Gemini CLI: subagents cannot spawn subagents, so the main session is the only spawner. The EM decides the routing in the assignment packet; the main session spawns the persona with that decision and never substitutes its own.',
    alwaysOn: { path: 'GEMINI.md', kind: 'md' },
    skillsDir: '.gemini/skills',
    agentsDir: '.gemini/agents',
    agentFile: name => `${name}.md`,
    agentFrontmatter: d => ({ name: d.name, description: d.description }),
    mcp: { file: '.gemini/settings.json', key: 'mcpServers', envRef: v => `$${v}`, server: s => ({ httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: 'Delegation: the main session is the CEO. Every other role is a subagent in `{{AGENTS_DIR}}/`, invoked by name with the ticket, goal, owned paths, and report format in the prompt. Subagents cannot spawn subagents, so the CEO session spawns engineers on the EM\'s behalf without overriding the EM\'s routing decisions.',
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
    delegationNote: 'Delegation: the main session is the CEO. Every other role is a subagent in `{{AGENTS_DIR}}/`, invoked with the ticket, goal, owned paths, and report format in the prompt. The CEO session spawns engineers on the EM\'s behalf without overriding the EM\'s routing decisions.',
  },
  copilot: {
    label: 'GitHub Copilot',
    commands: { dir: '.github/prompts', file: n => `${n}.prompt.md`, write: (name, description, body) => `---\ndescription: ${description}\n---\n\n${body}` },
    spawn: 'main-only',
    routingNote: "Routing execution on GitHub Copilot: the main chat invokes custom agents; the EM's routing decision in the assignment packet is applied by the main chat where the tool allows a model choice, otherwise recorded for the operator.",
    alwaysOn: { path: '.github/copilot-instructions.md', kind: 'md' },
    skillsDir: '.github/skills',
    agentsDir: '.github/agents',
    agentFile: name => `${name}.agent.md`,
    agentFrontmatter: d => ({ name: d.name, description: d.description }),
    mcp: { file: '.vscode/mcp.json', key: 'servers', envRef: v => `\${env:${v}}`, server: s => ({ type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }) },
    delegationNote: 'Delegation: the main chat is the CEO. Every other role is a custom agent in `{{AGENTS_DIR}}/`, invoked with the ticket, goal, owned paths, and report format. Where custom agents are unavailable, play each role in turn by invoking its persona skill.',
  },
};

// Codex and OpenCode share AGENTS.md; give them one label so the managed block does not flip-flop.
TARGETS.codex.toolLabel = 'Codex / OpenCode';
TARGETS.opencode.toolLabel = 'Codex / OpenCode';

module.exports = { TARGETS };
