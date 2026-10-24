#!/usr/bin/env python3
"""Harness unit tests using hand-written solutions, NOT agent evaluation runs."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from harness import ROOT, evaluate, validate_plan

FIXES = {
    'tdd': '''exports.discount = (c, p) => {
  if (!Number.isInteger(c) || c < 0 || c > 1000000 || !Number.isInteger(p) || p < 0 || p > 100) throw new RangeError('invalid input');
  return Math.round(c * (100-p)/100);
};\n''',
    'debugging': '''exports.createLoader = fetchValue => {
  const cache = new Map();
  return async (tenant, key) => {
    const id = JSON.stringify([tenant, key]);
    if (!cache.has(id)) {
      const pending = Promise.resolve().then(() => fetchValue(tenant,key)).catch(error => { cache.delete(id); throw error; });
      cache.set(id,pending);
    }
    return cache.get(id);
  };
};\n'''
}
REGRESSIONS = {
    'tdd': "const a=require('node:assert/strict'); a.equal(require('./index.cjs').discount(1,50),1);\n",
    'debugging': '''const a=require('node:assert/strict');
const {createLoader}=require('./index.cjs');
(async()=>{
 const load=createLoader(async(t,k)=>JSON.stringify([t,k]));
 a.notEqual(await load('a:b','c'), await load('a','b:c'));
 let n=0; const retry=createLoader(async()=>{if(++n===1)throw Error('fail');return 1;});
 await a.rejects(retry('t','k')); a.equal(await retry('t','k'),1);
})().catch(e=>{console.error(e);process.exitCode=1;});\n'''
}
PLAN = {
 'tasks': [
  {'id':'contract','paths':['contract.cjs'],'dependsOn':[],'points':1,'acceptance':['Shared interface agreed'],'verification':'Proposed: node --test contract.test.cjs'},
  {'id':'json','paths':['format.cjs'],'dependsOn':['contract'],'points':2,'acceptance':['JSON preserves fields'],'verification':'Proposed: node --test format.test.cjs'},
  {'id':'cli','paths':['cli.cjs'],'dependsOn':['json'],'points':3,'acceptance':['JSON export works safely'],'verification':'Proposed: node --test cli.test.cjs'}
 ],
 'milestones':[{'id':'M1','tasks':['contract','json','cli'],'outcome':'User exports JSON'}],
 'sprint':{'capacity':8,'tasks':['contract','json','cli']}, 'deferred':['CSV deferred to keep delivery within capacity']
}

class HarnessTests(unittest.TestCase):
    def submission(self, folder, case):
        shutil.copytree(ROOT / 'fixtures' / case, folder, dirs_exist_ok=True)
        (folder/'notes.md').write_text('Synthetic harness self-test only; not agent evidence.')
        (folder/'run.json').write_text(json.dumps({'case_id':case,'status':'submitted','condition':'control','seed':17,'model':'SELFTEST-NOT-AN-AGENT','tools':[], 'budget':{'wall_seconds':1200,'total_tokens':12000},'usage':{},'skill':None,'environment':{}}))
        (folder/'transcript.jsonl').write_text(json.dumps({'sequence':1,'event':'selftest','timestamp':'not-a-run','content':'Synthetic schema check'})+'\n')

    def test_executable_pass_and_fail(self):
        for case in FIXES:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                folder=Path(temp)
                self.submission(folder,case)
                (folder/'regression.cjs').write_text(REGRESSIONS[case])
                self.assertEqual(evaluate(case,folder)['status'],'automated_checks_failed')
                (folder/'index.cjs').write_text(FIXES[case])
                result=evaluate(case,folder)
                self.assertEqual(result['status'],'needs_human_review',result)
                self.assertIsNone(result['quality_score'])
                (folder/'regression.cjs').write_text('// vacuous regression\n')
                self.assertEqual(evaluate(case,folder)['status'],'automated_checks_failed')
                (folder/'regression.cjs').write_text('throw Error("always fails");\n')
                self.assertEqual(evaluate(case,folder)['status'],'automated_checks_failed')

    def test_plan_graph(self):
        validate_plan(PLAN)
        for kind in ('cycle','overlap','capacity','unknown','prerequisite'):
            p=copy.deepcopy(PLAN)
            if kind=='cycle': p['tasks'][0]['dependsOn']=['cli']
            if kind=='overlap':
                p['tasks'][2]['dependsOn']=['contract']
                p['tasks'][2]['paths']=['format.cjs']
            if kind=='capacity': p['sprint']['capacity']=9
            if kind=='unknown': p['tasks'][1]['dependsOn']=['missing']
            if kind=='prerequisite': p['sprint']['tasks']=['cli']
            with self.subTest(kind=kind), self.assertRaises(ValueError): validate_plan(p)
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp); self.submission(folder,'planning')
            (folder/'plan.md').write_text('Synthetic plan document')
            (folder/'plan.json').write_text(json.dumps(PLAN))
            self.assertEqual(evaluate('planning',folder)['status'],'needs_human_review')
            (folder/'plan.json').write_text('{')
            self.assertEqual(evaluate('planning',folder)['status'],'automated_checks_failed')

    def test_review_structure_and_known_defects(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp); self.submission(folder,'review')
            # Empty findings pass structure intentionally, never semantic grading.
            (folder/'review.json').write_text(json.dumps({'summary':'Schema test only','findings':[]}))
            self.assertEqual(evaluate('review',folder)['status'],'needs_human_review')
            (folder/'after.cjs').write_text('// unauthorized edit')
            self.assertEqual(evaluate('review',folder)['status'],'automated_checks_failed')
        script = '''const a=require('node:assert/strict'); const {list}=require('./after.cjs');
const rows=[{tenant:'A',deleted:false,updated:1},{tenant:'B',deleted:false,updated:3},{tenant:'A',deleted:true,updated:2}];
const original=rows.slice(); const result=list(rows,'A');
a.equal(result.length,3); a.notDeepEqual(rows,original);
const {list:before}=require('./before.cjs'); a.equal(before(original,'A').length,1);
'''
        p=subprocess.run(['node','-e',script],cwd=ROOT/'fixtures/review',capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr)

    def test_missing_submission(self):
        with tempfile.TemporaryDirectory() as temp:
            for case in ('planning','tdd','review','debugging'):
                self.assertEqual(evaluate(case,Path(temp))['status'],'automated_checks_failed')

if __name__=='__main__': unittest.main(verbosity=2)
