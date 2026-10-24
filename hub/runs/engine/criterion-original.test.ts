import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
test('pending declarations do not replace the criterion used by the current run check',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const run=await h.start();
 const answer=await h.submit(run.run,[h.proposal]);assert.equal(answer.acceptance,'accepted');const result=(await h.service.getResult(h.alice,run.run))!.result;const row=Object.values(result.partitions).flat()[0];
 assert.notEqual(row.requirements[0].status,'satisfied');assert.equal(row.requirements[0].layers[0].terminal,'violation',JSON.stringify(result));assert.equal(row.requirements[0].claims.find(claim=>claim.warrant.producer==='function')?.statement.data?.used_criterion,'旧判据');
});
