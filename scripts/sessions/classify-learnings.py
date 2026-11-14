#!/usr/bin/env python3
"""Classify LEARNINGS.md notes into themes A-G with a cheap model.
Usage: python3 classify-learnings.py <notes.json> [out.json]
notes.json: list of {"project": "<name>", "text": "<one note, verbatim>"}; one note per entry of a project's docs/LEARNINGS.md.
"""
import json,subprocess,re,collections,concurrent.futures as cf,sys
notes=json.load(open(sys.argv[1]))
OUT=sys.argv[2] if len(sys.argv)>2 else "notes_classified.json"
THEMES="""A coordination: the main/lead agent coordinating parallel subagents (briefs, shared files, merge conflicts, test-suite gating, worktrees, locks, stuck agents, destructive cleanup, approvals not reaching subagents, Linear hygiene when cutting breakdowns, invented vocabulary)
B gate-override: the owner set aside a process gate (per-PR review, full suite per PR, PR size, approval, verification before Done, security work, delete-never) in favour of speed
C mechanics-gap: a skill was silent or wrong on a specific mechanical procedure (gh merge from a worktree, stacked PRs, contract/consumer/generated-client ordering, additive fields vs closed decoders, migration renumbering, mocks, docker/network/ports, simulator driving, PR template missing)
D design-skipped: design discipline not applied (HLD/LLD skipped, contract called the design, redesign dropped features, inconsistent UI across boards, cross-service table reads despite the rule)
E persona-scope: a persona's skill or tool list did not match its work (PM lacking git skills, scout without tools, mobile emulator)
F ceremony: declaration of model/effort/persona, asking the user for model choice, status comments, what to write when a value is unknown
G product-rule: a new product/engineering rule the owner stated that no skill had (concurrency policy, data migration policy, product changelog, terminology)"""
def cls(i):
    t=notes[i]["text"]
    sysmsg=f"Classify the learning note into exactly one theme letter from:\n{THEMES}\nAnswer with JSON only: {{\"theme\": \"<letter>\", \"why\": \"<10 words>\"}}"
    p=subprocess.run(["claude","-p","--model","claude-sonnet-5-5","--output-format","json","--system-prompt",sysmsg,"--tools",""],input=t,capture_output=True,text=True,timeout=180)
    try:
        r=json.loads(p.stdout)["result"]; m=re.search(r"\{[\s\S]*\}",r); return json.loads(m.group(0))
    except Exception: return {"theme":"?","why":p.stdout[:100]}
with cf.ThreadPoolExecutor(8) as ex:
    res=list(ex.map(cls,range(len(notes))))
for n,r in zip(notes,res): n["theme"]=r.get("theme"); n["why"]=r.get("why")
json.dump(notes,open(OUT,"w"),indent=1)
c=collections.Counter((n["project"],n["theme"]) for n in notes)
tot=collections.Counter(n["theme"] for n in notes)
print("total by theme:",sorted(tot.items()))
print("by project:",sorted(c.items()))
