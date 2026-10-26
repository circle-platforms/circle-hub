import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {installReview,judgment,criterionRequests,revision} from './testing/criterion-review.ts';
import {PartitionItem} from '../../../contracts/src/validation.ts';
import {PARTITION} from '../../../contracts/generated/vocabulary.ts';
import {runById} from './store.ts';
test('every result partition accepts explicit replaced criteria',()=>{
 const replaced={criterion:'src:'+'a'.repeat(64),old:'旧',new:'新',declaration:'rec:'+'b'.repeat(64)+'#/criterion_changes/0',review:'rec:'+'c'.repeat(64),reviewer:'usr_01m5pndtg70000000000000001'};
 for(const partition of PARTITION){const row={item:'one',label:'合成条目',location:replaced.criterion,requirements:[],replaced_criteria:[replaced],...(partition==='rejected'?{code:'synthetic.blocked'}:{}),...(partition==='quarantined'||partition==='incomplete'?{reason:'missing_input'}:{})};assert.ok(PartitionItem[partition].safeParse(row).success,partition);}
});
test('revision results disclose replacement refs and preserve predecessor bytes, with rolling old values',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());await installReview(h);const draft=await h.start();await h.submit(draft.run,[h.proposal]);const original=(await h.service.getResult(h.alice,draft.run))!,bytes=JSON.stringify((await h.kit.store.get(original.record))!.body),request=(await criterionRequests(h,draft.run))[0],review=await judgment(h,draft.run,request);
 const first=await revision(h,draft.run);await h.submit(first.run,[]);const firstResult=(await h.service.getResult(h.alice,first.run))!,row=Object.values(firstResult.result.partitions).flat()[0];
 assert.deepEqual((row as any).replaced_criteria,[{criterion:h.expected,old:'旧判据',new:'新判据',declaration:'rec:'+request.source+'#/criterion_changes/0',review:'rec:'+review.record,reviewer:h.admin.id}]);assert.equal(JSON.stringify((await h.kit.store.get(original.record))!.body),bytes);
 const changed={...h.proposal,new:'再新判据'};await h.submit(first.run,[changed]);const nextRequest=(await criterionRequests(h,first.run))[0];await judgment(h,first.run,nextRequest);const second=await revision(h,first.run);await h.submit(second.run,[]);const secondResult=(await h.service.getResult(h.alice,second.run))!.result,nextRow=Object.values(secondResult.partitions).flat()[0];assert.equal((nextRow as any).replaced_criteria?.[0].old,'新判据');assert.equal((nextRow as any).replaced_criteria?.[0].new,'再新判据');assert.equal((await runById(h.kit.store,second.run))!.body.accepted_criteria?.length,1);assert.equal(JSON.stringify((await h.kit.store.get(original.record))!.body),bytes);
});
