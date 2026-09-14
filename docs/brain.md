# The Brain

This repository is an injectable brain for agentic coding. One source of truth (personas, a flat skill dump, an organization, templates) is transformed into the file layout each coding tool expects and injected into any repository. That repository then follows the same roles, rules, escalation path, report formats, docs, and project-management conventions, whichever tool is driving.

## Layout

```text
manifest.json     which skills and personas to build, which tools, PM tool, org dir name
package.json      npm run validate | select | build | all | inject | import
agents/           personas (source of truth); abstract base + discipline specializations via `extends`
skills/           flat skill dump (source of truth); `category:` frontmatter groups them at build time: process, design, coding, testing, delivery, domain, tools
templates/        org/ (ordered parts emitted as one always-on ORG.md), reports/, registry/, observability/, global-docs/, service-docs/
references/       shared checklists + project-management-interface.md
docs/             persona-anatomy.md, skill-anatomy.md, this file
scripts/brain/    validate · select · build · inject · import
build/            GENERATED: build/selected* (the two selections) and build/{product,self}/<tool>/ (ready to inject)
```

## Workflow

```bash
npm run import -- /path/to/some-skill --category coding   # dump a skill (or write skills/<name>/SKILL.md by hand)
#  edit manifest.json                                       # choose skills and personas
npm run all                                                 # validate + select + build
npm run inject -- /path/to/repo [--targets claude-code,codex] [--dry-run]
#  then start a new agent session in that repo and type the slash command /brain
```

Inject never deletes. It overwrites what the brain owns, merges `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`copilot-instructions.md` as a managed block, merges `.mcp.json` by server name, and creates seeds (registry, global docs, services folder) only when missing. Re-running is idempotent.

## What each tool receives

| Tool | Always-on rules | Skills (incl. one per persona) | MCP |
|---|---|---|---|
| Claude Code | `CLAUDE.md` block | `.claude/skills/<name>/` | `.mcp.json` (`${VAR}`) |
| Codex | `AGENTS.md` block | `.agents/skills/<name>/` | global `~/.codex/config.toml`, snippet in `references/tool-auth.md` |
| Cursor | `.cursor/rules/agent-brain.mdc` | `.cursor/skills/<name>/` | `.cursor/mcp.json` (`${env:VAR}`) |
| Gemini CLI | `GEMINI.md` block | `.gemini/skills/<name>/` | `.gemini/settings.json` (`$VAR`) |
| OpenCode | `AGENTS.md` block | `.opencode/skills/<name>/` | `opencode.json` (`{env:VAR}`) |
| GitHub Copilot | `.github/copilot-instructions.md` block | `.github/skills/<name>/` | `.vscode/mcp.json` (`${env:VAR}`) |

Every tool also receives `.agent-brain/` (configurable): `ORG.md`, `registry/`, `observability/`, `docs/` (global docs), `services/`, `templates/`, `references/` (links from skills to `../../references/` are rewritten to this copy). Layouts are entries in `scripts/brain/lib/targets.js`.

## The organization

```text
User → CEO → PM (brainstorms the spec with the user; PRD)
              → Principal Engineers: backend · web · mobile (unified HLD, domain models, key interfaces, plan; effort high)
              → EM per service, owning backend + web + mobile (milestones, sprints, routing, service docs); driver EM for cross-service features
                   → Staff Engineers: backend · web · mobile (foundation task first, then parallel tasks)
                   → Code Reviewers: backend · web · mobile (merge gate for reviewed-class changes)
                   → QA Engineer (independent verification, test strategy, Prove-It tests)
                   → Specialists: security-auditor, web-performance-auditor
```

Every persona defines role, responsibilities, goals, communication, success criteria, tools, authorization (ending with a refusal of out-of-scope work), way of working, quality non-negotiables, the skills it may use, composition (how it is invoked, never by another persona), and red flags, and no model or effort at all: those are set per task when firstmate dispatches the work, and the control plane records what ran. A task no persona covers becomes a hiring request (`references/hiring.md`). Credentials and per-tool MCP setup are in `references/tool-auth.md`. Discipline personas `extends` a base persona and override or add sections (see `docs/persona-anatomy.md`). The skill list is enforced by `npm run validate`.

The owner's operating-system notes (`agent-os/AGENT_OPERATING_SYSTEM.md`) are folded in: stack and repository rules in `templates/global-docs/CONVENTIONS.md`; the QA model as the `test-engineer` persona; the TPM function, visibility, token usage, model switching, and current-product-state format as the `delivery-status` skill; story states, INVEST, points, and sprints (with spillover and estimation tracking) in `milestone-planning` and `linear`; delegation prompts in `references/assignment-packet.md`; the execution checklist and definition of done in `references/execution-checklist.md`; blocker types in `escalation`; scope-creep classes and requirement clarity in `prd-writing` and `ORG.md`; the pattern catalog in `lld`; personalities in each persona.

Philosophy and stack: the core philosophy (build-time cost, illegal states unrepresentable, stable interfaces, feature-first colocation, backend-only validation, semver and changelog) is `org/05-philosophy.md`; the tech stack and the rules it implies are the global `CONVENTIONS.md`; what a PE puts in an HLD is the `hld` skill; the LLD principles are the `lld` skill; personas only point at them.

Delivery mechanics: every task ships through a pull request (`references/pull-request.md`) raised by the staff engineer, reviewed with inline comments by the discipline code reviewer, with the Linear ticket mirroring each step; staff engineers instrument what they ship with technical, product, and business metrics and restrained logging (`references/metrics-and-logging.md`).

Agent-work observability: the crew runs under [firstmate](https://github.com/kunchenguid/firstmate), which spawns each role into its own herdr or tmux pane, sets its model and effort, supervises it, and reads provider quota. The brain does not duplicate any of that. Every injected target gets a SQLite control plane under `.agent-brain/control-plane/` holding only recorded usage: metadata-only events that harness hooks capture from the transcript, attributed to firstmate's task id. Trace timelines and cost dashboards come from Langfuse, which the control plane exports to over OTLP with no dependency to install. The architecture, privacy defaults, capability ownership, and sources are in `references/agent-observability.md`. No external tool is installed or contacted by injection.

The upstream reviewer and auditor personas were reconciled into the same anatomy: `code-reviewer` is the abstract base of the three discipline code reviewers, `test-engineer` merged into `test-engineer`, and `security-auditor` and `web-performance-auditor` joined the organization as specialists with their frameworks under `## Framework`. They are reached through the CEO like every other role: the direct-invocation commands were removed, because a command that starts a specialist bypasses the budget and priority decisions the CEO exists to make.

## Next steps

- Host adapters that automatically translate Claude/Codex/Kimi/Cursor hook payloads into the common agent-work event contract.
- Optional OTLP/Langfuse exporter after field behavior is proven with real sessions.
- Slash commands per tool once the roles have run on a real project.
- Uninstall (`inject --remove`) from `.agent-brain/injected.json`.
