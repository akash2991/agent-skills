# Langfuse privacy and subagent audit — 2026-10-20

**Status: failures reproduced; remediation is not implemented by this PR.** This is a follow-up to [PR #8](https://github.com/akash2991/agent-skills/pull/8). Do not interpret successful installation, unit tests, or this report as proof that content telemetry is safe for sensitive sessions.

## Method and boundaries

Exercised installed Pi plugin **0.1.2**, Claude plugin **1.2.1**, and **pi-herdr-agents 2.0.5**, using real models, real tools, real child runtimes, and observations fetched back through the Langfuse CLI. The native run versions were Pi **1.0.2** and Claude Code **2.1.304**.

Only synthetic, nonfunctional key/password canaries, an `example.invalid` email, and an invalid SSN were intentionally placed in prompts, tool inputs/results, and outputs. No real secrets were inserted into model context. Normal authentication still used private credentials. The configured real secret was not found in the retrieved test observations; because it was never intentionally put in test content, this does **not** demonstrate that real secrets are redacted.

Raw transcripts and fetched observations remain private local artifacts; they are not checked in. Account/project identifiers, credential values, and private trace URLs are deliberately omitted here. Inspection was restricted to the expected test sessions, not unrelated account traces. Source-checkout changes belonging to other work were untouched.

## Findings

| Surface | Result | Live evidence |
|---|---|---|
| Pi arbitrary secret/PII redaction | **FAIL** | Fake provider key, password, email, and invalid SSN persisted in inputs/outputs. |
| Pi generic Langfuse-key redaction | **FAIL overall** | Quoted occurrences were masked; the same fake key survived in multiline child/parent generation and root outputs in the direct-child control. |
| Claude secret/PII redaction | **FAIL** | All five synthetic canaries persisted in inputs/outputs. |
| Claude native subagent | **Partial capture** | One child execution observation, three child generation observations (one synthetic/unpriced), and one child Read tool nested in the parent trace/session. Child execution is `SPAN`, not `AGENT`; a separate `Tool: Agent` dispatch also exists. |
| Pi direct child-process control | **Nesting works; typing incomplete** | One `Subagent Turn` under the parent; two child generations and one read tool. Shared trace/session, distinct child-session metadata, depth 1. Execution is `SPAN`, not `AGENT`. |
| Pi/Herdr subagent | **FAIL in expected sessions** | Child read the fixture and exited successfully; automatic completion reached the RPC parent. Parent telemetry had the dispatch but no child subtree. No observations were found by the child session ID either, including on a later fetch. |

The successful Pi parent-session fetch contained **8 observations**, the expected Herdr child-session fetch **0**, the direct-process control **8**, and the Claude parent-session fetch **16** across two turn traces. A missing child-session query alone is not enough to diagnose failure: correctly propagated children share the parent's Langfuse session. Both the parent trace and expected child session were inspected.

### Multiline masking reproduction

The published Pi 0.1.2 generic-key pattern is `\b[sp]k-lf-[\w-]+\b`. Its export masking sees JSON-stringified data. A newline before a key becomes the two characters `\\n`; the `n` is a word character, so the leading `\b` fails. The key can consequently survive masking even though a quoted occurrence matches. The local unit case mirrors this pattern and reproduces that mechanism; it does **not** execute the upstream plugin. The actual export/persistence failure was separately observed in the live control run.

The configured-key literal replacement is a separate upstream code path. This test of a different, synthetic key does not demonstrate a bypass for the plugin's own configured secret.

### Herdr boundary

The generated Herdr launch script did not forward `LANGFUSE_PI_PARENT_*`. Unlike a normal subprocess, a daemon-created pane cannot be assumed to inherit dynamic parent-process context. The direct-process control successfully linked the child when that context was inherited.

This establishes a propagation gap, but does **not** fully explain why no child observations were found in either expected session. Plugin loading, credential resolution, shutdown/export, and unexpected session grouping remain separate diagnostic possibilities. Do not present an unverified root cause as fixed.

The first fast Pi route failed with expired provider credentials and did not count as child coverage. The test was repeated successfully with the working `openai-codex/gpt-6.1-sol` runtime and minimal thinking. No account credentials were changed.

## Reproducible offline checks

```bash
npm run test:pull
npm run audit:langfuse -- /private/path/synthetic-evidence.json
```

The second command **does not launch models, query Langfuse, or fix instrumentation**. It audits locally captured evidence. Its bundle schema is:

- `schema: 1`.
- `canaries.pi` and `canaries.claude`: objects with nonempty `langfuse_key`, `provider_key`, `password`, `email`, and `ssn` strings. Supply only synthetic values used by the test.
- `observations.piParent`, `.piChild`, `.piDirect`, `.claude`: arrays of fetched observation objects, including `core,basic,io,metadata,model,usage` fields. Preserve raw backend types/IDs and parent/session metadata. Use all relevant pages and do not truncate captured I/O locally. For inherited grouping, child observations may be in the parent array rather than the child-session array.
- `expected.piHerdrChildSessionId`, `.piDirectChildSessionId`: recorded **child runtime session IDs**; `.claudeChildName`: the exact recorded child observation name.
- `runtimeCompleted.piHerdr`, `.piDirect`, `.claude`: booleans recorded only after real child completion. These are supplied evidence, not independently authenticated by the offline verifier.

The report emits counts/statuses, not raw canary values, I/O, metadata, or parser error excerpts. It checks persisted canaries, missing/ambiguous children, trace/session parentage, child generations/tools, `AGENT` typing, and duplicate dispatch representation. Missing evidence is incomplete, never a successful redaction result. An absent canary means `not_observed`, **not** proven masked; SDK truncation or an unexercised surface can also explain absence.

Exit codes: **1** for a parsed diagnostic report (findings or inconclusive privacy evidence), **2** for invalid invocation/input. This evidence-only tool intentionally cannot certify privacy or give a green release gate. Passing unit tests mean the detector correctly recognizes failures, not that those failures are repaired.

To repeat the live protocol, use private synthetic fixtures; launch one real parent/child run through each actual launcher; record runtime session IDs and completion; fetch all observations for the parent and expected child; then build the local bundle. In addition, use a direct inherited-environment Pi child as a control. Never include real keys in prompts, tool commands, fixtures, or a committed bundle.

## Required remediation and acceptance criteria

1. **Export-time protection:** redact secrets/PII across root/generation/tool inputs, outputs, metadata, multiline and JSON-escaped content, and child-agent data, or adopt metadata-only tracing. Negative cases must persist no synthetic canaries while positive, non-sensitive control data remains observable. A regex reproduction alone is not sufficient acceptance evidence.
2. **Herdr integration:** propagate only non-secret parent trace identifiers across the daemon boundary; ensure each child loads and flushes tracing with credentials resolved privately. Never forward authentication secrets in generated shell scripts or command arguments. Fetch a real child's generations and tools nested in the original parent trace/session.
3. **Agent representation:** use `AGENT` for actual child execution and avoid duplicate dispatch/execution nodes where supported upstream. A generic span with a friendly name does not satisfy this.
4. **Re-run and review:** repeat native privacy/subagent tests after remediation, including failure/abort and shutdown paths. Record independent required PR reviews and synthesis on the final revision before merging any fix.

This PR does not silently patch installed upstream code, add a wrapper/export collector, change trust, or disable other developers' tracing. Such remediation changes need their own reviewed implementation.
