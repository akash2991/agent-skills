# Work log

One row per agent run, appended by the agent itself when it finishes. Newest at the top.

Its job is to make the work visible after the fact: what was run, on which model, how long it took, and what it cost. Without it, those questions can only be answered from memory, and memory of an agent session is not evidence.

**Append your row before you hand back.** A run that is not logged did not happen, as far as any later question is concerned.

## What a row must contain

| Field | Where it comes from | If you cannot get it |
|---|---|---|
| Date and time | when you finished | never unknown |
| Role | the persona you played | never unknown |
| Command | the `/brain-*` you were invoked with | never unknown |
| Ticket | what you worked on, or `-` | `-` |
| Model | the model actually running, not the one requested | ask, do not guess |
| Effort | the thinking effort actually running | `UNKNOWN` |
| Skills used | the skills you actually loaded, comma separated; `none` is a real answer worth recording | never unknown |
| Input tokens | `node .agent-brain/control-plane/brain.js status`, which reads what the harness reported | `UNKNOWN`, never zero |
| Output tokens | same | `UNKNOWN`, never zero |
| Duration | wall clock from your first action to your last | round to the minute |
| Outcome | `done`, `blocked`, `refused`, or `partial` | never unknown |
| Friction | what fought you, in a few words, or `-` | `-` |

A missing number is `UNKNOWN`. It is never zero, and never a guess dressed as a measurement. Tokens are only available where the harness reports them; on the ones that do not, `UNKNOWN` is the honest and expected answer.

## Log

| When | Role | Command | Ticket | Model | Effort | Skills used | In | Out | Duration | Outcome | Friction |
|---|---|---|---|---|---|---|---:|---:|---:|---|---|
| 2026-09-15 | Claude Code session, no persona | direct (no `/brain-*`): install lavish-axi skill and inject into slop, then reverted on the owner's instruction | - | claude-opus-5[1m] | UNKNOWN | none | UNKNOWN | UNKNOWN | UNKNOWN | done | Owner reverted the skill after asking first to exempt it from the anatomy. VERIFIED NOW: `skills/lavish`, its eval case, the manifest entry, the skill-lint exemption, its changelog line, and its override row are gone; validate OK, skill lint and its unit test pass, evals pass at rank-1 89%, inject tests 9/9; slop re-injected for claude-code and codex with lavish retired from both skill folders, no mention in its AGENTS.md, Linear OAuth key intact. Kept in slop from the same inject: the firstmate removals, the `.agents/skills` refresh for pi, the stale `quota-axi` and empty `.claude/agents` cleanup. Friction: the imported skill's nested frontmatter was flattened by the brain parser; adding it pushed a TDD eval prompt to rank 4; midway, this repo's HEAD was moved by someone else to a `temp` branch reset to upstream 469d00f with the brain commits unstaged, so nothing was committed and git was not touched. |
| 2026-09-15 | Claude Code session, no persona | direct (no `/brain-*`): owner reported pi needed `"auth": "oauth"` for Linear | - | claude-opus-5[1m] | UNKNOWN | none | UNKNOWN | UNKNOWN | UNKNOWN | done | VERIFIED NOW: pi-mcp-adapter reads project `.mcp.json` and accepts `auth` oauth/bearer; Claude Code still reports slop's Linear server connected with the key; build now emits it into `.mcp.json` only; validate OK, both builds, inject tests 9/9, reference links pass. Friction: the build's per-tool server shape silently dropped unknown keys, and injection replaces a server entry by name, so a hand fix in a project would be lost on re-inject. Not committed. |
| 2026-09-14 21:15 IST | Claude Code session, no persona | direct (no `/brain-*`): delete what firstmate covers | - | claude-opus-5[1m] (switched from claude-fable-5-1 mid-session) | UNKNOWN | none | UNKNOWN | UNKNOWN | UNKNOWN | done | VERIFIED NOW: validate OK; product and self builds; CI leak check; control-plane tests 20/20; inject tests 8/8; skill anatomy, reference links, artifact paths, other unit tests pass; evals 202 checks, rank-1 89%; scratch inject has no `.claude/agents`, `event` and `status` work, `context` exits 2 pointing at firstmate; bootstrap retired 18 files. Friction: the repo convention archives rather than deletes, so removed files went to `deprecated/removed-for-firstmate/`; CI's smoke step was already calling a `budget` command that no longer existed; removing the quota negative left the langfuse eval below its minimum until a replacement was added; inject retires files but leaves an emptied directory behind. Not committed. |
| <YYYY-MM-DD HH:MM> | <role> | <`/brain-*`> | <id or -> | <model> | <effort> | <skills or none> | <n or UNKNOWN> | <n or UNKNOWN> | <n min> | <outcome> | <what fought you or -> |
