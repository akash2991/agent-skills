#!/usr/bin/env python3
"""Re-grade every results/<run>/ from its saved trace and diff, with Bash-aware detection.

Prints one row per run and a per-arm summary table.
"""
import json, os, re, sys, glob, collections

LAB = os.path.dirname(os.path.abspath(__file__))
SKILL_RX = re.compile(r"(?:skills/|cd \.(?:claude|agents)/skills[^\n]*?\b)([a-z0-9-]+)/SKILL\.md")
SKILL_ANY_RX = re.compile(r"\b([a-z0-9-]+)/SKILL\.md")
WRITE_RX = re.compile(r"(?:cat\s*>+\s*|tee\s+(?:-a\s+)?|sed\s+-i[^\s]*\s+(?:'[^']*'|\"[^\"]*\"|\S+)\s+)(\S+)")


def hunks(diff, path_rx):
    added, cur = [], None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            cur = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and cur and re.search(path_rx, cur):
            added.append(line[1:])
    return "\n".join(added)


def grade(run_dir):
    old = json.load(open(os.path.join(run_dir, "grade.json")))
    trace = open(os.path.join(run_dir, "trace.jsonl")).read()
    diff = open(os.path.join(run_dir, "diff.patch")).read()
    final_text = open(os.path.join(run_dir, "final.txt")).read()
    edits, reads, bash, skill_calls, turns = [], [], [], [], 0
    for line in trace.splitlines():
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") != "assistant": continue
        turns += 1
        for b in (e.get("message") or {}).get("content") or []:
            if b.get("type") != "tool_use": continue
            n, i = b.get("name"), b.get("input") or {}
            if n in ("Edit", "Write"): edits.append(i.get("file_path", ""))
            elif n == "Read": reads.append(i.get("file_path", ""))
            elif n == "Bash":
                c = i.get("command", ""); bash.append(c)
                edits += [m for m in WRITE_RX.findall(c) if not m.startswith("/dev")]
                if re.search(r"python\s+-\s*<<", c):  # inline python that rewrites a file
                    edits += re.findall(r"p\s*=\s*\"([^\"]+)\"", c)
            elif n == "Skill": skill_calls.append(i.get("skill") or i.get("name"))
    allcmds = "\n".join(bash) + "\n" + "\n".join(reads)
    persona_read = "backend-engineer.md" in allcmds
    agents_read = bool(re.search(r"\bAGENTS\.md", allcmds))
    skills_full = sorted({m for m in SKILL_ANY_RX.findall("\n".join(reads))} | {m for c in bash for m in SKILL_ANY_RX.findall(c) if re.search(r"\b(cat|sed -n|head|less)\b", c)})
    skills_grep = sorted({m for c in bash for m in re.findall(r"\b([a-z0-9-]+)/SKILL\.md", c) if re.search(r"\bgrep\b|\brg\b", c)} - set(skills_full))
    skills_grep += sorted({m for c in bash for m in re.findall(r"skills[^\n]*?\bgrep[^\n]*?\b([a-z0-9-]+)/S", c)} - set(skills_full) - set(skills_grep))
    jobs_added = hunks(diff, r"contentos/services/jobs/(?!tests)")
    contract_added = hunks(diff, r"contracts/")
    web_added = hunks(diff, r"web/src")
    boundary_violation = bool(re.search(r"FROM\s+posts|catalogue\.persistence|get_post_row|JOIN\s+posts", jobs_added))
    uses_client = bool(re.search(r"catalogue\.client|PostsClient", jobs_added))
    contract_updated = "post_title" in contract_added
    required_added = bool(re.search(r"required:.*post_title", contract_added))
    edited_web = bool(web_added.strip())
    ft = final_text.lower()
    consumer_named = ("web" in ft) and any(k in ft for k in ("jobs.ts", "decoder", "web-engineer", "web engineer", "web client", "consumer"))
    order_named = consumer_named and any(k in ft for k in ("same release", "same pr", "before", "first", "order", "together", "deploy"))
    ft_edit = next((k for k, p in enumerate(edits) if "/tests/" in p or os.path.basename(p).startswith("test_")), None)
    fi_edit = next((k for k, p in enumerate(edits) if "services/jobs/" in p and "/tests/" not in p), None)
    test_first = ft_edit is not None and (fi_edit is None or ft_edit < fi_edit)
    ran_pytest = any("pytest" in c for c in bash)
    learnings = bool(re.search(r"LEARNINGS\.md", "\n".join(edits)))
    return dict(task=("2" if os.path.basename(run_dir).startswith("2") else "1"), arm=old["arm"], run=old["run"], model=old["model"], duration_s=old["duration_s"], turns=turns, cost_usd=old["cost_usd"],
                tokens_in=old["usage"]["input"] + old["usage"]["cache_read"] + old["usage"]["cache_create"], tokens_out=old["usage"]["output"],
                boundary_ok=not boundary_violation and uses_client, contract_updated=contract_updated, field_required=required_added,
                edited_web=edited_web, consumer_named=consumer_named, order_named=order_named,
                compat_ok=contract_updated and (not required_added or edited_web), test_first=test_first, ran_pytest=ran_pytest,
                tests_pass=old["tests_pass"], persona_read=persona_read, agents_read=agents_read, skills_full=skills_full, skills_grep=skills_grep,
                learnings=learnings, diff_lines=len(diff.splitlines()))


def main():
    rows = [grade(d) for d in sorted(glob.glob(os.path.join(LAB, "results", "*"))) if os.path.isdir(d) and os.path.exists(os.path.join(d, "grade.json"))]
    json.dump(rows, open(os.path.join(LAB, "results", "all-grades.json"), "w"), indent=1)
    cols = ["boundary_ok", "compat_ok", "consumer_named", "order_named", "test_first", "ran_pytest", "tests_pass", "persona_read", "agents_read"]
    print(f"{'task':<5}{'arm':<11}{'run':<4}{'s':>5}{'turn':>5}{'$':>6}{'kTok':>7} " + " ".join(f"{c[:9]:>9}" for c in cols) + "  skills_full / grep")
    for r in rows:
        print(f"{r['task']:<5}{r['arm']:<11}{r['run'][-1]:<4}{r['duration_s']:>5}{r['turns']:>5}{(r['cost_usd'] or 0):>6.2f}{r['tokens_in']//1000:>7} " + " ".join(f"{str(r[c])[0]:>9}" for c in cols) + f"  {r['skills_full']} / {r['skills_grep']}")
    print()
    by = collections.defaultdict(list)
    for r in rows: by[(r["task"], r["model"].split("-")[1], r["arm"])].append(r)
    print(f"{'task':<5}{'model':<7}{'arm':<11}{'n':>3}{'$avg':>6}{'kTok':>7}{'turns':>6} " + " ".join(f"{c[:9]:>9}" for c in cols))
    for (task, model, arm), rs in sorted(by.items()):
        n = len(rs)
        print(f"{task:<5}{model:<7}{arm:<11}{n:>3}{sum(r['cost_usd'] or 0 for r in rs)/n:>6.2f}{sum(r['tokens_in'] for r in rs)//n//1000:>7}{sum(r['turns'] for r in rs)/n:>6.1f} " + " ".join(f"{sum(bool(r[c]) for r in rs)}/{n}".rjust(9) for c in cols))


if __name__ == "__main__":
    main()
