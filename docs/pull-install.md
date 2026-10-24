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

## Optional automatic Langfuse tracing (Pi and Claude Code)

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --langfuse
```

Explicitly opts this repository into both official plugins: Pi `0.1.2` and Claude Code `1.2.1`. Requires both CLIs, a runtime for Claude's Python hook, and a project you have chosen to trust in Pi. Registration is delegated to native project-scoped package/plugin managers, preserving unrelated settings and hooks. Configure credentials once per developer for each harness, outside Git; see [Langfuse setup, privacy, and verification](langfuse-setup.md). After setup and approvals, new sessions in both harnesses trace automatically. Prompts, outputs, tool data, and images can be uploaded. Other harnesses and the application's own runtime are not instrumented.

`--dry-run --langfuse` describes both registrations without invoking CLIs. Missing CLI/runtime, malformed settings, and unsafe settings paths fail before brain writes. Package installation happens after the brain pull; failures can leave the brain and/or Pi setup installed. Errors describe the partial state and retry action. For a fresh/untrusted repo, review the installed files and start Pi to make your trust decision before retrying. Commit `.pi/settings.json` and `.claude/settings.json`, ignore `.pi/npm/`, and start new approved sessions in each harness. Subsequent pulls without the flag preserve both registrations. No automatic credential copying, saved trust grant, or globally enabled plugin is introduced; native managers may maintain per-user caches/install records.

## Ownership and updates

**This repository is the source of truth for brain files.** Skills, personas, references, templates, commands, `SOUL.md`, and `.env.example` are replaced with the source version, even if existing copies differ. There are no backups or local-override lists: use Git to review and revert changes. Files previously installed by the tool but no longer supplied by the brain are removed, including edited copies.

**Only `AGENTS.md` is patched:** shared sections come from the current brain, while the existing `## This project` instructions are preserved. Exact links to relocated brain files are adjusted to their tool-local paths; custom project paths are left alone. An initial install without `AGENTS.md` uses the source template. If an existing file lacks that heading or contains it more than once, the pull stops before changing files; identify the project-specific section rather than guessing which instructions to keep.

Application code, the project's `README.md`, real `.env` files, and other files outside the installed brain are untouched. The command does not write global settings or configure credentials/MCP servers. Only the explicit `--langfuse` option delegates project Pi/Claude plugin registration; those settings remain harness-owned, outside the brain's replace/prune manifest. Authentication remains a separate step described in `references/tool-auth.md`.

Commit or stash your work before pulling. Do not edit installed files or run another pull concurrently. The installer preflights paths and uses per-file atomic writes, but an interrupted update is not a repository-wide transaction.

## Installed layout

- Root `AGENTS.md`, `SOUL.md`, and `.env.example`.
- Shared skill copies in `.agents/skills/` for Pi, Codex, Gemini, and Hermes; native copies in `.claude/skills/` for Claude. Both come from the same `skills/` source, selected by `manifest.json`.
- Full persona copies in `.agents/agents/`, `.claude/agents/`, `.gemini/agents/`, and `.pi/agents/`.
- One root `references/` and `templates/` directory. Installed Markdown links to those shared files gain the extra `../` needed for the tool directory; source Markdown is unchanged. Skill-local references/templates stay with their skill, and per-project runtime scripts are copied with it. Account-wide Terraform provisioning sources, generated state, local tfvars, and provider caches are excluded.
- Skill/persona anatomy guides are source-repository authoring documentation and are not installed. Project documents are not generated from templates automatically.
- `/brain` and `/brain-status` commands for the supported tools.
- Commands and the shared portion of `AGENTS.md` point directly to the installed tool directories. Only relative Markdown links to shared root references/templates are rebased; there are no wrappers, symlinks, or shared root `skills/` or `agents/` copies.
- `.agent-brain/install-state.json`, recording installed files for repeatable updates and removal of retired files. Keep it in Git with the installed content.

Previously managed anatomy guides and the dev-machine files that used to ship with `development-setup` (its Terraform, `cloud.md`, and the cloud scripts) are pruned on update. Unmanaged files, including local Terraform state and variables, are not removed.

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
