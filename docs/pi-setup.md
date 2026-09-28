# pi Setup

[pi](https://github.com/badlogic/pi-mono) reads `AGENTS.md` from the project root, skills from `.agents/skills/` (already installed with the brain; also `~/.agents/skills/`), and prompt templates from `.pi/prompts/` (or `~/.pi/agent/prompts/`). A prompt template is a Markdown file whose name is the slash command; `$@` is replaced by the arguments. Do not copy skills into `.pi/skills/`.

## Install into a project

Run from the consuming project's root:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull
```

This installs the complete brain, including full personas in `.pi/agents/`, full skills in `.agents/skills/`, and commands in `.pi/prompts/`. Rerun to update, or add `--dry-run` to preview. See [Pull installation](pull-install.md) for prerequisites, pinning, and update behavior.

Review the installed resources before granting project trust. Start a new pi session or run `/reload` after updating skills and prompts. Then in the project:

```
/brain backend-engineer fix the login timeout
/brain-status
```

## MCP

pi's MCP adapter reads the project `.mcp.json`; Linear needs `"auth": "oauth"` there. See [references/tool-auth.md](../references/tool-auth.md).
