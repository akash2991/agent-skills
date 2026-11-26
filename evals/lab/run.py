#!/usr/bin/env python3
"""Run one lab arm once: copy the fixture to a fresh workspace, run headless claude, grade.

usage: run.py <arm> <run-id> [model]
Writes results/<arm>-<run-id>/{trace.jsonl,diff.patch,final.txt,grade.json}
"""
import json, os, re, shutil, subprocess, sys, time, tempfile

LAB = os.path.dirname(os.path.abspath(__file__))
ARMS = json.load(open(os.path.join(LAB, "arms.json")))
TOOLS = "Read,Glob,Grep,Edit,Write,Bash,Skill"


def sh(args, cwd, **kw):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, **kw)


def main():
    arm, run_id = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "claude-opus-5-5"
    spec = ARMS["arms"][arm]
    prompt = spec["prompt"].format(ticket=ARMS["ticket"], rules=ARMS["rules"])
    out = os.path.join(LAB, "results", f"{os.environ.get('LAB_FIXTURE_SUFFIX', '')}{arm}-{run_id}")
    os.makedirs(out, exist_ok=True)
    ws = tempfile.mkdtemp(prefix=f"lab-{arm}-")
    fixture = spec["fixture"].replace("fixture", "fixture" + os.environ.get("LAB_FIXTURE_SUFFIX", ""), 1)
    shutil.copytree(os.path.join(LAB, fixture), ws, dirs_exist_ok=True)
    for c in (["git", "init", "-q"], ["git", "config", "user.email", "lab@example.invalid"], ["git", "config", "user.name", "Lab"],
              ["git", "add", "-A"], ["git", "commit", "-q", "-m", "fixture baseline"], ["git", "tag", "baseline"]):
        sh(c, ws)
    t0 = time.time()
    env = dict(os.environ, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
               PATH=os.path.join(LAB, "venv", "bin") + os.pathsep + os.environ["PATH"])
    p = subprocess.run(
        ["claude", "-p", "--verbose", "--output-format", "stream-json", "--model", model,
         "--permission-mode", "acceptEdits", "--allowedTools", TOOLS, "--max-turns", "80"],
        input=prompt, cwd=ws, capture_output=True, text=True, env=env, timeout=1800)
    dur = time.time() - t0
    open(os.path.join(out, "trace.jsonl"), "w").write(p.stdout)
    open(os.path.join(out, "stderr.txt"), "w").write(p.stderr)
    sh(["git", "add", "-A"], ws)
    diff = sh(["git", "diff", "--cached", "baseline"], ws).stdout
    open(os.path.join(out, "diff.patch"), "w").write(diff)
    test = sh([os.path.join(LAB, "venv", "bin", "python"), "-m", "pytest", "-q"], ws)
    grade = grade_run(p.stdout, diff, test.returncode == 0, dur, model, arm, run_id)
    json.dump(grade, open(os.path.join(out, "grade.json"), "w"), indent=1)
    open(os.path.join(out, "final.txt"), "w").write(grade.pop("final_text", ""))
    shutil.rmtree(ws, ignore_errors=True)
    print(json.dumps({k: v for k, v in grade.items() if k != "final_text"}))


def hunks(diff, path_rx):
    """Return the added lines of the files whose path matches path_rx."""
    added, cur = [], None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            cur = line[6:]
        elif line.startswith("+") and not line.startswith("+++") and cur and re.search(path_rx, cur):
            added.append(line[1:])
    return "\n".join(added)


def grade_run(trace, diff, tests_pass, dur, model, arm, run_id):
    events, final_text, edits_order, bash_cmds, reads, skill_calls = [], "", [], [], [], []
    usage = dict(input=0, output=0, cache_read=0, cache_create=0)
    cost = None; turns = 0
    for line in trace.splitlines():
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "assistant":
            m = e.get("message") or {}
            turns += 1
            u = m.get("usage") or {}
            usage["input"] += u.get("input_tokens", 0); usage["output"] += u.get("output_tokens", 0)
            usage["cache_read"] += u.get("cache_read_input_tokens", 0); usage["cache_create"] += u.get("cache_creation_input_tokens", 0)
            for b in m.get("content") or []:
                if b.get("type") == "text": final_text = b.get("text") or final_text
                elif b.get("type") == "tool_use":
                    n, i = b.get("name"), b.get("input") or {}
                    if n in ("Edit", "Write"): edits_order.append(i.get("file_path", ""))
                    elif n == "Bash": bash_cmds.append(i.get("command", ""))
                    elif n == "Read": reads.append(i.get("file_path", ""))
                    elif n == "Skill": skill_calls.append(i.get("skill") or i.get("name"))
        elif e.get("type") == "result":
            cost = e.get("total_cost_usd"); final_text = e.get("result") or final_text
    jobs_added = hunks(diff, r"contentos/services/jobs/(?!tests)")
    contract_added = hunks(diff, r"contracts/")
    web_added = hunks(diff, r"^web/|/web/")
    boundary_violation = bool(re.search(r"FROM\s+posts|catalogue\.persistence|get_post_row|JOIN\s+posts", jobs_added))
    uses_client = bool(re.search(r"catalogue\.client|PostsClient", jobs_added))
    contract_updated = "post_title" in contract_added
    required_added = bool(re.search(r"required:.*post_title", contract_added))
    edited_web = bool(web_added.strip())
    ft = final_text.lower()
    consumer_named = ("web" in ft) and any(k in ft for k in ("jobs.ts", "decoder", "web-engineer", "web engineer", "web client", "consumer"))
    first_test_edit = next((k for k, p in enumerate(edits_order) if "/tests/" in p or "test_" in os.path.basename(p)), None)
    first_impl_edit = next((k for k, p in enumerate(edits_order) if "contentos/services/jobs/" in p and "/tests/" not in p), None)
    test_first = first_test_edit is not None and (first_impl_edit is None or first_test_edit < first_impl_edit)
    ran_pytest = any("pytest" in c for c in bash_cmds)
    read_persona = any(p.endswith("backend-engineer.md") for p in reads)
    skills_read = sorted({re.search(r"skills/([a-z0-9-]+)/", p).group(1) for p in reads if re.search(r"skills/([a-z0-9-]+)/SKILL\.md", p)})
    skills_read += [s for s in skill_calls if s]
    declared = bool(re.search(r"persona:\s*`?backend-engineer", final_text, re.I)) or any(re.search(r"persona:\s*`?backend-engineer", l, re.I) for l in trace.splitlines()[:400])
    return dict(arm=arm, run=run_id, model=model, duration_s=round(dur), turns=turns, cost_usd=cost, usage=usage,
                boundary_ok=not boundary_violation and uses_client, boundary_violation=boundary_violation, uses_client=uses_client,
                contract_updated=contract_updated, field_required=required_added, edited_web=edited_web, consumer_named=consumer_named,
                compat_ok=(contract_updated and (not required_added or edited_web)),
                test_first=test_first, ran_pytest=ran_pytest, tests_pass=tests_pass,
                read_persona=read_persona, skills_read=skills_read, declared_persona=declared,
                diff_lines=len(diff.splitlines()), final_text=final_text)


if __name__ == "__main__":
    main()
