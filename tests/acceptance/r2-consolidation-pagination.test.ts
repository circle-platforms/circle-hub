import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,until,type Harness} from './harness.ts';

async function prepare(h:Harness){
  const grants=['assets.read','assets.register','assets.change','assets.approve','knowledge.read','knowledge.ingest','knowledge.submit'];
  await h.db.query('UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id=ANY($2::text[])',[JSON.stringify(grants),['prn_alice','prn_bob']]);
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic shared fragment source',version:'1.0.0',declaration:{reads:['knowledge'],writes:['knowledge-candidates'],credentials:[]},configuration:{packageId:'knowledge'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});
  return asset;
}
async function source(h:Harness,index:number,count=1,username='alice'){
  const fragments=Array.from({length:count},(_,offset)=>({id:`fragment-${index}-${offset}`,kind:'fact',quote:`Synthetic observation ${index}-${offset}`,subject:`synthetic-${index}-${offset}`,predicate:'observed',value:true,toolReturn:{observed:true}})),bytes=Buffer.from(JSON.stringify({fragments}));
  return h.request('/v1/knowledge/sources',{scopeId:'scp_lab',sourceId:`synthetic-session-${index}`,revision:'r1',path:`synthetic/session-${index}.json`,knowledgeCategory:'consolidated',sourceType:'shared-session',parserVersion:'fixture/1',contentBase64:bytes.toString('base64'),sha256:sha256(bytes),acl:{sourceReaders:[`prn_${username}`],platformReaders:[`prn_${username}`]},sharing:{allowed:true,teamPromotion:false}},username);
}
const call=(h:Harness,args:unknown={},key=randomBytes(12).toString('hex'))=>h.request('/v1/tools/knowledge.shared_fragments/call',{args,idempotencyKey:key});

test('Act R2.6 regression: shared fragments page across sources and within a source without wedging the resource',async t=>{
  const h=await setup(t);await prepare(h);
  for(let index=0;index<21;index++)await source(h,index);
  await source(h,99,3,'bob');await h.startWorker();
  const controller=new AbortController();t.after(()=>controller.abort());
  const pending=fetch(`${h.url}/v1/tools/knowledge.shared_fragments/call`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'content-type':'application/json'},body:JSON.stringify({args:{},idempotencyKey:'first-page'}),signal:controller.signal}).catch(()=>undefined);
  await until(async()=>Number((await h.db.query('SELECT count(*) AS n FROM operations')).rows[0].n)>0);
  await until(async()=>(await h.db.query('SELECT status FROM operations ORDER BY created_at LIMIT 1')).rows[0].status==='succeeded',2000);
  assert.equal((await h.db.query('SELECT status FROM operations ORDER BY created_at LIMIT 1')).rows[0].status,'succeeded','A page of 20 must succeed even when more shared fragments exist');
  const response=await pending;assert.ok(response);assert.equal(response.status,200);const first=(await response.json() as any).data;
  assert.equal(first.result.fragments.length,20);assert.equal(typeof first.result.nextCursor,'string');
  assert.deepEqual(await call(h,{},'first-page'),first,'Idempotent replay must return the same page and cursor');
  await h.reject('/v1/tools/knowledge.shared_fragments/call',{args:{after:first.result.nextCursor},idempotencyKey:'foreign-cursor'},'INVALID_PAYLOAD','bob');
  assert.equal((await h.request('/v1/tools/knowledge.shared_fragments/call',{args:{},idempotencyKey:'bob-own-page'},'bob')).result.fragments.length,3);
  await h.reject('/v1/tools/knowledge.shared_fragments/call',{args:{after:'invalid-cursor'},idempotencyKey:'invalid-cursor'},'INVALID_PAYLOAD');
  await h.stop();await h.startServer();await h.startWorker();
  const second=await call(h,{after:first.result.nextCursor});assert.equal(second.result.fragments.length,1);assert.equal(second.result.nextCursor,null);
  const ids=[...first.result.fragments,...second.result.fragments].map((fragment:any)=>fragment.id);assert.equal(new Set(ids).size,21);assert.ok(ids.every((id:string)=>!id.startsWith('fragment-99')));
  await source(h,22,23);const third=await call(h,{after:first.result.nextCursor});assert.equal(third.result.fragments.length,20);assert.ok(third.result.nextCursor);
  const fourth=await call(h,{after:third.result.nextCursor});assert.equal(fourth.result.fragments.length,4);assert.equal(fourth.result.nextCursor,null);assert.equal(new Set([...third.result.fragments,...fourth.result.fragments].map((fragment:any)=>fragment.id)).size,24);
  for(const limit of [0,101])await h.reject('/v1/tools/knowledge.shared_fragments/call',{args:{limit},idempotencyKey:`limit-${limit}`},'INVALID_PAYLOAD');
});

test('Act R2.6 regression: report validation failures commit a failed operation release its lease and allow the next call',async t=>{
  const h=await setup(t);await prepare(h);const original=await source(h,1),evidence=await h.request('/v1/knowledge/evidence',{sourceRecordId:original.recordId,start:0,end:(await h.request(`/v1/knowledge/records/${original.recordId}`)).payload.raw.size});
  await h.startWorker();const input={claim:{subject:'synthetic-report-failure',predicate:'observed',value:true},evidence:[{evidenceId:evidence.recordId,sha256:'0'.repeat(64)}]};
  const accepted=await h.request('/v1/tools/knowledge.claim_submit/call',{args:input,idempotencyKey:'invalid-evidence'});
  const task=await until(async()=>{const state=await h.status(accepted.taskId);return state.phase==='failed'?state:false;},2000);
  const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.error.code,'SOURCE_HASH_MISMATCH');
  const operation=(await h.db.query('SELECT * FROM operations WHERE task_id=$1',[task.taskId])).rows[0];assert.equal(operation.status,'failed');assert.equal(operation.result.error.code,'SOURCE_HASH_MISMATCH');assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM leases WHERE operation_id=$1',[operation.operation_id])).rows[0].n),0);
  const replay=await h.request(`/v1/workers/operations/${operation.operation_id}/report`,{fencingToken:Number(operation.fencing_token),inputRevisionId:operation.input_revision_id,status:'succeeded',output:{result:operation.args.input,sourceType:'skill-run',raw:[]}},'lab-east-01');assert.equal(replay.deduplicated,true,'An identical rejected receipt remains idempotent after its lease is removed');
  assert.equal(Number((await h.db.query("SELECT count(*) AS n FROM knowledge_records WHERE kind='Claim'")).rows[0].n),0,'Rejected receipt must not leave partial knowledge writes');
  const valid=await h.request('/v1/tools/knowledge.claim_submit/call',{args:{...input,evidence:[{evidenceId:evidence.recordId,sha256:evidence.sha256}]},idempotencyKey:'valid-after-failure'});await h.phase(valid.taskId,'delivered');
  assert.equal((await h.request(`/v1/tasks/${valid.taskId}/result`)).result.state,'candidate');
});
