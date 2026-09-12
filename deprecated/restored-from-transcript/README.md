# Restored from transcript, not byte-verified

The files in this directory were **untracked** when they were deleted, so git cannot restore them. They were rebuilt from complete copies captured in the working session that removed them. Each one was read in full at the time, and the line counts match what was observed, but they have not been diffed against the originals because the originals no longer exist anywhere on this machine.

Treat them as faithful copies, not as pristine originals. If you have another copy of any of these, prefer it.

| File | Origin | Observed line count |
|---|---|---|
| `operating-model/global/AGENTS.md` | the user-level CEO/captain contract from `deprecated/operating-model/` | 133, matches |
| `operating-model/project/AGENTS.md` | the project-level contract from `deprecated/operating-model/` | 138, matches |
| `agents/technical-program-manager.md` | upstream persona, retired when `delivery-status` took over the function | not recorded |
| `agents/frontend-engineer.md` | upstream persona, superseded by `web-staff-engineer` | not recorded |
| `agents/backend-engineer.md` | upstream persona, superseded by `backend-staff-engineer` | not recorded |
| `docs/operating-model.md` | the pre-brain operating-model guide | not recorded |
| `AGENT_OPERATING_SYSTEM.md` | the owner's operating-system document | 2014 lines against an original of 2013; all 37 sections plus Appendices A, B, and C present, verified against the original heading inventory. Appendix C points at `Goal.md` rather than restating raw notes from a fragment |

## Not recovered

These were also untracked and were only read in part, so reconstructing them would mean inventing content. They are listed so the loss is visible rather than silent:

| File | What it was | Why not restored |
|---|---|---|
| `agent-os/README.md`, `agent-os/.agents/PROJECT_STATE.md`, `agent-os/.agents/BLOCKERS.md`, `agent-os/.agents/README.md` | the owner's folder scaffolding and empty state files | never read in full; they were placeholders whose successors are the control plane and `templates/global-docs/` |
| `templates/operating-model/project/CONSTRAINTS.md` and the `.agents/*.md` state templates | the pre-brain durable state templates | read only in part; their successors are `templates/global-docs/` and the control plane |
| `skills/project-captaincy/SKILL.md`, `skills/delivery-visibility/SKILL.md` | upstream governance skills | read only in part; superseded by `request-intake` and `delivery-status` |
| `docs/operating-model-conflicts.md` | the conflict register | never read |
