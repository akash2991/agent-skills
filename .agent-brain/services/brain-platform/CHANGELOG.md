# brain-platform Changelog

Newest first. One line per merged task, written by the staff engineer, checked by the EM at milestone close.

## Unreleased

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
