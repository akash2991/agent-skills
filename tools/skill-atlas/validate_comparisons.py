"""Validate compact comparisons against the researched inventory; no model calls."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
inventory = json.loads((root / 'data.json').read_text())
data = json.loads((root / 'comparisons.json').read_text())
skills = {s['id']: s for s in inventory['skills']}
caps = {c['id'] for c in inventory['capabilities']}
repos = {r['id'] for r in inventory['repos']}
seen = set()
cells = 0
for g in data['groups']:
    assert g['id'] in caps and g['id'] not in seen, g['id']
    seen.add(g['id'])
    rows = {r['id'] for r in g['rows']}
    assert len(rows) == len(g['rows'])
    assert 4 <= len(rows) <= 7
    columns = {c['repo'] for c in g['columns']}
    assert len(columns) == len(g['columns'])
    for c in g['columns']:
        assert c['repo'] in repos
        assert c['skillIds']
        for sid in c['skillIds']:
            assert skills[sid]['repo'] == c['repo'], (g['id'], sid)
            assert skills[sid]['capability'] == g['id'], (g['id'], sid)
        assert set(c['cells']) == rows
        for cell in c['cells'].values():
            cells += 1
            assert cell['source'] in c['skillIds'], cell
            assert cell['highlight'] in cell['text'], cell
            assert len(cell['text'].split()) <= 11, cell
            assert cell['detail'].strip(), cell
    overall = next(s for s in g['scenarios'] if s['id'] == 'overall')
    assert not overall['preferredRepos']
    assert len({s['id'] for s in g['scenarios']}) == len(g['scenarios'])
    for scenario in g['scenarios']:
        assert set(scenario['preferredRepos']) <= columns, scenario
        assert scenario['reason'].strip()
print(f'PASS: {len(seen)} compact comparisons, {cells} cells, valid highlights and source mappings.')
