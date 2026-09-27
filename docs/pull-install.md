# Pull the brain into a project

From the **consuming repository's root**, run:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull
```

Requires Node.js 22+, npm/npx, and Git. Review the package source before running it. Replace `main` with a reviewed commit SHA or tag to pin a version. Rerun the command to update; nothing pushes updates or synchronizes in the background.

Preview without changing files:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --dry-run
```

## Ownership and updates

**This repository is the source of truth for brain files.** Skills, personas, references, templates, commands, `SOUL.md`, and `.env.example` are replaced with the source version, even if existing copies differ. There are no backups or local-override lists: use Git to review and revert changes. Files previously installed by the tool but no longer supplied by the brain are removed, including edited copies.

**Only `AGENTS.md` is patched:** shared sections come from the current brain, while the existing `## This project` instructions are preserved. Exact links to relocated brain files are adjusted to their tool-local paths; custom project paths are left alone. An initial install without `AGENTS.md` uses the source template. If an existing file lacks that heading or contains it more than once, the pull stops before changing files; identify the project-specific section rather than guessing which instructions to keep.

Application code, the project's `README.md`, real `.env` files, and other files outside the installed brain are untouched. The command does not write global settings or configure credentials/MCP servers. Authentication remains a separate step described in `references/tool-auth.md`.

Commit or stash your work before pulling. Do not edit installed files or run another pull concurrently. The installer preflights paths and uses per-file atomic writes, but an interrupted update is not a repository-wide transaction.

## Installed layout

- Root `AGENTS.md`, `SOUL.md`, and `.env.example`.
- Shared skill copies in `.agents/skills/` for Pi, Codex, Gemini, and Hermes; native copies in `.claude/skills/` for Claude. Both come from the same `skills/` source, selected by `manifest.json`.
- Full persona copies in `.agents/agents/`, `.claude/agents/`, `.gemini/agents/`, and `.pi/agents/`.
- One root `references/` and `templates/` directory. Installed Markdown links to those shared files gain the extra `../` needed for the tool directory; source Markdown is unchanged. Skill-local references/templates stay with their skill, and supporting scripts are copied with it. Generated Terraform state, local tfvars, and provider caches are excluded.
- Skill/persona anatomy guides under `docs/`; project documents are not generated from templates automatically.
- `/brain` and `/brain-status` commands for the supported tools.
- Commands and the shared portion of `AGENTS.md` point directly to the installed tool directories. Only relative Markdown links to shared root references/templates are rebased; there are no wrappers, symlinks, or shared root `skills/` or `agents/` copies.
- `.agent-brain/install-state.json`, recording installed files for repeatable updates and removal of retired files. Keep it in Git with the installed content.

Old copy-based installations are replaced directly without hash-based reconciliation. Redundant managed skill copies under `.pi/`, `.hermes/`, and `.gemini/` are removed in favor of `.agents/skills/`, even if those folders already exist. Unrelated skills and harness settings are left alone. Hermes requires project trust before loading shared project skills; the installer does not grant it. An install made by the earlier wrapper-based version is migrated automatically: wrappers become full copies and only previously managed root skill/persona files are removed. Empty directories left by those managed files are removed; unrelated files remain. Unlisted files are not swept up or deleted. Symlink/nonregular destinations and source/target overlap are still refused to prevent writes outside the intended project.

The source repository's contributor-facing root `AGENTS.md` is never installed: the organization's shared instructions come from `project/AGENTS.md`. Start a new agent session after pulling. See [pi setup](pi-setup.md) and [Codex setup](codex-setup.md); Codex global prompts still require an explicit copy.

The verified discovery rules, settings audit, editable source locations, and remaining command-template duplication are recorded in [Harness layout](harness-layout.md). Check that contract before changing where files are installed.

## Test locally before pushing the installer

From the consuming repo:

```bash
node /absolute/path/to/agent-skills/scripts/agent-brain.js pull --dry-run
node /absolute/path/to/agent-skills/scripts/agent-brain.js pull
```

The consumer must be outside the source checkout. `--target /absolute/path/to/consumer` is available for an explicit existing directory.

`node scripts/build-brain.js` remains a maintainer command for inspecting the assembled `build/` bundle, not a prerequisite for consumer installation.
