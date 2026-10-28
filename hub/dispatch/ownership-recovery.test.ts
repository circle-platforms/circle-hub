import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupOwned} from './testing/owned.ts';

for(const cause of ['uncertified','undeclared','unmatched']) {
  test(`C4.3 completed ownership diagnostics name an executable step for ${cause}`,async t=>{
    const c=await setupOwned({certified:cause!=='uncertified',declared:cause!=='undeclared',word:cause==='unmatched'?'none':'staging_directory',reason:cause==='unmatched'?'no_report':null});t.after(()=>c.close());
    const first=await c.service.dispatch(c.admin,c.run,c.executor.id);const report=await c.report(first.result!);
    assert.equal(report.rows[0].dynamic_terminal,'no_verdict');
    if(cause==='uncertified'){
      assert.equal(report.ownership.matched,true);
      assert.equal(report.rows[0].unmet_premises.find((row:{premise:string})=>row.premise==='result_ownership').premise,'result_ownership');
    }
    const next=report.rows[0].next_action;
    assert.doesNotMatch(next,/重读原作业/);
    assert.match(next,cause==='uncertified'?/认证/:cause==='undeclared'?/声明/:/归属|能力缺口/);
    assert.match(next,/src:[a-f0-9]{64}/);assert.ok(first.next_action);
    c.setWord('staging_directory');
    const after=await c.service.resume(c.admin,first.job);
    assert.equal(after.result,first.result);assert.equal(c.calls.filter(n=>n==='read_blob').length,1);
  });
}
