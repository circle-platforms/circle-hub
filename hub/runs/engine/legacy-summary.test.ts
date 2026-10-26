import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RunRecord} from '../../../contracts/src/run.ts';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import {RecordsError} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {summaryOf} from './start.ts';
import {createRunsService} from './service.ts';
import {putRun} from './store.ts';
import {receivedDigest} from './util.ts';
const oldBody=()=>{
 const body=RunRecord.parse({...runRecord,pack:'synthetic@10.6.0',product:'synthetic',version:'10.6',build:'SYNTHETIC_10_6_0'});
 for(const row of body.requirements){delete (row as Partial<typeof row>).rules;delete (row as Partial<typeof row>).run_interpreters;}
 return body;
};
const workflow={pack:{id:'synthetic',version:'10.6.0',digest:runRecord.pack_digest,kind:'workflow',directory:'synthetic'},requirements:[{key:'structure',name:'合成要求',description:'合成',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['c'],error_handling:[],run_table:true}],checks:[{id:'c',interpreter:'structure@1',table:'tables/synthetic.json',applies:'item',judges:'subject'}],ledger:{schema:'ledger@1',shapes:[{requirement:'structure',interpreter:'range@1',ruled_in:'10.6.0'}]}} satisfies Pick<LoadedWorkflow,'pack'|'requirements'|'checks'|'ledger'>;
test('legacy public summaries derive rulings from the locked package without editing the record',()=>{
 const body=oldBody(),before=JSON.stringify(body);
 const result=summaryOf(body,workflow);
 assert.deepEqual(result.requirements[0].rules,['structure@1']);
 assert.deepEqual(result.requirements[0].run_interpreters,['range@1']);
 assert.equal(JSON.stringify(body),before);
 assert.throws(()=>summaryOf(body,{...workflow,pack:{...workflow.pack,digest:'f'.repeat(64)}}),error=>error instanceof RecordsError && error.code==='SOURCE_UNAVAILABLE');
 assert.throws(()=>summaryOf(body),error=>error instanceof RecordsError && error.code==='SOURCE_UNAVAILABLE' && Boolean(error.fix));
});
test('stored legacy runs support reading, listing and idempotent reuse, and missing locked packages are unavailable',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());
 const reference=await h.upload(h.alice,new TextEncoder().encode('synthetic history'));
 const input={pack:h.review.pack.id,product:'synthetic',version:'10.6',inputs:{map:{reference}},client_key:'synthetic-history'};
 const body={...oldBody(),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,request_digest:receivedDigest(input).digest,client_key:input.client_key,client_key_expires_at:'2026-12-01T00:00:00Z'};
 const stored=await putRun(h.kit.store,body,'2026-10-22T08:00:00.000Z');
 const detail=await h.service.getRun(h.alice,body.run);
 assert.deepEqual(detail!.run.requirements[0].rules,['structure@1']);
 const listed=await h.service.listRuns(h.alice);
 assert.deepEqual(listed.items[0].requirements[0].rules,['structure@1']);
 const reused=await h.service.startRunDetailed(h.alice,input,h.call('synthetic-history'));
 assert.equal(reused.answer.call_result,'ok',JSON.stringify(reused.answer.errors));
 assert.equal(reused.runRecord,stored.digest);
 assert.deepEqual(reused.answer.run!.requirements[0].rules,['structure@1']);
 const original=await h.kit.store.get<RunRecord>(stored.digest);
 assert.deepEqual(original!.body,body);
 assert.equal(original!.body.requirements[0].rules,undefined);
 const missing=createRunsService({now:()=>new Date('2026-10-22T08:00:00.000Z'),records:h.kit,workflows:{forUser:async()=>null,byDigest:async()=>null,summaries:async()=>[]},packs:h.packs,knowledge:h.knowledge,external:h.external});
 await assert.rejects(missing.getRun(h.alice,body.run),error=>error instanceof RecordsError && error.code==='SOURCE_UNAVAILABLE' && Boolean(error.fix));
 const refused=await missing.startRun(h.alice,input,h.call('synthetic-history'));
 assert.equal(refused.call_result,'error');assert.equal(refused.errors[0].code,'SOURCE_UNAVAILABLE');assert.equal(refused.errors[0].fix,'请管理员从备份恢复该运行锁定的任务包原件，再重新读取或复用运行');
});
