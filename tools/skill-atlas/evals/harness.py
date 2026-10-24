#!/usr/bin/env python3
"""Offline structural and behavioral checks; never a semantic-quality scorer."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
CASES = ('planning', 'tdd', 'review', 'debugging')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def digest_tree(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob('*')) if p.is_file()}


def run(args, cwd):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=10)
        return {'command': args, 'exit_code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr, 'timeout': False}
    except subprocess.TimeoutExpired as e:
        return {'command': args, 'exit_code': None, 'stdout': str(e.stdout or ''), 'stderr': str(e.stderr or ''), 'timeout': True}


def validate_plan(data):
    tasks = data['tasks']
    require(isinstance(tasks, list) and tasks, 'tasks must be a nonempty list')
    ids = [t['id'] for t in tasks]
    require(all(nonempty(i) for i in ids) and len(set(ids)) == len(ids), 'unique nonempty task IDs required')
    by_id = {t['id']: t for t in tasks}
    for t in tasks:
        require(type(t['points']) is int and t['points'] in (1, 2, 3), 'points must be 1/2/3')
        require(isinstance(t['paths'], list) and t['paths'] and all(nonempty(p) and not Path(p).is_absolute() and '..' not in Path(p).parts and not any(c in p for c in '*?[') for p in t['paths']), 'use explicit relative owned file paths, no globs')
        require(isinstance(t['dependsOn'], list) and all(i in by_id for i in t['dependsOn']), 'unknown dependency')
        require(isinstance(t['acceptance'], list) and t['acceptance'] and all(nonempty(x) for x in t['acceptance']), 'acceptance required')
        require(nonempty(t['verification']), 'verification required')
    def ancestors(i, stack=()):
        require(i not in stack, 'dependency cycle')
        out = set()
        for dep in by_id[i]['dependsOn']:
            out.add(dep)
            out.update(ancestors(dep, stack + (i,)))
        return out
    ancestry = {i: ancestors(i) for i in ids}
    for n, a in enumerate(ids):
        for b in ids[n+1:]:
            if a not in ancestry[b] and b not in ancestry[a]:
                ap = {str(Path(p)) for p in by_id[a]['paths']}
                bp = {str(Path(p)) for p in by_id[b]['paths']}
                require(not ap & bp, 'concurrent path overlap: ' + a + ', ' + b)
    sprint = data['sprint']
    require(type(sprint['capacity']) is int and sprint['capacity'] == 8, 'capacity must be eight')
    selected = sprint['tasks']
    require(isinstance(selected, list) and selected and len(set(selected)) == len(selected) and all(i in by_id for i in selected), 'invalid sprint tasks')
    require(sum(by_id[i]['points'] for i in selected) <= 8, 'sprint over capacity')
    require(all(ancestry[i] <= set(selected) for i in selected), 'sprint missing prerequisite')
    milestones = data['milestones']
    require(isinstance(milestones, list) and milestones, 'milestones required')
    seen = set()
    for m in milestones:
        require(nonempty(m['id']) and nonempty(m['outcome']) and isinstance(m['tasks'], list) and m['tasks'], 'invalid milestone')
        for i in m['tasks']:
            require(i in by_id and i not in seen, 'unknown or repeated milestone task')
            require(ancestry[i] <= seen, 'milestone tasks must be dependency ordered')
            seen.add(i)
    require(seen == set(ids), 'every task needs a milestone')
    require(isinstance(data['deferred'], list) and all(nonempty(x) for x in data['deferred']), 'deferred must be a list of explanations')


def evaluate(case, submission):
    submission = Path(submission).resolve()
    report = {'schema_version': 1, 'case_id': case, 'status': 'needs_human_review',
              'quality_score': None, 'human_ratings': None, 'checks': [], 'executions': [],
              'submission_sha256': digest_tree(submission),
              'fixture_sha256': digest_tree(ROOT / 'fixtures' / case)}
    def check(name, fn):
        try:
            fn()
            report['checks'].append({'name': name, 'passed': True})
        except (ValueError, KeyError, TypeError, OSError, AssertionError) as e:
            report['checks'].append({'name': name, 'passed': False, 'detail': str(e)})
    def artifact(name):
        require((submission / name).is_file() and (submission / name).stat().st_size > 0, 'missing/empty ' + name)
    def manifest():
        data = json.loads((submission / 'run.json').read_text())
        require(data['case_id'] == case and data['status'] == 'submitted', 'wrong case or unrun manifest')
        require(data['condition'] in ('control', 'skill') and data['seed'] in (17,29,43), 'condition/seed invalid')
        for k in ('model', 'tools', 'budget', 'usage', 'skill', 'environment'):
            require(k in data, 'missing metadata: ' + k)
        require(data['budget'] == {'wall_seconds': 1200, 'total_tokens': 12000}, 'noncanonical budget')
        artifact('transcript.jsonl')
        for line in (submission / 'transcript.jsonl').read_text().splitlines():
            event = json.loads(line)
            require(all(k in event for k in ('sequence', 'event', 'timestamp', 'content')), 'invalid transcript event')
    check('metadata and transcript presence (not authenticity)', manifest)
    check('notes artifact', lambda: artifact('notes.md'))
    if case == 'planning':
        check('plan document', lambda: artifact('plan.md'))
        check('plan structure and graph', lambda: validate_plan(json.loads((submission / 'plan.json').read_text())))
    elif case == 'review':
        def review():
            data = json.loads((submission / 'review.json').read_text())
            require(nonempty(data['summary']) and isinstance(data['findings'], list), 'summary/findings required')
            for f in data['findings']:
                require(f['file'] == 'after.cjs' and type(f['line']) is int and 1 <= f['line'] <= 4, 'invalid finding location')
                require(f['severity'] in ('low','medium','high','critical') and f['axis'] in ('standards','spec'), 'invalid classification')
                require(all(nonempty(f[k]) for k in ('claim','reproduction','impact','fix')), 'finding evidence fields required')
            for name in ('before.cjs','after.cjs','SPEC.md'):
                require((submission / name).read_bytes() == (ROOT / 'fixtures/review' / name).read_bytes(), 'review fixture changed: ' + name)
        check('review shape and unchanged source (not defect coverage)', review)
    else:
        def behavioral():
            artifact('index.cjs')
            artifact('regression.cjs')
            # Run only staged copies; relative imports resolve in the submitted project.
            with tempfile.TemporaryDirectory(prefix='skill-eval-') as temp:
                stage = Path(temp) / 'candidate'
                shutil.copytree(submission, stage)
                acceptance = run(['node', str(ROOT / 'private/acceptance.cjs'), case, str(stage)], stage)
                green = run(['node', 'regression.cjs'], stage)
                (stage / 'index.cjs').write_bytes((ROOT / 'fixtures' / case / 'index.cjs').read_bytes())
                red = run(['node', 'regression.cjs'], stage)
                report['executions'].extend([dict(role='held_out', **acceptance), dict(role='regression_candidate', **green), dict(role='regression_original', **red)])
                require(acceptance['exit_code'] == 0, 'held-out behavior failed')
                require(green['exit_code'] == 0, 'submitted regression failed on candidate')
                require(red['exit_code'] not in (0, None), 'regression did not fail on original (timeouts do not count)')
        check('behavior and differential regression replay', behavioral)
    if any(not c['passed'] for c in report['checks']):
        report['status'] = 'automated_checks_failed'
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', choices=CASES)
    parser.add_argument('submission', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = evaluate(args.case, args.submission)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(result['status'] + '; semantic quality remains unscored')
    raise SystemExit(1 if result['status'] == 'automated_checks_failed' else 0)
