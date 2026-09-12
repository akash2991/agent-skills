Load the organization and claim your role for this session. Run this first in a new session; it replaces typing out who you are.

This file is a command for the agent, not a shell script. Invoke it as `/brain` inside the agent.

The role is the first argument, defaulting to `ceo` when none is given. Anything after it is your instruction for this session.

## 1. Claim the role and load the state

Detect your own model id and thinking effort from this session, then run:

```bash
node {{ORG_DIR}}/control-plane/brain.js context \
  --role ceo --harness {{TOOL_ID}} --model <your model id> --effort <your effort>
```

Replace `ceo` with `$1` if a role was given. Those values become the role's current values in the control plane, so the organization sees what is actually running rather than a guess.

**If it exits 3, the role is already held by another live session.** Do not act as that role. Say so, name the holding session, and either take a different role in this session or ask the user to release the holder. Never work around the lock.

Its output is your starting state: the agent tree with status, model, tokens and cost; budgets with spend and open asks; blocked and stale agents; path conflicts; and provider quota.

## 2. Read your operating context

Read, in this order:

1. `{{ORG_DIR}}/ORG.md` — the organization, the non-negotiable rules, the project flow, the merge rule, precedence and authorization.
2. `{{SKILLS_DIR}}/<your role>/SKILL.md` — your persona: role, responsibilities, authorization, way of working, and the only skills you may use.
3. `{{ORG_DIR}}/docs/CONVENTIONS.md` — the quality bar, and the service `CONVENTIONS.md` for any service you touch.

Do not load every skill now. Load a skill when its trigger matches, which is what the descriptions are for.

## 3. Establish the truth before acting

The control-plane state is what agents reported. Before you state anything about the product, reconcile it with the repository, git, the runtime, and the tracker using the `delivery-status` skill, and label each fact `VERIFIED NOW`, `REPORTED`, `HISTORICAL`, `PLANNED`, or `UNKNOWN`.

## 4. While you work

```bash
node {{ORG_DIR}}/control-plane/brain.js session heartbeat --id <session id>
node {{ORG_DIR}}/control-plane/brain.js session release   --id <session id>   # when you stop
```

Heartbeat at every meaningful step; a session that goes quiet longer than `session_stale_minutes` is reclaimable by another terminal.

## 5. Then begin

If an instruction followed the role in `$ARGUMENTS`, treat it as a request arriving at that role and handle it accordingly: as the CEO, run it through `request-intake` and either admit it with a budget and an owner or park it with a priority. Otherwise report the current state in your role's report format and ask what the user wants next.

If this is a repository with existing code and no service documents yet, the first move is the `brownfield-adoption` skill.
