# Cross-Harness Delegation

Any agent may invoke an agent in a different harness. A Claude engineering manager can hand a ticket to a Codex staff engineer; an OpenCode agent can ask a Claude reviewer for a verdict. Nothing in the organization is tied to one vendor, because the parts that carry identity are files in the repository, not features of a harness:

- the **persona** is a markdown file, passed to the child as its system prompt or prepended to its first message;
- the **assignment packet** is text, passed as the child's prompt;
- the **control plane** is `{{ORG_DIR}}/control-plane/brain.db`, so a child in any harness registers into the same agent tree, draws on the same budget chain, and reports into the same audit trail.

The child is a specialist doing one task, then exiting. It is not a second CEO: the CEO lock is enforced in the control plane regardless of which harness tries to claim it.

## The invocation contract

Whoever spawns a child (see the spawn mode in `{{ORG_DIR}}/ORG.md`) does four things, in order:

1. **Choose the model and effort** for the task with the `model-routing` skill, from complexity, the remaining allocation, and provider quota. Nothing about the persona fixes this.
2. **Allocate budget** for the child if it does not already fall under a budgeted ancestor (`budget-management`).
3. **Invoke the harness headlessly** with the persona, the assignment packet, and the registration instruction below.
4. **Verify the child's report** against the control plane and the repository rather than trusting the text it returned.

Every child prompt ends with this, so the tree stays whole across harnesses:

```text
Before you touch anything, register in the control plane:
  node {{ORG_DIR}}/control-plane/brain.js agent register \
    --agent-id <agent id> --role <persona> --parent <spawning agent id> \
    --ticket <ticket> --model <model> --effort <effort> --harness <harness> \
    --paths "<owned paths>" --actor <spawning agent id>
Heartbeat with `agent heartbeat` at each step, and close with `agent close` and your report.
If registration reports no budget allocation, stop and say so instead of starting.
```

## Verified invocations

Flags below were checked against the installed CLIs. Confirm with `--help` after a version bump; harness flags move.

### Claude Code

```bash
claude -p "<assignment packet>" \
  --model <model id> \
  --append-system-prompt "$(cat {{SKILLS_DIR}}/<persona>/SKILL.md)"
```

`-p` is headless print mode. `--append-system-prompt` adds the persona on top of the default system prompt; `--append-system-prompt-file` takes a path instead. Add `--add-dir` for extra working directories and `--output-format stream-json` when the caller wants to parse progress.

### Codex

```bash
codex exec "<persona body>

<assignment packet>" \
  -m <model id> \
  -c model_reasoning_effort="<low|medium|high>" \
  -C <repo path> \
  -s workspace-write
```

`codex exec` is the non-interactive form. Codex has no separate system-prompt flag, so the persona goes at the top of the prompt. Reasoning effort is a config override (`-c`), not a flag. `-s` sets the sandbox.

### OpenCode (Kimi, GLM, Groq, and the rest of its catalog)

```bash
opencode run "<persona body>

<assignment packet>" \
  -m <provider>/<model> \
  --variant <high|max|minimal>
```

`-m` takes `provider/model`, which is how a Kimi, GLM, or Groq model is selected. `--variant` is OpenCode's provider-specific reasoning effort. `--agent <name>` picks one of its own agent definitions, which the build already writes to `.opencode/agent/`, so `--agent backend-staff-engineer` can replace pasting the persona body.

### Gemini CLI, Cursor, Copilot CLI

Not installed here, so these are the documented shapes rather than verified ones. Check `--help` before relying on them.

```bash
gemini -p "<prompt>" -m <model>          # headless prompt
cursor-agent -p "<prompt>"               # headless print mode
copilot -p "<prompt>"                    # headless prompt
```

## Choosing a harness

The model decides the harness, not the reverse: pick the model and effort for the task, then use whichever harness can run that model. Provider quota is part of the decision, and `brain.js quota` reports it per provider with a comparative spend priority, so a provider that is nearly out of its weekly window is a reason to route the task to a model on another provider rather than to stall.

Prefer the harness the work already lives in when the models are equivalent: a child in the same harness shares tool configuration, MCP servers, and the repository's permission setup, so fewer things need to be re-established.

## Rules

- **The child registers before acting**, with `--parent` set to the spawning agent, or the hierarchy and the budget roll-up are both wrong.
- **One task per child.** A cross-harness child is a specialist finishing one ticket, not a long-lived session.
- **Credentials stay local.** Never pass a token in a prompt or an argument. Each harness authenticates from its own credential store (`{{ORG_DIR}}/references/tool-auth.md`).
- **Never pass secrets, credentials, or repository content in the prompt** beyond what the assignment names. The child can read the repository itself.
- **The child cannot claim an exclusive role.** The CEO lock is in the database, so a Codex child asked to be the CEO is refused the same as a second Claude session.
- **Report back through the control plane and the tracker**, not only through stdout. A child whose process is killed must still have left its registration, heartbeats, and status behind.
- **Verify, do not trust.** The spawner re-runs the verification commands; a report is a claim.

## Red flags

- A child that ran without registering, so it appears nowhere in the tree and its tokens are attributed to nobody.
- A cross-harness call whose prompt contains a credential, a secret, or a pasted file that the child could have read.
- A child spawned with a model chosen because it was the harness default rather than because the EM routed it.
- Two harnesses editing the same owned path because the second child never registered its paths.
- A long-running interactive session spawned where a single headless task was needed.
