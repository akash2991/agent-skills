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
| <YYYY-MM-DD HH:MM> | <role> | <`/brain-*`> | <id or -> | <model> | <effort> | <skills or none> | <n or UNKNOWN> | <n or UNKNOWN> | <n min> | <outcome> | <what fought you or -> |
