import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupOwned} from './testing/owned.ts';
for(const reason of ['ambiguous_reports','',false]) {
  test(`C4.4 a positive attribution cannot coexist with a non-null reason ${JSON.stringify(reason)}`,async t=>{
    const c=await setupOwned({reason});t.after(()=>c.close());
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const report=await c.report(state.result!);
    assert.equal(report.rows[0].dynamic_terminal,'no_verdict');assert.ok(report.rows[0].missing_facts.includes('owned'));
    assert.equal(report.ownership.matched,true);assert.equal(report.ownership.reason,reason);
    assert.match(report.rows[0].missing_fact,/矛盾/);assert.match(report.rows[0].next_action,/协议|矛盾/);
  });
}
