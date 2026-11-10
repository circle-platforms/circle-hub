import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,runRecord} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {putRun,putResult} from './store.ts';

let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());

const AT=(body:RunRecord)=>new Date(body.started_at).toISOString();

test('run visibility answers like the detail read without loading any result history',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'visibility-probe'});
 const stored=await putRun(h.kit.store,body,AT(body));
 const result=ValidationResult.parse({...accepted,run:body.run,submission:stored.digest,cross_item:[],partitions:{delivered:[],rejected:[],incomplete:[],quarantined:[]}});
 await putResult(h.kit.store,result,AT(body));
 const HISTORY=24;
 for(let n=0;n<HISTORY;n++)await putResult(h.kit.store,{...result,submission:n.toString(16).padStart(64,'0'),acceptance:'not_accepted',errors:[{code:'CHECK_ERROR',message:'synthetic historical body '+String(n)+'x'.repeat(64*1024),fix:'synthetic recovery'}]},AT(body));

 // Count the validation_result bodies any index read hands back while `read` runs.
 const find=h.kit.store.find.bind(h.kit.store),findBatch=h.kit.store.findBatch!.bind(h.kit.store);
 const loaded=async<T>(read:()=>Promise<T>):Promise<{value:T;bodies:number}>=>{
  let bodies=0;
  h.kit.store.find=(async(...args:Parameters<typeof find>)=>{const page=await find(...args);for(const record of page.items)if(record.kind==='validation_result')bodies++;return page;}) as typeof find;
  h.kit.store.findBatch=(async(...args:Parameters<typeof findBatch>)=>{const pages=await findBatch(...args);for(const page of pages)for(const record of page.items)if(record.kind==='validation_result')bodies++;return pages;}) as typeof findBatch;
  try{return {value:await read(),bodies};}finally{h.kit.store.find=find;h.kit.store.findBatch=findBatch;}
 };

 const control=await loaded(()=>h.service.getRun(h.alice,body.run));
 assert.ok(control.value,'the owner sees the run');
 assert.ok(control.bodies>=HISTORY,'control: the full detail read does load the history ('+control.bodies+' bodies)');

 const probe=await loaded(()=>h.service.runVisible!(h.alice,body.run));
 assert.equal(probe.value,true);
 assert.equal(probe.bodies,0,'a visibility answer must not load result bodies');

 // The verdict equals "the detail read answered" for every reader, before and after a share, and for a run that does not exist.
 const same=async(by:typeof h.alice,run:string)=>{
  const detail=await h.service.getRun(by,run)!==null,visible=await h.service.runVisible!(by,run);
  assert.equal(visible,detail,`reader ${by.id} run ${run}`);return visible;
 };
 assert.equal(await same(h.alice,body.run),true);
 assert.equal(await same(h.admin,body.run),true);
 assert.equal(await same(h.bob,body.run),false,'an unshared run is invisible, exactly like the neutral detail answer');
 await h.kit.authorizations.share(h.admin,body.run,[h.bob.id]);
 assert.equal(await same(h.bob,body.run),true,'a shared run becomes visible');
 await h.kit.authorizations.unshare(h.admin,body.run,h.bob.id);
 assert.equal(await same(h.bob,body.run),false,'revoking the share is seen at once; no verdict is kept in the engine');
 assert.equal(await same(h.alice,newId('run')),false,'an absent run is invisible');
});
