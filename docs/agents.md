# Agent Personas

Each persona is a short Markdown file in `agents/`, consumed as a system prompt by your harness and, on Claude Code, discoverable as a subagent. The main agent adopts one and starts subagents with the others; `AGENTS.md` has the rules, [persona-anatomy.md](persona-anatomy.md) the file format.

| Persona | Best for |
|---|---|
| [product-manager](../agents/product-manager.md) | Ticket, refine, interview, phased PRD with success targets |
| [backend-engineer](../agents/backend-engineer.md) | APIs, domain logic, persistence, plan, HLD/LLD, build, deploy |
| [web-engineer](../agents/web-engineer.md) | React screens, state, typed clients, browser verification |
| [mobile-engineer](../agents/mobile-engineer.md) | React Native screens, pluggable platform modules, device verification |
| [scout](../agents/scout.md) | Read-only investigation of a service, a bug's surroundings, a convention gap |
| [code-reviewer](../agents/code-reviewer.md) | Five-axis review plus the PR review guidelines |
| [test-engineer](../agents/test-engineer.md) | Independent verification, end to end and under concurrency, Prove-It tests |
| [security-auditor](../agents/security-auditor.md) | STRIDE, OWASP audit of security-sensitive surfaces |
| [web-performance-auditor](../agents/web-performance-auditor.md) | Measured Core Web Vitals and loading audit |

A persona is the *who*: a role, high-level guidelines, and what it never does. The *how* comes from the skills it lists; inputs, outputs, and way of working depend on the work and the skills pulled for it. Developers never review and reviewers never fix.

## Claude Code interop

Install the personas with `agent-brain pull`, then use the Agent tool with the persona name. The installer writes `.claude/agents/` with Claude tool names in place of the labels in `tools:`; a persona copied unchanged from `agents/` is refused by Claude Code, because none of its labels is a Claude tool ([harness layout](harness-layout.md#persona-tools-labels-in-the-source-native-names-in-harness-copies)).

## Adding a persona

1. `agents/<name>.md` per [persona-anatomy.md](persona-anatomy.md).
2. Add it to `manifest.json` and to the table in `project/AGENTS.md` and here.
3. `node scripts/validate-agents.js`.
