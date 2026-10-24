import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
test('criterion role rejection leaves the submitted draft and its original checks accepted',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());
 const run=await h.start();const answer=await h.submit(run.run,[{...h.proposal,criterion:h.subject+'/json@1/p/value'},h.proposal]);
 assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
 assert.ok(answer.errors.some(e=>e.code==='core.criterion.source_role_mismatch'&&e.path==='/criterion_changes/0'));
 const result=await h.service.getResult(h.alice,run.run);assert.ok(result);
 assert.ok(Object.values(result.result.partitions).flat().some(item=>item.requirements.some(requirement=>requirement.status!=='satisfied')));
});
test('criterion exact errors and unprojected items reject the entire submission without replacing the old text',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());
 const run=await h.start();
 for(const patch of [{old:'伪造旧值'},{grounds:[{reference:h.expected,quote:'不逐字'}]},{criterion:'src:'+'c'.repeat(64)},{item:'absent'}]){
  const answer=await h.submit(run.run,[{...h.proposal,...patch}]);assert.equal(answer.acceptance,'not_accepted',JSON.stringify(answer));
  assert.ok(answer.errors.some(e=>e.path?.startsWith('/criterion_changes/0')));
 }
});
