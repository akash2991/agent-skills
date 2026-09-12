## Report
- From: <agent_id> (engineering-manager, service: <name>)
- To: <pm agent_id>
- Ticket: <feature or milestone id>
- Status: DONE | PARTIAL | BLOCKED
- Model / effort: <model> / <effort>
- Budget: spent <in>/<out> of allocated <in>/<out> tokens (<n>% / <n>%), cost <x or UNKNOWN>; source: <observatory | runtime | UNKNOWN>

### Milestone
- Name: <milestone>
- Goal: <one sentence>
- Usable outcome after this milestone: <what a user can do>

### Design
- HLD/LLD: `<paths>`
- Authored by: <PE agent_id>
- Approved by: <second PE agent_id> on <date>

### Tasks
| Ticket | Goal | Engineer | Tier / model / effort | Status | Review | Engineer verified | QA |
|---|---|---|---|---|---|---|

### Verification of the integrated milestone
- `<command>` → <result>
- Manual check: <what was exercised>

### Sprint
- Sprint <n>: capacity <points> · planned <points> · delivered <points> · spilled over <points> (<tickets and reasons>) · estimation error <tickets: estimated/actual/cause> · unplanned <points>
- Open bugs: <count by severity, tracker query>

### Budget
- Team allocation: <in>/<out> tokens · spent <in>/<out> (<n>% / <n>%) · per agent: <agent_id: spent/alloc, status>
- Budget asks raised or received this sprint: <B-ids and decisions>
- Allocated: <amount> · Spent: <amount or UNKNOWN> · Remaining: <amount or UNKNOWN>
- Routing changes made because of budget: <none or list>

### Agent observability
- Runtime/registry reconciliation: <checked at time, drift or none>
- Usage: <agent — turns — tools/failures — skill/doc context — model tokens — elapsed — cost; each measured/estimated/unknown>
- Context or loop risks: <agent and next action, or none>

### Blockers
- <ticket> — type: <blocker type> — dependency: <x> — requirement: <y> — owner: <agent_id> — next action: <action>

### Escalations to PM
- <Escalation block, or "none">

### Next milestone
- <name and goal>
