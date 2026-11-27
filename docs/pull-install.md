# Pull the brain into a project

From the **consuming repository's root**, run:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull
```

Requires Node.js 22+, npm/npx, and Git. Review the package source before running it. Replace `main` with a version tag (`#brain-v1.0.0`) or a reviewed commit SHA to pin a version. Rerun the command to update; the brain itself is never pushed or updated in the background. The one background job it installs is the artifact sync (`documentation` W12): when an agent finishes, it may open a PR with updated artifacts into the branch the agent pushed.

Preview without changing files:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --dry-run
```

## Versions, drift, and the changelog

The brain has a semver version. Major means the project must act after pulling; minor adds something; patch fixes or rewords. Each pull records the version it installed in `.agent-brain/install-state.json` and installs the brain's changelog at `.agent-brain/CHANGELOG.md`. A root `CHANGELOG.md` is the project's own and is never touched.

See how far the project is from the latest brain, without changing anything:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain status
```

```text
installed: 1.2.0
available: 1.4.1
behind: a minor update; run agent-brain pull to update

changes since 1.2.0:

1.4.1 - 2026-12-09
  ### Fixed
  - FAC-71 — ...
```

`status` compares the install with the brain the command was run from, so `#main` answers "how far behind the latest" and `#brain-v1.3.0` answers "what would 1.3.0 bring". It also lists brain files edited or deleted since the install, which the next pull replaces or restores. A project is meant to edit its own part of `AGENTS.md` (the `## This project` section) and of `models.json` (its `artifacts`), and a pull keeps that part, so such an edit is listed apart; an edit anywhere else in those files is listed with the rest, because a pull overwrites it. `status --check` exits 1 when the brain is not installed, is behind, or has an edit a pull would overwrite or a file missing, for a scheduled job or a CI step. An edit to the project's own part does not fail it, and neither does an install newer than the brain it is compared with.

`pull` and `pull --dry-run` open with the same comparison (`brain: 1.2.0 → 1.4.1 (minor)`) and the changelog sections in between. Pulling an older version says `(downgrade)` and lists what it removes, as does `status`; the list comes from the installed changelog, so when that file was edited or deleted the command says it cannot list the removals instead. An install made before the brain had versions shows as `unversioned`; the next pull gives it one. A brain older than 1.0.0 does not know the installed changelog and refuses to pull over a 1.0.0 or later install; to go back that far, revert the pull in Git.

## Optional automatic Langfuse tracing (Pi and Claude Code)

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --langfuse
```

In a reviewed revision containing the first-party runtime, explicitly opts this repository into metadata-only Pi/Claude development-session tracing. Older published revisions still install the leaking official plugins; do not mistake those for the remediation. Requires Node 22+, npm, Pi 1.3.0+, Claude 2.1.304+ and native project approval. Installs managed runtime resources, prepares a private pinned SDK cache, registers a native Pi extension file and Claude hooks, and disables known legacy exporters while preserving unrelated settings. Configure one shared private credential tuple per developer, outside Git; see [setup, privacy, current verification and remaining gates](langfuse-setup.md). Content, reasoning and media are not export fields; labels must be non-secret identifiers. Other harnesses and application runtimes are not instrumented.

`--dry-run --langfuse` describes registration without invoking CLIs or downloading SDKs. Preflight catches missing/old CLIs, malformed settings, unsafe paths and known conflicting legacy overrides before brain writes. SDK/native setup follows the asset pull and can leave partial state; inspect the error and retry. Review executable resources and make your own native trust decision. Commit the project settings and non-secret `.agent-brain/tracing.json` marker; restart both harnesses. Ordinary pulls preserve those native declarations. No credentials or trust grants are copied. Only the additional explicit `--worktree-bootstrap` flag changes native Pi user package registration for project-gated old-base worktree discovery, removing a known legacy user exporter if present. Registration/readiness/transport acceptance are not verified ingestion.

## Ownership and updates

**This repository is the source of truth for brain files.** Skills, personas, references, templates, commands, `SOUL.md`, `.env.example`, and `models.json` are replaced with the source version, even if existing copies differ. There are no backups or local-override lists: use Git to review and revert changes. Files previously installed by the tool but no longer supplied by the brain are removed, including edited copies. One exception: an edited `review-models.json` (renamed `models.json`) stops the pull, so you can see what you changed before deleting it.

**Only `AGENTS.md` and `models.json` are patched:** shared sections come from the current brain, while the existing `## This project` instructions are preserved. `models.json` takes the brain's models and keeps the project's own `artifacts` map (`documentation` W12). Exact links to relocated brain files are adjusted to their tool-local paths; custom project paths are left alone. An initial install without `AGENTS.md` uses the source template. If an existing file lacks that heading or contains it more than once, the pull stops before changing files; identify the project-specific section rather than guessing which instructions to keep.

Application code, the project's `README.md`, real `.env` files, and other files outside the installed brain are untouched. Default pull does not write global settings or configure credentials/MCP servers. It does merge the artifact sync hook into `.claude/settings.json` and `.pi/settings.json`, and only that ([harness layout](harness-layout.md)). The explicit `--langfuse` option merges native project tracing declarations; `--worktree-bootstrap` additionally opts into native Pi user package registration. Settings and the opt-in marker stay outside the brain's replace/prune manifest; only the runtime files under `.agent-brain/observability/` are managed assets. Authentication remains a separate step described in `references/tool-auth.md`.

Commit or stash your work before pulling. Do not edit installed files or run another pull concurrently. The installer preflights paths and uses per-file atomic writes, but an interrupted update is not a repository-wide transaction.

## Installed layout

- Root `AGENTS.md`, `SOUL.md`, `.env.example`, and `models.json`.
- Shared skill copies in `.agents/skills/` for Pi, Codex, Gemini, and Hermes; native copies in `.claude/skills/` for Claude. Both come from the same `skills/` source, selected by `manifest.json`.
- Full persona copies in `.agents/agents/`, `.claude/agents/`, `.gemini/agents/`, and `.pi/agents/`. The `.claude/`, `.gemini/`, and `.pi/` copies carry native tool names in place of the labels ([harness layout](harness-layout.md#persona-tools-labels-in-the-source-native-names-in-harness-copies)).
- One root `references/` and `templates/` directory. Installed Markdown links to those shared files gain the extra `../` needed for the tool directory; source Markdown is unchanged. Skill-local references/templates stay with their skill, and per-project runtime scripts are copied with it. Account-wide Terraform provisioning sources, generated state, local tfvars, and provider caches are excluded.
- Skill/persona anatomy guides are source-repository authoring documentation and are not installed. Project documents are not generated from templates automatically.
- `/brain`, `/brain-status`, and `/orchestrator` commands for the supported tools.
- Commands and the shared portion of `AGENTS.md` point directly to the installed tool directories. Only relative Markdown links to shared root references/templates are rebased; there are no wrappers, symlinks, or shared root `skills/` or `agents/` copies.
- `.agent-brain/install-state.json`, recording the installed brain version and files for repeatable updates and removal of retired files, and `.agent-brain/CHANGELOG.md`, the brain's changelog. Keep both in Git with the installed content.

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
