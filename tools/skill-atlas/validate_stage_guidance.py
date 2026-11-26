"""Validate stage recommendations without treating fit hypotheses as measurements."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent
data = json.loads((root / 'data.json').read_text())
guidance = json.loads((root / 'stage-guidance.json').read_text())
skills = {s['id']: s for s in data['skills']}
stages = {s['stage'] for s in data['skills']}
assert set(guidance['stages']) == stages
count = picks = 0
for stage, info in guidance['stages'].items():
    contexts = info['contexts']
    assert len(contexts) == 4 if stage == 'Build' else 2 <= len(contexts) <= 3
    assert len({c['id'] for c in contexts}) == len(contexts)
    for context in contexts:
        count += 1
        assert context['label'] and context['reason']
        assert 1 <= len(context['picks']) <= 4
        assert len({p['skill'] for p in context['picks']}) == len(context['picks'])
        for p in context['picks']:
            picks += 1
            assert p['skill'] in skills
            assert skills[p['skill']]['stage'] == stage, (stage, p['skill'])
            assert p['role'] and p['reason']
            assert len(p['reason'].split()) <= 16
            assert p['alternativeGroup'] is None or isinstance(p['alternativeGroup'], str)
print(f'PASS: {len(stages)} stages, {count} contexts, {picks} source-mapped suggestions.')
