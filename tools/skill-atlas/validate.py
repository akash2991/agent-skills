"""Verify atlas inventory/provenance. No third-party dependencies."""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent

def validate():
    data = json.loads((ROOT / 'data.json').read_text())
    stages = {'Discover', 'Plan', 'Design', 'Build', 'Verify', 'Review', 'Ship', 'Operate', 'Learn'}
    repos = {r['id']: r for r in data['repos']}
    caps = {c['id']: c for c in data['capabilities']}
    assert len(repos) == 4
    assert len(caps) == len(data['capabilities'])
    inventory = set()
    ids = set()
    for skill in data['skills']:
        assert skill['id'] not in ids, skill['id']
        ids.add(skill['id'])
        assert skill['repo'] in repos
        assert skill['stage'] in stages
        assert skill['capability'] in caps, skill['id']
        base = ROOT / 'sources' / skill['repo']
        path = pathlib.Path(skill['path'])
        candidates = [base / path, ROOT / path]
        file = next((p for p in candidates if p.is_file()), None)
        assert file, (skill['id'], skill['path'])
        inventory.add(file.resolve())
        source = file.read_text()
        lines = source.splitlines()
        sha = subprocess.check_output(['git', '-C', str(base), 'rev-parse', 'HEAD'], text=True).strip()
        assert repos[skill['repo']]['sha'] == sha
        assert sha in skill['url'], skill['url']
        for ev in skill['evidence']:
            assert ev['quote'] in source, (skill['id'], ev['quote'])
            assert isinstance(ev['line'], int) and 1 <= ev['line'] <= len(lines)
            assert ev['quote'] in '\n'.join(lines[ev['line']-1:ev['line']+10]), (skill['id'], 'line', ev)
    actual = set()
    for rid in repos:
        base = ROOT / 'sources' / rid
        if rid == 'cursor':
            base /= 'pstack'
        actual.update(p.resolve() for p in base.rglob('SKILL.md'))
    assert inventory == actual, {'missing': list(actual-inventory), 'extra': list(inventory-actual)}
    for r in data['recommendations']:
        assert r['repo'] in repos
        assert all(s in ids for s in r['skills']), r
    print(f'PASS: {len(ids)} unique skills, {len(caps)} capabilities; complete inventory, pinned commits and evidence verified.')

if __name__ == '__main__':
    validate()
