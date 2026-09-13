# Assignment Packet

Every delegation from one persona to another is a packet with the fields below, posted on the ticket and passed in the invocation prompt. A vague instruction such as "build authentication" is not an assignment. The EM uses this for staff engineers; the CEO uses it for PMs and PEs; the PM uses it for EMs.

```markdown
## Assignment: <ticket> — <title>
- Role / persona: <backend-staff-engineer | web-staff-engineer | ...>
- One achievable goal: <one sentence, observable>
- Story: <link and full text>
- Acceptance criteria:
  - [ ] <testable>
- Dependencies and verified baseline: <merged tickets, commit>
- Read first: <exact PRD, HLD, LLD sections; service CONVENTIONS.md>
- Owned paths (touch nothing else; file an interface request instead):
  - <path>
- Interfaces consumed: <contracts and their owners>
- Interfaces provided: <contracts this task lands>
- Stack and typing constraints: <from global and service CONVENTIONS.md>
- Testing requirements: <unit, contract, end-to-end; fakes available>
- Instrumentation: <technical metrics from the LLD; product and business metrics from the PRD; log points>
- Verification commands: `<command>`
- MVP / scope constraints: <explicitly out of scope for this task>
- Routing (decided by the EM): tier, `model/effort` pair from the persona's allowed list, review path
- Budget for this task: <input>/<output> tokens (cost <x or UNKNOWN>), ledger row `<holder>` granted by <em agent_id>
- Spawned by: <EM | CEO session | this session> per the harness's spawn mode
- Observatory identity: agent_id, parent_agent_id, session_id, runtime, runtime_ref, runtime_session (use UNKNOWN where the host cannot expose a value)
- Agent-work telemetry: emit lifecycle, loaded skill/document, turn, model-usage, and tool-completion events per `references/agent-observability.md`; metadata only
- Escalation target: <persona one level up>
- Required report: <template path>
- Delivery: pull request per `references/pull-request.md`; review by <discipline>-code-reviewer | author-merge if small
```

Example of a good goal line: "Implement ENG-12: expose `POST /auth/request-otp` per the agreed contract, returning deterministic development behavior where the milestone plan says so, with tests for every acceptance criterion, touching only `backend/auth/**`, verified by `make test-auth`, committed on the ticket branch."

Reject an assignment that cannot be unambiguously called done, has no runnable verification, or overlaps another concurrent owner's paths.
