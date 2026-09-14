---
name: quota-axi
description: Reads local LLM subscription quota across providers with the quota-axi CLI, reporting percent remaining, reset times, burn pace, usable runway, and a comparative spend priority per provider scope, so the choice of model or harness uses real provider figures instead of guesses. Use when choosing a model or harness for a task, when a provider may be near its limit, when a run fails in a way that looks like a quota wall, or when reporting token and cost status.
category: tools
---

# quota-axi

## Overview

[quota-axi](https://github.com/kunchenguid/quota-axi) (MIT) reports what each provider says is left on your plan: percent remaining per window, when it resets, whether you are burning faster than the reset clock, how much usable runway is left, and a comparative `spendPriority` across scopes. It reads local credential stores and calls first-party provider endpoints, so nothing goes through a third party.

It answers what the *provider* will actually serve, which nothing local can infer. A run can look perfectly healthy and still fail because the weekly window is spent.

It reports figures and never routes. The routing decision stays with the engineering manager (the model and effort the coordinator chose).

## When to Use

- Before routing a task to a model or harness, to see which provider has room.
- When a run fails, stalls, or degrades in a way that looks like a rate or quota wall.
- When reporting token, cost, or usage status (`delivery-status`).
- Before a long or expensive milestone, to check runway against the reset clock.
- NOT for what an agent has already spent: that is the control plane's recorded usage.
- NOT for authorization: a healthy quota is not permission to start work the coordinator has not asked for.

## Process

1. **Read the current picture.** Either through the control plane, which normalizes it and adds a routing preference, or directly:

```bash
node {{ORG_DIR}}/control-plane/brain.js quota                 # normalized rows plus a preference order
node {{ORG_DIR}}/control-plane/brain.js quota --provider claude,codex
npx -y quota-axi --json                                       # raw, schemaVersion 5
npx -y quota-axi --tui                                        # live human dashboard
npx -y quota-axi models --sort runway                          # model buckets joined with quota evidence
npx -y quota-axi auth                                          # which credential sources are usable, no values
```

Install it once (`npm i -g quota-axi`, Node 22.19+) to avoid an `npx` fetch on every call. Providers covered: Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, Alibaba, OpenCode, Antigravity.

2. **Read the fields that matter for a decision.** Per provider scope: `effectivePercentRemaining`, `pace` (whether burn is ahead of or behind the reset clock), `runway` (`through_reset`, `projected_exhaustion`, `exhausted_now`, or `unknown`), and `selection.spendPriority`, a comparative signal clamped to [-100, +100] where higher means spending here forfeits less.

3. **Use it in the routing decision, do not let it make the decision.** Prefer a scope that is healthy and has a high spend priority. A scope at `exhausted_now` or `projected_exhaustion` before the task could finish is a reason to route to another provider's model, not a reason to stall or to silently downgrade a critical task.

4. **Handle every non-nominal state explicitly.** A provider can report `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error`, each with a `remedyCommand`. Run the remedy or report the state; never treat an unreadable provider as healthy.

5. **Record what you used.** Put the figures and their source in the ticket or report. Quota is a measurement with a time window, so it is `VERIFIED NOW` only when just read, and `HISTORICAL` afterwards.

## Interpreting the signals

| Situation | What it means | What to do |
|---|---|---|
| High percent remaining, pace behind the clock | Room to spend, and you are under-using the window | Route the expensive work here |
| Moderate percent, pace ahead of the clock | You will hit the wall before it resets | Route new work elsewhere or reduce effort on non-critical tasks |
| `runway: projected_exhaustion` inside the task's horizon | The task will not finish on this provider | Route to another provider, or split the task |
| Negative `spendPriority` | Spending here forfeits more than spending elsewhere | Prefer another scope |
| `auth_required` or `expired_refreshable` | Credentials need attention | Run the `remedyCommand`, or report a `missing access` blocker |
| `status: unknown` on every scope | No usable local evidence | Report quota `UNKNOWN`; do not assume room |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Quota looks fine, so this will work." | Quota is a burn-down against a reset clock. A figure is current only when just read, and `HISTORICAL` a minute later. |
| "No quota data, so assume it is fine." | Unknown is not healthy. Report `UNKNOWN` and decide with that stated. |
| "quota-axi picked the provider." | It publishes figures and one comparative signal. The EM routes; the tool does not. |
| "The percentage I read an hour ago still holds." | It is a burn-down against a reset clock. Re-read it before a decision that depends on it. |
| "It says 12% left, that is enough for this T3 task." | Check `runway` against the size of the task, not just the percentage. |

## Red Flags

- A routing decision that names no quota evidence when a provider was known to be near a limit.
- A provider in `auth_required` or `error` reported as healthy, or its `remedyCommand` ignored.
- A quota figure quoted in a report with no read time.
- A critical task downgraded because of quota without an escalation.
- A run that stalled on a quota wall the tool would have shown before it started.

## Verification

- [ ] The figures quoted in the decision or report name their read time and provider state.
- [ ] Every non-nominal provider state is either remedied or reported, never presented as healthy.
- [ ] The routing choice is consistent with the runway for the task's horizon, not just percent remaining.
- [ ] Missing evidence is recorded as `UNKNOWN` rather than assumed.
