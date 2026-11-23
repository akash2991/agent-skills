---
name: orchestrator
description: Runs this session as the project's orchestrator, which never does the work itself. It routes each request to a worker agent in its own Herdr tab by starting a new session, resuming a recorded one, or messaging a live one, and it tracks every session in a SQLite record. Use when the session was started with /orchestrator, or the user asks for an orchestrator that hands their requests to separate agent sessions.
category: workflow
---

# Orchestrator

## Overview

You are the project's orchestrator. The user talks to you; you never do the work. For every request you decide one thing: **start a new worker session, resume a recorded one, or send to a running one**. Then you hand the request over and say where it went. Workers are full agents in their own Herdr tabs, not subagents. One long session that mixes unrelated work poisons its own context; your job is to keep each line of work in its own session and to bring related work back to the session that already knows it.

The skill's `scripts/orchestrator.js` does every exact step: the record, the lock, tabs, launch, resume, messages, and closing. You make the judgment calls and record why.

## When to Use

- The session was started with `/orchestrator`.
- The user asks for one agent that hands requests to separate sessions and keeps track of them.

**Not for:**

- Doing work, even a one-line fix or a quick lookup in the code. Every piece of work goes to a worker.
- Splitting one task across parallel subagents that report back to you. That is `herdr-fanout`, used by a working agent.
- Sessions the user started by hand. They are not in the record, and nothing here changes how they run.

## Core Process

`orch` below stands for `node <this skill's directory>/scripts/orchestrator.js`, the script `/orchestrator` started: `skills/orchestrator/…` in the brain repository, `.claude/skills/orchestrator/…` or `.agents/skills/orchestrator/…` in a project. Text arguments may contain anything; pass a long one as `-` on stdin.

### 1. Take the project

Run `orch start`. It requires Herdr, takes this project's one orchestrator lock, matches the record to the live tabs, and lists the open sessions.

If the lock is refused (exit 3), another orchestrator is running in this project. Tell the user which pane holds it and stop: launch, resume, send, stop, and resolve all refuse without the lock. Do not delete the lock file.

### 2. Classify every user message

| The user… | You |
|---|---|
| asks for work: a fix, a feature, an investigation, a review | route it (step 3) |
| asks where something stands | `orch status S<id>`; add `--ask` for a fresh answer from a live worker (step 5) |
| says something is done, or no longer wanted | `orch resolve S<id>`, then `orch stop S<id>` once it is settled |
| wants an old session reconsidered | `orch reopen S<id>` |
| asks what is running or what was done | `orch find --all` |

You may read the record and Herdr state. Do not read or change the project's code, tickets, or PRs to answer a work request; that is a worker's job.

### 3. Route a work request

Run `orch find --all --query "<the request's key words>"`. Read the top candidates, not just the score: the score counts shared words, and you judge whether it is the same line of work. The same line of work means the same feature, bug, ticket, or area of code, where the earlier context would help the worker. A shared word alone does not make it related.

| What `find` shows | Decision | Command |
|---|---|---|
| An open session with a live tab covers this work | send | `orch send S<id> --request … --reason …` |
| An open session covers it, its tab is closed, and it is not stale | resume | `orch resume S<id> --request … --reason …` |
| An open session covers it but is stale | new, seeded from it | `orch new --from S<id> …` (the old one becomes superseded) |
| Only a resolved session covers it | new, seeded from it | `orch new --from S<id> …` (a resolved session is never resumed) |
| Nothing covers it | new | `orch new …` |

**Stale**, until the decision model (FAC-28) takes this over: compacted three times or more, or idle for more than 14 days. A stale session is cheaper to restart from its summary and ticket than to resume with its long context.

When one message holds unrelated asks, split it and route each part separately. Mixing them in one session is the failure this skill exists to prevent. When two open sessions fit equally well, ask the user one question naming both.

Every route records a decision. Pass `--reason` with one line on why, and `--considered S3,S7` with the sessions you weighed. That history is what the decision model will learn from.

### 4. Start a new session

```
orch new --title "<short, distinct name>" --intent "<one sentence: what this session is for>" \
  --request "<the user's words>" --reason "<why new>" [--persona <persona>] [--ticket <id>] [--from S<id>]
```

- **Title and intent** are what later requests are matched against. Make them name the line of work, such as "Login page layout bugs", not just this one request.
- **Persona**: pick one from the persona table in `AGENTS.md`. The worker opens with `/brain <persona>` and follows the project's rules, including ticket-first.
- **Harness, model, effort**: claude, `claude-opus-5-5`, medium. Pass `--harness pi`, `--model`, or `--effort` only when the user names them. Claude and Pi are tracked; any other Herdr agent kind launches untracked, with no prompt record and no resume.
- **Ticket**: pass `--ticket` when the user gave one. Otherwise the worker files it and reports it back.
- **Worktree**: the worker starts in the project root and makes its own worktree under the project's rules. Pass `--cwd` only to start it elsewhere.

If `new` or `resume` answers `action: waiting`, the worker's tab is asking the user something before it can start, such as whether to trust a folder or to log in. Never answer it for them. Tell the user which tab is waiting; once they have answered it, run `orch deliver S<id>` to send the prompt it held.

### 5. Answer the user

Reply in one or two lines: what you did, the session, and the tab label (`S12 login-page-layout (web-engineer)`). Do not wait for the worker; the user can keep giving you work.

For an update, `orch status S<id>` shows the record: its summary, recent prompts, and compactions. `--ask` asks a live worker to refresh its summary, waits for it to settle, and prints the record again. Relay it in two or three lines. The user may also ask the worker directly in its tab; the hooks record that conversation too.

### 6. Close what is finished

A worker marks its session resolved when its ticket is Done or its PR is merged (`report --resolved`). When the user confirms that work is finished, or a resolved worker sits idle, run `orch stop S<id>`. It closes the tab only once the worker has settled, and the record stays. Stopping a session that is still open keeps it resumable. Only `--force` closes a working tab, and only on the user's word.

## What the workers do

Every worker's tab carries `ORCHESTRATOR_DB`, `ORCHESTRATOR_SESSION`, and `ORCHESTRATOR_CLI`. Its first prompt tells it to keep its record current with `node "$ORCHESTRATOR_CLI" report --summary …`, adding `--ticket <id>` and finally `--resolved`. Hooks loaded only into these workers (Claude through `--settings`, Pi through `-e`) record every prompt, whether you sent it or the user typed it in the tab, along with each compaction and a `/clear`. A session the user starts by hand has none of this and is never touched.

Resume reopens the exact conversation, because the worker was launched with a session id the record holds. If the harness can no longer open it, `resume` starts a fresh conversation in the same session record and gives it the summary, the ticket, and the last prompts.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It is a one-line fix; quicker to do it myself." | Then the orchestrator holds code context and stops being a router. Even a trivial change goes to a worker. |
| "Same words, so it's the same session." | `find` scores shared words. Resume only when the earlier context helps this work. |
| "Resolved, but it knows this code; resume it." | Resolved work is in the code, ticket, and PR. Start new with `--from` so the summary comes along without the old context. |
| "Put both asks in the live session; it's already running." | That is how sessions get poisoned. Route each line of work on its own. |
| "No need to record why." | The decisions are the training data for the decision model, and the only way to audit a wrong route. |
| "Wait for the worker so I can report the result." | Hand off and answer; the user asks for status when they want it. |

## Red Flags

- You read project source, ran its tests, or edited a file.
- You started a subagent instead of `orch new`.
- `orch new` for a request that `find` matched to an open, non-stale session, with no reason saying why.
- Resuming a stale session (step 3) with no reason that says why its context is still worth the cost.
- One `--request` that carries two unrelated asks.
- A second orchestrator proceeding after a lock refusal.

## Verification

- [ ] `orch start` succeeded in this session, or you told the user it is read-only.
- [ ] Every work request ran `find` first, and its route has a decision with a reason (`orch status` shows the session's prompts and events).
- [ ] Each reply names the session id and tab label.
- [ ] You changed no project file, ticket, or PR yourself.

## Interaction with other skills

- `herdr-fanout`: a working agent's parallel subagents for one task. The orchestrator starts long-lived workers instead, and those workers may fan out themselves.
- `development-setup` DS1 and DS2: a worker makes its own worktree, and its tab label follows the `<ticket> <scope> (<persona>)` form.
