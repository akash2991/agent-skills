'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const [kind, folder] = process.argv.slice(2);
const api = require(path.resolve(folder, 'index.cjs'));
async function main() {
  if (kind === 'tdd') {
    for (const [c,p,want] of [[1,50,1],[3,50,2],[101,25,76],[0,30,0],[999,0,999],[999,100,0],[1000000,1,990000],[1,51,0]]) {
      assert.equal(api.discount(c,p),want, `${c},${p}`);
    }
    for (const args of [[-1,5],[1,-1],[1,101],[1.5,20],[2,0.5],['1',50],[1,NaN],[Infinity,1],[1000001,0],[1,'50']]) {
      assert.throws(() => api.discount(...args), RangeError, JSON.stringify(args));
    }
  } else if (kind === 'debugging') {
    const calls = [];
    const load = api.createLoader(async (t,k) => { calls.push([t,k]); return JSON.stringify([t,k]); });
    assert.equal(await load('a:b','c'), '["a:b","c"]');
    assert.equal(await load('a','b:c'), '["a","b:c"]');
    assert.equal(await load('a:b','c'), '["a:b","c"]');
    assert.equal(calls.length,2);
    let tries = 0;
    const retry = api.createLoader(async () => { if (++tries === 1) throw new Error('transient'); return ''; });
    await assert.rejects(retry('t','k'), /transient/);
    assert.equal(await retry('t','k'),'');
    assert.equal(await retry('t','k'),'');
    assert.equal(tries,2);
    let count = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const concurrent = api.createLoader(async () => { count++; return pending; });
    const first = concurrent('tenant','key');
    const second = concurrent('tenant','key');
    await Promise.resolve();
    assert.equal(count,1);
    release(0);
    assert.deepEqual(await Promise.all([first,second]), [0,0]);
    assert.equal(await concurrent('tenant','key'),0);
    assert.equal(count,1);
    for (const value of [false, null, undefined]) {
      let n = 0;
      const empty = api.createLoader(async () => { n++; return value; });
      assert.equal(await empty('',''),value);
      assert.equal(await empty('',''),value);
      assert.equal(n,1);
    }
  } else throw new Error('Unknown executable case');
  console.log('acceptance assertions passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
