import assert from 'node:assert/strict';
import {sandboxTest,until} from './harness.ts';
import {meridianFlow,observedFlowWorker} from '../fixtures/meridian-flow.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {freezeProviderReceipt} from '../../packages/execution/src/flow-worker.ts';

for(const kind of ['submit','status','heartbeat'] as const)sandboxTest(`H2 provider refusal: ${kind} provenance preserves the accepted remote write`,async t=>{
 const {h,provider,submit}=await meridianFlow(t);if(kind==='submit')provider.state.refuse=true;else if(kind==='status')provider.state.refuseStatus=true;else{provider.state.hold=true;provider.state.refuseHeartbeat=true;provider.state.leaseTtl=0.15;}
 await h.startWorker();const task=await submit('h2-refusal-'+kind);await h.phase(task.taskId,kind==='submit'?'failed':'unknown',30_000);
 const write=(await h.db.query("SELECT o.*,s.remote_identity,s.intent FROM operations o JOIN flow_steps s USING(operation_id) WHERE o.task_id=$1 AND o.source_effect='write'",[task.taskId])).rows[0];assert.ok(write);assert.equal(write.intent,true);assert.equal(write.status,kind==='submit'?'failed':'unknown');assert.equal(provider.state.submissions,kind==='submit'?0:1);assert.equal(provider.state.releases,kind==='submit'?1:0);assert.equal(Boolean(write.remote_identity),kind!=='submit');assert.equal((await h.db.query('SELECT frozen FROM resources WHERE resource_id=$1',[write.resource_id])).rows[0].frozen,kind!=='submit');
 const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.error.code,'GATEWAY_REFUSED');const originals=[];for(const reference of [...result.evidence,...result.artifacts]){const response=await fetch(h.url+reference.downloadPath,{headers:{authorization:'Bearer '+await h.login()}});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha256(bytes),reference.sha256);try{const value=JSON.parse(bytes.toString());if(value.schema==='hub-provider-refusal/1')originals.push(value);}catch{}}
 assert.ok(originals.some(value=>value.tool===(kind==='submit'?'meridian_submit':kind==='status'?'meridian_status':'lease_heartbeat')&&value.phase===(kind==='submit'?'submit':'observe')&&value.refusal.ok===false&&value.refusal.dispatched===false));
 if(kind!=='submit'){await h.stop();await h.startServer();assert.equal((await h.status(task.taskId)).phase,'unknown');assert.equal(provider.state.submissions,1);assert.equal(provider.state.releases,0);}else await until(async()=>provider.state.releases===1);
});

sandboxTest('H2 C refusal gate: persisted submission defeats a worker claim and a fabricated submit refusal provenance',async t=>{
 const {h,provider,submit}=await meridianFlow(t);provider.state.refuseStatus=true;const observer=await observedFlowWorker(t,h),task=await submit('h2-persisted-identity');await h.phase(task.taskId,'unknown',30_000);await h.stop(observer.worker);
 const write=(await h.db.query("SELECT o.*,s.remote_identity FROM operations o JOIN flow_steps s USING(operation_id) WHERE o.task_id=$1 AND o.source_effect='write'",[task.taskId])).rows[0],original=observer.reports.find(item=>item.operationId===write.operation_id);assert.ok(original);assert.ok(write.remote_identity?.remoteId);
 const directory=h.scratch+'/objects';
 // This synthetic worker lies about both diagnostics and the rejected invocation.
 // C must still honor its separately persisted accepted remote identity.
 const pointer=await freezeProviderReceipt(new LocalObjects(directory),write.operation_id,'refusal',{schema:'hub-provider-refusal/1',tool:'meridian_submit',phase:'submit',refusal:{ok:false,stage:'validation',dispatched:false,reason:'Synthetic false pre-dispatch claim'}}),body={...original.body,status:'failed',output:{...original.body.output,gatewayRefusalPointer:pointer,remoteLeaseReleased:false},error:{...original.body.error,details:{submitted:false,refusalTool:'meridian_submit',refusalPhase:'submit'}}};
 await h.db.query("UPDATE operations SET status='running' WHERE operation_id=$1",[write.operation_id]);await h.db.query("INSERT INTO leases(tenant_id,resource_id,operation_id,worker_id,fencing_token,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')",[write.tenant_id,write.resource_id,write.operation_id,write.worker_id,write.fencing_token]);
 const result=await h.request(`/v1/workers/operations/${write.operation_id}/report`,body,'lab-east-01');assert.equal(result.status,'unknown');assert.equal((await h.db.query('SELECT status FROM operations WHERE operation_id=$1',[write.operation_id])).rows[0].status,'unknown');assert.equal((await h.db.query('SELECT frozen FROM resources WHERE resource_id=$1',[write.resource_id])).rows[0].frozen,true);assert.equal(provider.state.submissions,1);assert.equal(provider.state.releases,0);
});
