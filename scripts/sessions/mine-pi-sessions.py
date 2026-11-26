#!/usr/bin/env python3
"""Mine Pi sessions (~/.pi/agent/sessions/<cwd>/*.jsonl) for brain usage."""
import json, re, sys, os, glob, collections

CORRECTION_RX = re.compile(
    r"\b(why (are|did|were|aren'?t|didn'?t|is|do|don'?t)|not following|you did not|you didn'?t|contrary to|"
    r"not acceptable|again,? you|i (already )?told you|wrong|incorrect|instructed|explicit(ly)? instruct|"
    r"what are you waiting|should not be reminding|what is this new terminology|aren'?t you)\b", re.I)
SKILL_RX = re.compile(r"skills/([a-z0-9-]+)/SKILL\.md")
AGENT_RX = re.compile(r"agents/([a-z0-9-]+)\.md")
PERSONA_RX = re.compile(r"\*{0,2}Persona\*{0,2}:\*{0,2}\s*`?([a-z][a-z-]+)`?", re.I)
HEADING_RX = re.compile(r"^# (Product Manager|Backend Engineer|Web Engineer|Mobile Engineer|Scout|Senior Code Reviewer|Test Engineer|Security Auditor|Web Performance Auditor)\s*$", re.M)
PERSONAS = {"product-manager","backend-engineer","web-engineer","mobile-engineer","scout","code-reviewer","test-engineer","security-auditor","web-performance-auditor"}

def blocks_text(content):
    if isinstance(content, str): return content
    return "\n".join(b.get("text","") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")

def mine(path):
    s = dict(file=os.path.basename(path), project=os.path.basename(os.path.dirname(path)), started=None, ended=None,
             models=collections.Counter(), thinking=collections.Counter(), human_turns=0, assistant_msgs=0, corrections=[],
             personas_declared=collections.Counter(), persona_files_read=collections.Counter(), persona_injected=collections.Counter(),
             skills_read=collections.Counter(), skill_bytes=0, tool_calls=collections.Counter(), tokens=collections.Counter(), cost=0.0,
             first_prompt="", compactions=0, learnings_written=0, spawns=0)
    calls = {}
    for line in open(path, errors="replace"):
        try: o = json.loads(line)
        except Exception: continue
        t = o.get("type")
        if t == "model_change": s["models"][f"{o.get('provider')}/{o.get('modelId')}"] += 1
        elif t == "thinking_level_change": s["thinking"][o.get("thinkingLevel")] += 1
        elif t == "compaction": s["compactions"] += 1
        if t != "message": continue
        m = o.get("message") or {}
        role = m.get("role")
        ts = o.get("timestamp")
        if ts: s["started"] = s["started"] or ts; s["ended"] = ts
        if role == "user":
            txt = blocks_text(m.get("content"))
            injected = HEADING_RX.findall(txt)
            for h in injected: s["persona_injected"][h] += 1
            if txt.lstrip().startswith("<file") or txt.lstrip().startswith("<system"):
                # harness-injected context, not a human turn
                continue
            s["human_turns"] += 1
            if not s["first_prompt"]: s["first_prompt"] = txt[:160].replace("\n", " ")
            if CORRECTION_RX.search(txt) and len(txt) < 1500: s["corrections"].append(txt[:220].replace("\n", " "))
        elif role == "assistant":
            s["assistant_msgs"] += 1
            u = m.get("usage") or {}
            for k in ("input", "output", "cacheRead", "cacheWrite"): s["tokens"][k] += u.get(k, 0) or 0
            s["cost"] += ((u.get("cost") or {}).get("total") or 0)
            for b in m.get("content") or []:
                if not isinstance(b, dict): continue
                if b.get("type") == "text":
                    for pm in PERSONA_RX.findall(b.get("text", "")):
                        if pm in PERSONAS: s["personas_declared"][pm] += 1
                elif b.get("type") == "toolCall":
                    name = b.get("name"); a = b.get("arguments") or {}
                    calls[b.get("id")] = (name, a)
                    s["tool_calls"][name] += 1
                    blob = json.dumps(a)
                    if name in ("read", "bash"):
                        for mm in SKILL_RX.findall(blob): s["skills_read"][mm] += 1
                        for ma in AGENT_RX.findall(blob):
                            if ma in PERSONAS: s["persona_files_read"][ma] += 1
                    if name in ("edit", "write") and "LEARNINGS.md" in blob: s["learnings_written"] += 1
                    if name in ("subagent", "agent", "spawn", "herdr") or "subagent" in name: s["spawns"] += 1
        elif role == "toolResult":
            c = calls.get(m.get("toolCallId"))
            if c and c[0] == "read" and SKILL_RX.search(json.dumps(c[1])):
                s["skill_bytes"] += len(json.dumps(m.get("content")))
    return s

def main():
    paths = []
    for pat in sys.argv[1:]:
        paths.extend(sorted(glob.glob(os.path.expanduser(pat))))
    sessions = [mine(p) for p in paths]
    sessions = [s for s in sessions if s["human_turns"] > 0]
    out = []
    for s in sessions:
        o = dict(s)
        for k in ("models","thinking","personas_declared","persona_files_read","persona_injected","skills_read","tool_calls","tokens"): o[k] = dict(s[k])
        out.append(o)
    json.dump(out, open(os.environ.get("OUT", "/dev/null"), "w"), indent=1)
    print(f"{'project':<34} {'date':<10} {'turns':>5} {'asst':>5} {'corr':>4} {'persona':<22} {'inj':<4} {'skills':>6} {'kB':>5} {'Mtok_in':>7} {'$':>6} {'model':<28} {'first prompt'}")
    for s in sessions:
        per = ",".join(f"{k}:{v}" for k, v in s["personas_declared"].most_common(2)) or "-"
        inj = ",".join(k.split()[0][:3] for k in s["persona_injected"]) or "-"
        tin = (s["tokens"]["input"] + s["tokens"]["cacheRead"] + s["tokens"]["cacheWrite"]) / 1e6
        model = (s["models"].most_common(1) or [("-",0)])[0][0].split("/")[-1]
        print(f"{s['project'][-34:]:<34} {(s['started'] or '')[:10]:<10} {s['human_turns']:>5} {s['assistant_msgs']:>5} {len(s['corrections']):>4} {per:<22} {inj:<4} {sum(s['skills_read'].values()):>6} {s['skill_bytes']//1000:>5} {tin:>7.1f} {s['cost']:>6.1f} {model:<28} {s['first_prompt'][:50]}")
    agg = collections.Counter(); pers = collections.Counter(); pread = collections.Counter(); pinj = collections.Counter(); models = collections.Counter()
    tot_corr = tot_turns = wp = ws = 0; tot_in = 0; tot_cost = 0; tot_skill = 0; tot_comp = 0
    for s in sessions:
        agg.update(s["skills_read"]); pers.update(s["personas_declared"]); pread.update(s["persona_files_read"]); pinj.update(s["persona_injected"]); models.update(s["models"])
        tot_corr += len(s["corrections"]); tot_turns += s["human_turns"]; wp += bool(s["personas_declared"] or s["persona_injected"]); ws += bool(s["skills_read"])
        tot_in += s["tokens"]["input"] + s["tokens"]["cacheRead"] + s["tokens"]["cacheWrite"]; tot_cost += s["cost"]; tot_skill += s["skill_bytes"]; tot_comp += s["compactions"]
    print("\nsessions:", len(sessions), "human turns:", tot_turns, "corrections:", tot_corr, "sessions w/ persona (declared or injected):", wp, "w/ skill read:", ws, "compactions:", tot_comp)
    print("personas declared:", pers.most_common()); print("persona files read:", pread.most_common()); print("persona injected by harness:", pinj.most_common())
    print("skills read:", agg.most_common()); print("models:", models.most_common(8))
    print(f"skill bytes read: {tot_skill/1e6:.2f} MB (~{tot_skill/4/1e6:.2f} Mtok) vs input {tot_in/1e6:.1f} Mtok; cost ${tot_cost:.0f}")

if __name__ == "__main__": main()
