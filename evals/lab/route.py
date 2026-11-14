#!/usr/bin/env python3
"""Persona-routing experiment on real prompts.

For each real prompt (session openers and subagent spawn descriptions mined by
scripts/sessions/), ask a cheap model to route it under two persona schemes.
Input: PROMPTS=<path> to a JSON list of {"src": "<claude:main|claude:sub|pi:main>", "text": "<prompt>"}.
Prompt text is not written back; results/routing.json keeps src, length and the routes only. Measures how often routing is
unambiguous, how often prompts fall outside every persona, and where the schemes disagree.
"""
import json, os, re, subprocess, sys, collections, concurrent.futures as cf

LAB = os.path.dirname(os.path.abspath(__file__))
PROMPTS = json.load(open(os.environ.get("PROMPTS", os.path.join(LAB, "prompts.json"))))
MODEL = sys.argv[1] if len(sys.argv) > 1 else "claude-haiku-5-5"

SCHEMES = {
    "nine": """product-manager: idea → ticket → spec → phased PRD; never designs or codes
backend-engineer: server-side plan/HLD/LLD/code/tests/deploy; never reviews
web-engineer: React web client plan/HLD/LLD/code/tests; never reviews
mobile-engineer: React Native app; never reviews
scout: read-only investigation reported with evidence; edits nothing
code-reviewer: adversarial review of one change; edits nothing
test-engineer: independent verification, files bugs; fixes nothing
security-auditor: audit of security-sensitive surfaces
web-performance-auditor: measured web performance audit""",
    "four": """product-manager: idea → ticket → spec → PRD; never designs or codes
engineer: builds (backend, web or mobile discipline) with design, tests, PR, deploy; never reviews
reviewer: independent verification or review of a change (code, tests, security, performance); edits nothing
scout: read-only investigation reported with evidence; edits nothing""",
}

def route(scheme, text):
    sysmsg = (f"You route a request to exactly one persona from this list, or NONE if no persona may do it (for example coordination of several agents, infrastructure setup, a question about the tooling, or chit-chat).\n{SCHEMES[scheme]}\n"
              "Answer with JSON only: {\"persona\": <name or NONE>, \"confidence\": <0-1>, \"second\": <name or null>}")
    p = subprocess.run(["claude", "-p", "--model", MODEL, "--output-format", "json", "--system-prompt", sysmsg, "--tools", ""],
                       input=f"Request:\n{text[:800]}", capture_output=True, text=True, timeout=180)
    try:
        r = json.loads(p.stdout).get("result", "")
        m = re.search(r"\{[\s\S]*\}", r)
        return json.loads(m.group(0)) if m else {"persona": "ERR", "raw": r[:200]}
    except Exception as e:
        return {"persona": "ERR", "raw": p.stdout[:200] + p.stderr[:200]}

def main():
    jobs = [(i, s, pr) for i, pr in enumerate(PROMPTS) for s in SCHEMES]
    results = {}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(route, s, pr["text"]): (i, s) for i, s, pr in jobs}
        for f in cf.as_completed(futs):
            i, s = futs[f]
            results.setdefault(i, {})[s] = f.result()
    out = [{"src": PROMPTS[i]["src"], "chars": len(PROMPTS[i]["text"]), "routes": results[i]} for i in range(len(PROMPTS))]
    json.dump(out, open(os.path.join(LAB, "results", "routing.json"), "w"), indent=1)
    for s in SCHEMES:
        c = collections.Counter(r["routes"][s].get("persona") for r in out)
        conf = [r["routes"][s].get("confidence") for r in out if isinstance(r["routes"][s].get("confidence"), (int, float))]
        low = sum(1 for x in conf if x < 0.7)
        print(f"scheme {s}: {c.most_common()}; low-confidence (<0.7): {low}/{len(conf)}")
    # per-source NONE rate
    for src in sorted({r["src"] for r in out}):
        sub = [r for r in out if r["src"] == src]
        for s in SCHEMES:
            none = sum(1 for r in sub if r["routes"][s].get("persona") == "NONE")
            print(f"  {src:<13} {s:<5} NONE {none}/{len(sub)}")

if __name__ == "__main__":
    main()
