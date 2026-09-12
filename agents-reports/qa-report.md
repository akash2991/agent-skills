## Report
- From: <agent_id> (test-engineer)
- To: <em agent_id>
- Ticket: <tracker id>
- Status: DONE
- Model / effort: <model> / <effort>
- Budget: spent <in>/<out> of allocated <in>/<out> tokens (<n>% / <n>%), cost <x or UNKNOWN>; source: <observatory | runtime | UNKNOWN>

### Verdict
QA VERIFIED | QA FAILED | QA BLOCKED

### Baseline
- Commit / runtime: <sha or environment>
- Engineer report reviewed: <link>

### Acceptance evidence
- <criterion> → `<command>` or <runtime observation> → <result>

### Regression coverage added
- `<test path>` — <what it locks>

### Integration and stub check
- Crosses boundaries: yes | no → <what was exercised>
- Mock-backed parts reported as such: yes | no

### Defects
- <ticket or D-n> — steps: <exact steps> — expected: <x> — actual: <y> — evidence: <link/output>

### Blockers and next action
- <Escalation block from the `escalation` skill, or "none">

### User verification
- Flow the user can try: <steps>
