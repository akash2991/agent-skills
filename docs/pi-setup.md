# pi Setup

[pi](https://github.com/badlogic/pi-mono) reads `AGENTS.md` from the project root, skills from `.agents/skills/` (already installed with the brain; also `~/.agents/skills/`), and prompt templates from `.pi/prompts/` (or `~/.pi/agent/prompts/`). A prompt template is a Markdown file whose name is the slash command; `$@` is replaced by the arguments. Do not copy skills into `.pi/skills/`.

## Install into a project

Run from the consuming project's root:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull
```

This installs the complete brain, including full personas in `.pi/agents/`, full skills in `.agents/skills/`, and commands in `.pi/prompts/`. Rerun to update, or add `--dry-run` to preview. See [Pull installation](pull-install.md) for prerequisites, pinning, and update behavior.

Review the installed resources before granting project trust. Start a new pi session or run `/reload` after updating skills and prompts. Then in the project:

```
/brain backend-engineer fix the login timeout
/brain-status
```

## Automatic Langfuse tracing

Opt in when importing the brain into each consuming repository:

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull --langfuse
```

Requires Pi on PATH and a project you have chosen to trust in Pi. The installer does not bypass trust: for a fresh/untrusted repository, review the installed brain, start Pi to make your trust decision, then rerun `pull --langfuse` (or the native install command below). This delegates to `pi install --local npm:@langfuse/pi-observability-plugin@0.1.2`, the official Langfuse integration. It preserves unrelated Pi settings and installs dependencies using Pi's native package manager. Commit `.pi/settings.json`; ignore `.pi/npm/` (local package cache). No custom extension, copied SDK, or tracing instructions are needed. Later ordinary pulls leave registration intact; repeat `--langfuse` to reconcile the pinned plugin. `--dry-run --langfuse` does not invoke Pi or install anything. Without the flag, pull never configures telemetry.

Configure credentials **once per developer**, outside the repository, in `~/.pi/agent/langfuse.json` (or the configured Pi agent directory). Keep permissions at `0600`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development"
}
```

Use the host matching your project region. Alternatively export `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` before starting Pi; environment values override the private config. A project's `.env` is **not automatically loaded by the plugin**. Do not copy credentials into `.pi/settings.json`, committed files, or other consuming repositories. The installer never reads `.env` or provisions credentials.

Review the plugin and project configuration before granting trust, then start a **new Pi session**. Tracing is automatic for each prompt: root turn, separate model generations, tool calls/results, token/cache/reasoning-token usage and available costs, grouped by Pi session ID. Root metadata includes the working directory and Git branch for project attribution. This is not a custom project-prefixed session ID or persona-name convention. Child Pi processes inherit parent trace context when their launcher preserves the environment and loads the plugin; other harnesses and opaque child runtimes are not covered.

**Privacy:** the plugin uploads prompts, model outputs, tool inputs/results, and images. It masks Langfuse keys, not arbitrary secrets or personal information. Do not run secret-reading tools in traced sessions. Disable before startup for sensitive work:

```bash
LANGFUSE_TRACING_ENABLED=false pi
```

To remove project registration:

```bash
pi remove --local npm:@langfuse/pi-observability-plugin
```

The plugin is experimental and pinned deliberately. Version 0.1.2 records partial generation inputs rather than the complete model context, omits reasoning text and thinking-level labels, and represents child roots as spans rather than typed agents. Do not interpret traces as full prompt replay or a complete agent graph. Trace submission is best effort; registration/status text alone does not verify ingestion.

### Verification

1. Start a new session with credentials configured; request one safe file read and a short answer.
2. Fetch the resulting observations using the current [Langfuse CLI](https://langfuse.com/docs/api-and-data-platform/features/cli), first inspecting `api observations list --help`.
3. Verify a shared trace/session ID, one root with meaningful input/output, one generation per model call, tool observations as siblings of generations, model/usage/cost fields, and expected project metadata. Check failures and subagent propagation separately before relying on them.

A live smoke test in this source repository on 2026-10-20 returned one root, two generations, and a `read` tool, with correct nesting, session grouping, model, nonzero usage and costs, and working-directory/Git-branch metadata. It did **not** test real child-process propagation or all failure paths. See the [official integration](https://langfuse.com/integrations/developer-tools/pi-agent) and [trace best practices](https://langfuse.com/docs/observability/best-practices).

## MCP

pi's MCP adapter reads the project `.mcp.json`; Linear needs `"auth": "oauth"` there. See [references/tool-auth.md](../references/tool-auth.md).
