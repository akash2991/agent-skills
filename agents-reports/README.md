# Uniform Reports

Every agent submits its report in the format for its role. Same role, same format, every time. A report is a claim; the receiver verifies it.

| Role | Template | Sent to |
|---|---|---|
| CEO | `ceo-report.md` | User |
| Product Manager | `pm-report.md` | CEO |
| Engineering Manager | `em-report.md` | PM |
| Principal Engineer (design) | `principal-engineer-design-report.md` | EM |
| Principal Engineer (reviewing a design) | `design-review.md` | EM and the authoring PE |
| Staff Engineer (implementation) | `staff-engineer-report.md` | EM |
| Code Reviewer (backend, web, mobile) | `merge-review.md` | Author and EM |
| Security Auditor | audit report in the persona | Requesting EM |
| Web Performance Auditor | audit report in the persona | Requesting EM |
| QA Engineer | `qa-report.md` | EM |

## Shared header

Every report starts with this header, then the role-specific sections.

```markdown
## Report
- From: <agent_id> (<role>)
- To: <agent_id or role>
- Ticket: <tracker id>
- Status: DONE | PARTIAL | BLOCKED
- Model / effort: <model> / <low|medium|high|max>
- Budget: spent <in>/<out> of allocated <in>/<out> tokens (<n>% / <n>%), cost <x or UNKNOWN>; source: <observatory | runtime | UNKNOWN>
```

## Status words

- `DONE` means the goal is met and evidence is attached.
- `PARTIAL` means some acceptance criteria are met; list what is not.
- `BLOCKED` means work cannot continue; say what is needed to unblock it and hand back to the coordinator.

Never round `PARTIAL` up to `DONE`.
