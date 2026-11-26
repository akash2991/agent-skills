#!/usr/bin/env python3
"""Mine Claude Code transcripts (~/.claude/projects/<proj>/*.jsonl) for brain usage.

Per session: persona declared, skills read, personas read, subagent spawns,
user corrections, token usage. Prints a JSON summary and a table.
"""
import json, re, sys, os, glob, collections

CORRECTION_RX = re.compile(
    r"\b(why (are|did|were|aren'?t|didn'?t|is|do|don'?t)|not following|you did not|you didn'?t|contrary to|"
    r"not acceptable|again,? you|i (already )?told you|wrong|incorrect|instructed|explicit(ly)? instruct|"
    r"what are you waiting|should not be reminding|what is this new terminology|aren'?t you)\b", re.I)
SKILL_RX = re.compile(r"skills/([a-z0-9-]+)/SKILL\.md")
AGENT_RX = re.compile(r"agents/([a-z0-9-]+)\.md")
PERSONA_RX = re.compile(r"\*{0,2}Persona\*{0,2}:\*{0,2}\s*`?([a-z][a-z-]+)`?", re.I)
PERSONAS = {"product-manager","backend-engineer","web-engineer","mobile-engineer","scout","code-reviewer","test-engineer","security-auditor","web-performance-auditor"}

def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict):
            if b.get("type") == "text":
                out.append(b.get("text", ""))
            elif b.get("type") == "tool_result":
                c = b.get("content")
                if isinstance(c, str): out.append(c)
                elif isinstance(c, list):
                    for cc in c:
                        if isinstance(cc, dict) and cc.get("type") == "text": out.append(cc.get("text", ""))
    return "\n".join(out)

def mine(path):
    s = dict(file=os.path.basename(path), project=os.path.basename(os.path.dirname(path)),
             first_prompt="", started=None, ended=None, models=collections.Counter(),
             human_turns=0, assistant_msgs=0, corrections=[], personas_declared=collections.Counter(),
             persona_files_read=collections.Counter(), skills_read=collections.Counter(), skill_bytes=0,
             skill_tool_calls=collections.Counter(), spawns=[], tokens=collections.Counter(),
             tool_calls=collections.Counter(), brain_cmd=0, sidechain_msgs=0, agents_md_read=0, learnings_written=0)
    tool_use_index = {}  # id -> (name, input)
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            try: o = json.loads(line)
            except Exception: continue
            t = o.get("type")
            ts = o.get("timestamp")
            if ts:
                s["started"] = s["started"] or ts
                s["ended"] = ts
            if o.get("isSidechain"):
                s["sidechain_msgs"] += 1
            m = o.get("message") if isinstance(o.get("message"), dict) else None
            if t == "user" and m:
                content = m.get("content")
                is_human = (o.get("origin") or {}).get("kind") == "human" or o.get("turnOrigin") == "human"
                txt = text_of(content)
                # tool results
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            tu = tool_use_index.get(b.get("tool_use_id"))
                            if tu and tu[0] == "Read":
                                fp = (tu[1] or {}).get("file_path", "")
                                if SKILL_RX.search(fp):
                                    s["skill_bytes"] += len(text_of([b]))
                if (isinstance(content, str) and content.strip()) or (isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "text" for b in content)):
                    if txt.startswith("<") and "system-reminder" in txt[:40]:
                        continue
                    s["human_turns"] += 1
                    if not s["first_prompt"]:
                        s["first_prompt"] = txt[:160].replace("\n", " ")
                    if txt.lstrip().startswith("/brain") or "<command-name>/brain" in txt:
                        s["brain_cmd"] += 1
                    if CORRECTION_RX.search(txt) and len(txt) < 1500:
                        s["corrections"].append(txt[:220].replace("\n", " "))
            elif t == "assistant" and m:
                s["assistant_msgs"] += 1
                if m.get("model"): s["models"][m["model"]] += 1
                u = m.get("usage") or {}
                for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                    s["tokens"][k] += u.get(k, 0) or 0
                for b in m.get("content") or []:
                    if not isinstance(b, dict): continue
                    if b.get("type") == "text":
                        for pm in PERSONA_RX.findall(b.get("text", "")):
                            if pm in PERSONAS: s["personas_declared"][pm] += 1
                    elif b.get("type") == "tool_use":
                        name = b.get("name"); inp = b.get("input") or {}
                        tool_use_index[b.get("id")] = (name, inp)
                        s["tool_calls"][name] += 1
                        if name == "Read":
                            fp = inp.get("file_path", "")
                            mm = SKILL_RX.search(fp)
                            if mm: s["skills_read"][mm.group(1)] += 1
                            ma = AGENT_RX.search(fp)
                            if ma and ma.group(1) in PERSONAS: s["persona_files_read"][ma.group(1)] += 1
                            if fp.endswith("AGENTS.md"): s["agents_md_read"] += 1
                        elif name == "Skill":
                            s["skill_tool_calls"][inp.get("skill") or inp.get("name") or "?"] += 1
                        elif name in ("Agent", "Task"):
                            p = inp.get("prompt", "") or ""
                            per = [x for x in PERSONAS if x in p or x in (inp.get("subagent_type") or "")]
                            s["spawns"].append(dict(type=inp.get("subagent_type"), model=inp.get("model"), persona=per[:1], prompt_len=len(p), desc=inp.get("description")))
                        elif name in ("Edit", "Write") and "LEARNINGS.md" in (inp.get("file_path") or ""):
                            s["learnings_written"] += 1
    return s

def main():
    paths = []
    for arg in sys.argv[1:]:
        paths.extend(sorted(glob.glob(os.path.join(os.path.expanduser(arg), "*.jsonl"))))
    sessions = [mine(p) for p in paths]
    sessions = [s for s in sessions if s["human_turns"] > 0]
    out = []
    for s in sessions:
        o = dict(s);
        for k in ("models", "personas_declared", "persona_files_read", "skills_read", "skill_tool_calls", "tokens", "tool_calls"):
            o[k] = dict(s[k])
        out.append(o)
    json.dump(out, open(os.environ.get("OUT", "/dev/null"), "w"), indent=1)
    # table
    print(f"{'project':<8} {'date':<10} {'turns':>5} {'asst':>5} {'corr':>4} {'persona':<18} {'skills_read':>11} {'skill_kB':>8} {'spawns':>6} {'Mtok_in':>7} {'first prompt'}")
    for s in sessions:
        per = ",".join(f"{k}:{v}" for k, v in s["personas_declared"].most_common(2)) or "-"
        tin = (s["tokens"]["input_tokens"] + s["tokens"]["cache_read_input_tokens"] + s["tokens"]["cache_creation_input_tokens"]) / 1e6
        print(f"{s['project'][-6:]:<8} {(s['started'] or '')[:10]:<10} {s['human_turns']:>5} {s['assistant_msgs']:>5} {len(s['corrections']):>4} {per:<18} {sum(s['skills_read'].values()):>11} {s['skill_bytes']//1000:>8} {len(s['spawns']):>6} {tin:>7.1f} {s['first_prompt'][:60]}")
    # aggregates
    agg_skills = collections.Counter(); agg_pers = collections.Counter(); agg_read = collections.Counter(); spawn_types = collections.Counter(); spawn_personas = collections.Counter()
    tot_corr = 0; tot_turns = 0; sess_with_persona = 0; sess_with_skill = 0; tot_skill_bytes = 0; tot_in = 0
    for s in sessions:
        agg_skills.update(s["skills_read"]); agg_pers.update(s["personas_declared"]); agg_read.update(s["persona_files_read"])
        for sp in s["spawns"]:
            spawn_types[sp["type"]] += 1
            spawn_personas[(sp["persona"] or ["none"])[0]] += 1
        tot_corr += len(s["corrections"]); tot_turns += s["human_turns"]
        sess_with_persona += bool(s["personas_declared"]); sess_with_skill += bool(s["skills_read"])
        tot_skill_bytes += s["skill_bytes"]; tot_in += s["tokens"]["input_tokens"] + s["tokens"]["cache_read_input_tokens"] + s["tokens"]["cache_creation_input_tokens"]
    print("\nsessions:", len(sessions), "human turns:", tot_turns, "corrections:", tot_corr, "sessions w/ persona declared:", sess_with_persona, "w/ skill read:", sess_with_skill)
    print("personas declared:", agg_pers.most_common())
    print("persona files read:", agg_read.most_common())
    print("skills read (sessions x reads):", agg_skills.most_common())
    print("spawn subagent_type:", spawn_types.most_common())
    print("spawn persona in prompt:", spawn_personas.most_common())
    print(f"skill bytes read total: {tot_skill_bytes/1e6:.2f} MB (~{tot_skill_bytes/4/1e6:.2f} Mtok) vs total input tokens {tot_in/1e6:.1f} Mtok")

if __name__ == "__main__":
    main()
