# Harness discovery and the single source of truth

## Rule

Edit each asset **once in this repository**. Build and installed files are outputs, not alternate sources. Prefer a harness's native shared-directory discovery; make an additional copy only when its own discovery path requires it. A directory's existence is not evidence that it needs another copy.

Before changing installation layout, inspect the consumer's tracked files, relevant discovery settings, and the harness's current documentation or implementation. Distinguish existing project files from files introduced by an earlier installer run. Do not invent reference wrappers, symlinks, settings, or a new directory layout without approval.

## Editable sources here

| Content | Source |
|---|---|
| Skills and skill-local support files | `skills/<name>/` |
| Personas | `agents/<name>.md` |
| Shared references | `references/` |
| Document templates | `templates/` |
| Organization, soul, environment example | `project/AGENTS.md`, `project/SOUL.md`, `project/.env.example` |
| Selection | `manifest.json` |
| Skill/persona anatomy guides | `docs/skill-anatomy.md`, `docs/persona-anatomy.md` |

`build/` is ignored, generated output. Consumer-specific documents created from templates remain owned by that project. In installed `AGENTS.md`, the `## This project` section remains project-specific; shared instructions are rebuilt here.

**Existing exception:** slash commands have separately maintained tool-specific source templates (`.claude/commands/`, `.gemini/commands/`, `commands/`, `.pi/prompts/`, `.codex/prompts/`). They are not currently generated from one common command definition. Command validation checks parity, but does not make their bodies single-source. Consolidating them is a separate change requiring approval.

## Skill discovery: copy only where needed

| Harness | Project skill discovery | Installer action |
|---|---|---|
| Codex | `.agents/skills/` | Use shared copies |
| Pi | `.agents/skills/` (also supports `.pi/skills/`) | Use shared copies; do not populate `.pi/skills/` |
| Hermes | `.agents/skills/` and `.hermes/skills/`, after project trust | Use shared copies; do not populate `.hermes/skills/` |
| Gemini CLI | `.agents/skills/` and `.gemini/skills/`; shared alias takes precedence | Use shared copies; do not populate `.gemini/skills/` |
| Claude Code | `.claude/skills/` | Keep full native copies; no direct `.agents/skills/` discovery is documented |

Thus the installed skill bodies live only in `.agents/skills/` and `.claude/skills/`. Neither is edited independently; both come from the same source skills. Their adjacent `references/` and `templates/` copies preserve existing `../../references/…` links without rewriting skill content. Root references/templates are also retained for project instructions and document creation.

Claude supports symlinked skill directories, but introducing symlinks would change the installation contract and portability; the installer does not do that automatically. Additional-directory permissions alone do not redirect Claude skill discovery.

## Personas and commands are different resources

Do not infer persona discovery from skill discovery:

- `.agents/agents/`: common persona documents read by the brain prompts; this is not a claim of universal native subagent discovery.
- `.claude/agents/`: Claude's native project subagents.
- `.gemini/agents/`: Gemini's native project agents.
- `.pi/agents/`: project personas discovered by **pi-herdr-agents**, the extension used here, not Pi core.
- Keep command templates in each harness's documented command/prompt directory. Codex global custom prompts require a separate user-controlled copy; the installer does not write to the home directory.

The installer adjusts command skill paths to `.agents/skills/` except for Claude's `.claude/skills/`. It does not overwrite harness settings, MCP configuration, global configuration, or trust decisions.

## Evidence checked during the Freedo audit

- Freedo's committed `.pi/skills/` and `.hermes/skills/` contained only the unrelated `lavish` skill, not copies of this brain. The installer must not interpret those folders as a request to duplicate all skills.
- Freedo's `.gemini/settings.json` configures MCP servers, not alternative skill search paths. `CLAUDE.md` and `GEMINI.md` both import the root `AGENTS.md`.
- Freedo's `.claude/settings.local.json` selects enabled MCP servers; it does not redirect skills. Pi's installed packages include pi-herdr-agents.
- The installed Hermes implementation defines `PROJECT_SKILLS_SUBDIRS` as `.hermes/skills` and `.agents/skills`. Discovery requires project trust and must not be disabled in configuration. Freedo was **not trusted at audit time**, so Hermes returned no project skill locations. Copying more files cannot fix a trust decision.
- If the user chooses to trust reviewed project skills, run `hermes skills trust /path/to/project`. Do not grant trust automatically.

Sources to recheck when harness versions change:

- [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md); installed Pi `docs/skills.md` confirms `.agents/skills/` support.
- [Hermes discovery implementation](https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_utils.py): `PROJECT_SKILLS_SUBDIRS`, `get_project_skills_dirs`.
- [Gemini skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md) and [subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md).
- [Claude skills](https://code.claude.com/docs/en/skills) and [subagents](https://code.claude.com/docs/en/sub-agents).
- [Codex skills](https://developers.openai.com/codex/skills).
- Installed pi-herdr-agents discovery: project `.pi/agents/`, then user and bundled definitions.

## Migration and guardrails

Only remove redundant copies previously recorded in `.agent-brain/install-state.json`. Leave unrelated or untracked third-party skills (such as `lavish`) and settings alone. A changed layout must pass fresh-install, existing-install migration, shared command path, idempotence, and unrelated-file preservation tests. Keep this document and the installer mapping in sync.
