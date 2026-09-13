# brain-platform Changelog

Newest first. One line per merged task, written by the staff engineer, checked by the EM at milestone close.

## Unreleased

- F-self-30 — one organization document per repository: every target's always-on content is `AGENTS.md`, and `CLAUDE.md`, `GEMINI.md`, the Cursor rule, and the Copilot instructions became short pointers to it — org-staff-engineer
- F-self-31 — the build emits one command per persona from a single template instead of one entry command, so the coordinator can invoke a role directly — org-staff-engineer
- F-self-24 — every shipped command must be named `brain-<something>`, enforced by the validator rather than by convention, because commands share a directory with the project's own and with other tools' — org-staff-engineer
- F-self-25 — the build copied `control-plane/brain.db` into all twelve target trees, so injection would have written this repository's sessions, agents, budgets and events into every consuming project. Runtime state is excluded at build time and the validator fails if a database ever appears in a build again — org-staff-engineer
- F-self-15 — Herdr removed. It manages terminal panes, and a subagent has no pane, so the hierarchy the organization cares about was never visible in it. Adapter, plugin manifest, CLI `control` group, server route, and the orphaned file-era test archived under `deprecated/removed-integrations/` — org-staff-engineer
- F-self-16 — the entry command is namespaced `brain-init`. Codex resolves custom prompts as `/prompts:<name>` from `$CODEX_HOME/prompts` only, so `/brain` could never have worked there — org-staff-engineer
- F-self-17 — injection now retires a file it previously owned and no longer produces, so a renamed command stops answering in an injected repository. Seeds, always-on files and merged config are never retired — org-staff-engineer
- F-self-18 — injection crashed on the first run into a fresh repository while reading a summary that does not exist yet. Found by the new `inject-test.js`, which also pins idempotency, seed safety, and per-project control planes — org-staff-engineer
- F-self-19 — Langfuse tracing silently did nothing in a project whose `.env` had no keys. Credentials are now looked up in the project, every directory above it, and `~/.agent-brain/.env`, export defaults to `turn` so the trace view is live, and session start states plainly whether tracing is on or off and why — org-staff-engineer
- F-self-20 — a fresh control plane is seeded with a real provider quota reading, and every later read is snapshotted into `provider_quota`, so budgets start from the account rather than from a default in the code — org-staff-engineer
- F-self-21 — the UI put every component in one auto-fit grid, so each new row reflowed the page under the reader. One component per tab now, each scrolling inside its own panel, with counts on the labels and the chosen tab remembered — org-staff-engineer
- F-self-9 — captured usage was attributed to a synthetic `session-*` agent, so every role spent against an empty budget. Sessions now record the harness's own session id, the claimed role binds to it, and usage already observed on that session is adopted rather than stranded — org-staff-engineer
- F-self-10 — thinking effort and reasoning tokens were reported `UNKNOWN` although the harness exposes both. The hook now reads `CLAUDE_EFFORT` and `output_tokens_details.thinking_tokens` — org-staff-engineer
- F-self-11 — Langfuse export added: OTLP/HTTP straight to `/api/public/otel/v1/traces` with no dependency, one trace per agent nested by `agents.parent`, generations carrying model, cache and reasoning tokens, and cost. Stable low-cardinality names and metadata-only input/output per Langfuse best practices. Idempotent through deterministic span ids and an `exports` table — org-staff-engineer
- F-self-12 — `CREATE TABLE IF NOT EXISTS` never adds a column to a live table, so schema changes silently skipped existing databases. Additive migrations are now declared and applied on open — org-staff-engineer
- F-self-13 — the frontmatter round-trip flattened YAML sequences and block scalars, corrupting any imported skill that used them. Sequences and block scalars now survive import — org-staff-engineer
- F-self-8 — `agent set` could change `runtime_ref` but not `runtime`, so an agent registered before its terminal existed could never complete a Herdr binding and control stayed refused forever. Both are settable now, with a test — org-staff-engineer
- F-self-6 — Codex `/brain` did not resolve: the prompt was written to repo-local `.codex/prompts`, which Codex never reads. Targets now declare a command scope, and injection installs a harness-global command with `--install-commands` or prints the exact copy line — org-staff-engineer
- F-self-1 — build, dist, and dist-self consolidated into one `build/` tree: `selected/`, `selected-self/`, `product/<tool>/`, `self/<tool>/` — org-staff-engineer
- F-self-2 — `self.omit` added so the self build drops the three mobile personas and the web performance auditor; leak check now runs both directions — org-staff-engineer
- F-self-3 — `HLD.md` replaced by a small `LLD.md` as this service's whole design record (D-4); the TypeScript and React conformance milestone withdrawn and recorded as a sanctioned divergence (D-2) — org-staff-engineer
