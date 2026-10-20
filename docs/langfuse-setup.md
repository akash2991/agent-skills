# Automatic development-session tracing with Langfuse

**Security warning:** the [live privacy/subagent audit](langfuse-audit-2026-10-20.md) reproduced persisted synthetic secrets/PII in both harnesses and a missing Pi/Herdr child subtree. The shipped setup is not verified safe for sensitive content. This audit follow-up documents and detects the failures; it does not fix them.

The brain can register the official **Pi and Claude Code** plugins together. This traces development sessions, not the consuming application's own AI calls. Ordinary brain imports do not enable telemetry.

## Install into a consuming repository

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --langfuse
```

Requirements:

- Pi and Claude Code on PATH; use a current Claude CLI with project-scope marketplace/plugin commands and JSON listings.
- `uv` on PATH for Claude's Python hook. Alternatively, Python 3.10+ with `langfuse>=4.7,<5` already installed. The upstream hook's uv script manages its own SDK dependencies; the brain does not install Python packages globally.
- A project you have reviewed and chosen to trust in Pi. For a fresh/untrusted repo, first review the installed files and start Pi to make your trust decision, then retry. The installer does not pass approval/bypass flags or change saved trust decisions.

The flag delegates to native package managers:

```bash
pi install --local npm:@langfuse/pi-observability-plugin@0.1.2
claude plugin marketplace add langfuse/Claude-Observability-Plugin#v1.2.1 --scope project --json
claude plugin install langfuse-observability@langfuse-observability --scope project --json
```

The installer verifies Claude's marketplace identity/release and the enabled project's installed plugin version. Existing conflicting marketplace registrations, old versions, or disabling overrides require reconciliation in Claude; they are not silently accepted as success. Pi's npm version and Claude's marketplace release tag are pinned deliberately. Release tags are upstream-controlled refs, not immutable commit pins.

Commit `.pi/settings.json` and `.claude/settings.json`; they contain plugin declarations, **not keys**. Ignore `.pi/npm/` (the native local Pi cache). Claude uses its native per-user plugin caches/install records even for project-scoped plugins. Unrelated settings, hooks, plugin registrations, local overrides, and application files are left to the native managers; the brain never replaces the settings files wholesale. Neither harness's native settings/cache becomes brain-owned replace/prune state. The installer does not register a globally enabled plugin.

Later ordinary pulls preserve these declarations. Repeat `--langfuse` to reconcile setup. `--dry-run --langfuse` describes both registrations without invoking CLIs, configuring credentials, or changing files. CLI/runtime/settings preflight errors occur before brain writes. Native package operations happen **after** the brain pull and are not atomic: a failure can leave the brain and/or Pi registration installed. Errors describe partial success; fix the native setup and retry. Successful registration is not proof of trace delivery.

## Credentials: once per developer, outside Git

The installer never reads `.env`, copies credentials between projects or harnesses, or passes secrets in command arguments.

### Pi

Configure `~/.pi/agent/langfuse.json` (or the configured Pi agent directory), permissions `0600`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://us.cloud.langfuse.com",
  "environment": "development"
}
```

### Claude Code

In a Claude session, run:

```text
/plugin configure langfuse-observability@langfuse-observability
```

Use your existing Langfuse project keys and the correct regional host. Claude's native configuration stores the secret in the OS credential store and non-sensitive options in user settings. Do not paste keys into agent chat or commit them. The native CLI also supports `plugin configure ... --values-stdin` for securely supplying options through stdin; avoid `--config SECRET=...` command arguments, which expose keys in process listings/history.

### Shared environment alternative

Both plugins accept exported `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`. These take precedence over their private/native configuration. Start each harness from the configured shell, or use your secret manager to supply the environment. A project's `.env` alone is **not** automatically loaded by either plugin. Pi's private configuration file is **not** read by Claude.

Once the per-developer credential configuration and project approvals are complete, **start new sessions in each harness**. Both trace automatically in the opted-in repository, without asking agents to invoke a skill. Teammates must configure their own credentials and approve executable project resources.

## Coverage and limits

| Harness | Upstream capture | Important limits |
|---|---|---|
| Pi plugin 0.1.2 | Turns, separate generations, tools, token/cache/reasoning-token usage, available costs, images; session grouping and cwd/Git-branch metadata | Partial generation inputs, not full model context/reasoning text or thinking-level labels. Child Pi roots are spans; propagation requires launchers to preserve parent environment and load the plugin. |
| Claude plugin 1.2.1 | Transcript-based Stop/SessionEnd hooks; turns, generations, token/cache usage/costs, tools, reasoning blocks, skills, subagents, images; session grouping | Depends on Claude's transcript format and hook runtime. In the live test, a synthetic tool-call transcript row produced an extra model-less/no-usage generation alongside two priced generations. Do not equate observation count to billed model requests. |

There is no custom project-prefixed session ID/persona naming convention and no automatic unified cross-harness session. Each plugin uses its own harness's session identity. Other harnesses, Claude Desktop Chat mode, and the application's runtime are not instrumented. Real child-agent propagation has now been tested with mixed results; see the [audit and remediation criteria](langfuse-audit-2026-10-20.md). Reasoning capture, image uploads, and all failure paths remain unverified.

## Privacy and disabling

Both plugins can upload prompts, model outputs, tool arguments/results, and images. Treat this as content telemetry, not just anonymous metrics. Arbitrary secrets and PII are **not** guaranteed to be masked. Do not run secret-reading tools in traced sessions. Review upstream code and your Langfuse access/retention policies before enabling.

Pi, for one run:

```bash
LANGFUSE_TRACING_ENABLED=false pi
```

Claude, disable locally without changing the committed team's project registration:

```bash
claude plugin disable langfuse-observability@langfuse-observability --scope local
```

Do not rely on Pi's kill switch to disable Claude's hook. Re-enable Claude through its native plugin manager when appropriate. To remove project registration:

```bash
pi remove --local npm:@langfuse/pi-observability-plugin
claude plugin uninstall langfuse-observability@langfuse-observability --scope project
```

## Verification

1. Start each harness in a new trusted session with credentials configured. Ask for one safe file read and a short answer.
2. Fetch observations back using the current [Langfuse CLI](https://langfuse.com/docs/api-and-data-platform/features/cli); inspect `api observations list --help` first, then filter by the observed session ID. Allow for ingestion/indexing delay. Never accept a status line or hook success log as proof.
3. Verify root input/output, shared trace/session IDs, generation/tool types and parentage, actual model/usage/cost fields, and expected project attribution. Test child-agent/error paths separately before relying on them.

Live smoke tests on 2026-10-20 verified:

- Pi: one root, two priced generations, and a `read` tool, correctly nested and session-grouped, with project metadata. A separate test verified automatic project discovery and private credentials without exported keys.
- Claude: normal native project-plugin discovery and OS-stored credentials without exported keys; one root, a `Read` tool, two model-specific priced generations and one additional unpriced synthetic generation. All were in the same trace/session, with generations and tool observations as siblings under the root. The two priced observations' costs summed to the CLI's reported cost.
- Native setup in an isolated consuming repository: both project registrations, repeated setup, ordinary updates, unrelated settings/hooks, and real `.env` preservation. Trust was confined to temporary sandbox configuration, never the user's trust store.

Maintainers can run `npm run test:pull` for offline installer/unit regressions and `npm run test:langfuse-native` for the explicit native-manager integration suite. The latter requires both CLIs/runtime and network access to download plugins, but no model calls or Langfuse credentials; all config/trust stores are temporary.

References: [Pi integration](https://langfuse.com/integrations/developer-tools/pi-agent), [Claude plugin](https://github.com/langfuse/Claude-Observability-Plugin), [Claude project plugin commands](https://code.claude.com/docs/en/plugins/cli-reference), [trace best practices](https://langfuse.com/docs/observability/best-practices).
