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
| Skill/persona anatomy guides (source-only; not installed) | `docs/skill-anatomy.md`, `docs/persona-anatomy.md` |
| Account-wide provisioning (source-only; not installed) | `skills/development-setup/terraform/` |

The anatomy guides describe how maintainers author this brain; consuming projects do not need them. Terraform provisioning is shared per AWS account, not per project: installed cloud guidance links back here for provisioning, while per-project cloud and mobile-build scripts remain installed. Neither authoring guides nor provisioning sources are included in the generated bundle or npm package. Updates prune only previously managed copies, never unmanaged state or variables.

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

Thus the installed skill bodies live only in `.agents/skills/` and `.claude/skills/`. Neither is edited independently; both come from the same source skills. Shared references and document templates live **only at the project root**. Installation rebases relative Markdown links to those shared files (for example `../../references/…` becomes `../../../references/…` inside a tool's skill directory). Source content stays unchanged, and skill-local `references/` links are not rebased. References are supporting documents loaded through links/instructions, not independently auto-discovered harness resources.

Claude supports symlinked skill directories, but introducing symlinks would change the installation contract and portability; the installer does not do that automatically. Additional-directory permissions alone do not redirect Claude skill discovery.

## Personas and commands are different resources

Do not infer persona discovery from skill discovery:

- `.agents/agents/`: common persona documents read by the brain prompts; this is not a claim of universal native subagent discovery.
- `.claude/agents/`: Claude's native project subagents.
- `.gemini/agents/`: Gemini's native project agents.
- `.pi/agents/`: project personas discovered by **pi-herdr-agents**, the extension used here, not Pi core.
- Keep command templates in each harness's documented command/prompt directory. Codex global custom prompts require a separate user-controlled copy; the installer does not write to the home directory.

The installer adjusts command skill paths to `.agents/skills/` except for Claude's `.claude/skills/`. It does not overwrite harness settings, MCP configuration, global configuration, or trust decisions.

## Runtime checks versus documentation

A file being copied is not proof that a harness discovers it. Test entry-point discovery separately from a model choosing to use it. Supporting documents (`references/`, `templates/`, project `SOUL.md`) are read on demand through instructions/links, not automatically scanned as skills or personas. Installing another copy does not make them automatic context.

### Installed-loader checks on Freedo

| Resource | Test result | Qualification |
|---|---|---|
| Pi 0.87.1 project instructions | `DefaultResourceLoader.getAgentsFiles()` loaded root `AGENTS.md` | Available even in the untrusted sandbox test |
| Pi project skills | 32 brain skills loaded from `.agents/skills/`, plus the existing `lavish` skill | Real Pi config trusts Freedo; an isolated untrusted loader loaded zero project skills |
| Pi commands | `brain` and `brain-status` loaded from `.pi/prompts/` | Project trust required; both absent in the untrusted sandbox test |
| pi-herdr-agents 2.0.4 personas | Registered `subagents_list` logic found all 9 project personas in `.pi/agents/`, no diagnostics | Installed extension code executed with host import shims in `/tmp`; not a model/subagent execution test |
| Hermes 0.21.2 (`6636b0896c`) project instructions | `build_context_files_prompt(cwd=project, skip_soul=True)` loaded root `AGENTS.md`, organization, and project section | No need to copy AGENTS into `.hermes/` |
| Hermes project skills | Live discovery returned no project roots; isolated trusted configuration found `.agents/skills/` | **Live trust blocker**, not a missing-directory problem; trust was not changed |
| Codex CLI 0.157.1 skills | Native app-server `skills/list` returned all 32 brain skills from `.agents/skills/`, enabled, repo scope, no errors | Temporary `CODEX_HOME`; existing `lavish` also discovered; no model thread/turn created |
| Codex project instructions | Root `AGENTS.md` is its documented native context file; installed binary corroborates discovery precedence | Documentation/static evidence, not a context-injection execution test |
| Codex commands | Repo `.codex/prompts/` is **not** an automatic project command directory | These are staging files for optional user-controlled global installation; custom prompts are deprecated in favor of skills |
| Claude Code 2.1.283 skills, personas, commands | Native stream-JSON `initialize` returned all 32 brain skills, all 9 personas, `brain`, and `brain-status` | Project `.claude/` paths corroborated by installed implementation; hooks/MCP disabled for the probe, no user/model turn, no session persistence |
| Claude project instructions | Freedo's `CLAUDE.md` imports `@AGENTS.md` | Import exists and follows documented loading; initialization metadata does not expose loaded context text, so this is not an injection test |
| Gemini CLI | Not installed on the audit machine; official skill/subagent docs support the paths above | **Documentation only**, no runtime pass claimed; Freedo's `GEMINI.md` imports `@AGENTS.md` |
| Antigravity | No installed CLI found; no native loader test performed | **Unverified**; do not infer discovery from existing `commands/` files or copy more files as a workaround |
| Installed supporting references | All 90 installed skill reference links resolved in Freedo after migration; regression tests also cover root templates and nested Markdown links | Filesystem resolution test, not a claim that a model has read every reference |

Runtime checks used local loader/control APIs with no model calls. Sandbox trust was confined to temporary configuration; no real trust grants were made. Counts and versions are an audit snapshot, not a permanent contract. Static binary searches alone are insufficient: an initial inspection missed Codex's shared-directory support, which its actual `skills/list` response confirmed. The installer therefore does **not** add `.codex/skills/` copies.

Project instructions differ from skills: Pi, Codex, and Hermes can load root `AGENTS.md`; Freedo's Claude/Gemini entry files import it. Preserve those imports rather than copying its full content into each harness. Do not rely on Claude's rollout-gated AGENTS fallback in projects with a `CLAUDE.md`. A fresh installation without an import bridge must use `/brain` to explicitly read AGENTS (or add a reviewed native import); the installer does not silently replace existing context files.

### Repeating the Pi resource check

From a consuming repo, use the installed Pi SDK. Set `PI_ROOT` to its package directory (for example the directory under `npm root -g`), then run:

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent" node --input-type=module <<'JS'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(process.env.PI_ROOT, 'dist/index.js')));
const cwd = process.cwd();
const agentDir = mkdtempSync(join(tmpdir(), 'brain-discovery-'));
try {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  // In-memory sandbox permission only; never grant real project trust here.
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noThemes: true });
  await loader.reload();
  console.log({
    skills: loader.getSkills().skills.map(s => s.filePath),
    prompts: loader.getPrompts().prompts.map(p => p.filePath),
    context: loader.getAgentsFiles().agentsFiles.map(f => f.path),
  });
} finally { rmSync(agentDir, { recursive: true, force: true }); }
JS
```

For Hermes, use its installed Python environment with its checkout on `PYTHONPATH`. `agent.skill_utils.get_project_skills_dirs()` tests live skill discovery; `get_untrusted_project_skills_root()` identifies a trust blocker. `agent.prompt_builder.build_context_files_prompt(cwd=project, skip_soul=True)` tests project-context loading. Print paths/counts, not configuration secrets or document contents. Do not change the real trust list to make a test pass.

### Repeating native Codex and Claude discovery

For Codex, run `codex app-server --stdio` with a temporary `CODEX_HOME` and analytics disabled (`-c analytics.enabled=false`). Send newline-delimited JSON-RPC over its stdin, waiting for each response:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"brain-discovery","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"id":2,"method":"skills/list","params":{"cwds":["/absolute/path/to/project"],"forceReload":true}}
```

Check `result.data[].skills` for paths, `scope: "repo"`, and `enabled: true`, plus an empty `errors` list. No `thread/start` or model turn is necessary. Terminate the server and remove the temporary home when done. Repository `.codex/prompts/` is not evidence of prompt discovery; see [Codex's deprecated custom prompts](https://developers.openai.com/codex/custom-prompts/) and [our Codex setup](codex-setup.md).

For Claude, start in the consuming repository:

```bash
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude --print \
  --input-format stream-json --output-format stream-json --verbose \
  --no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --settings '{"disableAllHooks":true}'
```

Send this control message, keeping stdin open until its response:

```json
{"type":"control_request","request_id":"discovery-init","request":{"subtype":"initialize"}}
```

Inspect `control_response.response.response.commands` and `.agents`, then terminate. Do **not** send a user prompt: this is a metadata/discovery check, not an inference test. Do not publish the complete response, which can include account metadata. `claude agents` in 2.1.283 lists background sessions, not discovered persona definitions; `doctor` checks installation health, not document loading.

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
