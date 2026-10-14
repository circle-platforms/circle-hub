import assert from 'node:assert/strict';
import {sandboxTest,until} from './harness.ts';
import {meridianFlow,meridianModule} from '../fixtures/meridian-flow.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {executeFlowStep} from '../../packages/execution/src/flow-worker.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {Store} from '../../packages/storage/src/index.ts';
import {Auth} from '../../packages/tasks/src/auth.ts';
import {Tasks} from '../../packages/tasks/src/index.ts';
import {Approvals} from '../../packages/tasks/src/approvals.ts';
import {ChangeSets} from '../../packages/tasks/src/change-sets.ts';
import {ServiceClients} from '../../packages/tasks/src/service-clients.ts';
import {Assets} from '../../packages/assets/src/index.ts';
import {Records} from '../../packages/knowledge/src/records.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {KnowledgeGraph} from '../../packages/knowledge/src/graph.ts';
import {Entities} from '../../packages/knowledge/src/entities.ts';
import {TypeCatalog} from '../../packages/knowledge/src/type-catalog.ts';
import {SourceArtifacts} from '../../packages/knowledge/src/source-artifacts.ts';
import {ProductModules} from '../../packages/methods/src/product-modules.ts';
import {ToolProviders} from '../../packages/methods/src/providers.ts';
import {Operations} from '../../packages/execution/src/operations.ts';
import {ExecutionChanges} from '../../packages/execution/src/governance.ts';

// Real C services over the test-owned PostgreSQL and object store. No SQL,
// authorization or Hook decision is mocked by the evaluation barrier below.
function direct(h:any,endpoint:string){
 const store=Object.create(Store.prototype) as Store;store.pool=h.db;const auth=new Auth(store),tasks=new Tasks(store,auth),knowledge=new Records(store,auth,new LocalObjects(h.env.CIRCLE_HUB_DATA_DIR)),assets=new Assets(store,auth,h.env.CIRCLE_HUB_DATA_DIR+'/private-credentials'),graph=new KnowledgeGraph(store,auth,knowledge),objectTypes=new TypeCatalog(store,auth),entities=new Entities(store,auth,knowledge,objectTypes),sourceArtifacts=new SourceArtifacts(store,auth,assets,knowledge,graph),productModules=new ProductModules(sourceArtifacts),methods=new ToolProviders(assets);methods.products=productModules;
 knowledge.sourceAccess=async(ctx,id,tx,pin)=>{await entities.checkSourceAccess(ctx,id,tx);await graph.checkSourceAccess(ctx,id,tx,pin);};const execution=new Operations(store,auth,tasks,knowledge),approvals=new Approvals(store,auth,tasks),changes=new ChangeSets(store,auth,assets,tasks,approvals),executionChanges=new ExecutionChanges(assets,changes,execution,tasks),serviceClients=new ServiceClients(store,auth,assets),flow=new ExecutionFlows({store,auth,tasks,knowledge,assets,graph,objectTypes,entities,sourceArtifacts,productModules,methods,execution,approvals,changes,executionChanges,serviceClients},{fixture:{endpoint,pollMs:25}});
 return flow as any;
}

sandboxTest('Dispatch Hook evaluation holds no database row locks and a governed role revocation rejects its later proof commit',async t=>{
 const f=await meridianFlow(t),fixture=await meridianModule('6.0.0'),manifestFile=fixture.files.find(file=>file.path==='product-line.json')!,manifest=JSON.parse(Buffer.from(manifestFile.base64,'base64').toString());manifest.hooks=manifest.hooks.filter((hook:any)=>hook.event==='beforeDispatch');assert.equal(manifest.hooks.length,1);manifestFile.base64=Buffer.from(JSON.stringify(manifest)).toString('base64');const transition=fixture.files.find(file=>file.path==='tools/transition.ts')!;transition.base64=Buffer.from("export function transition(){return {schema:'hub-execution-transition/1',state:{stage:'submitted'},actions:[{kind:'provider.call',stepId:'dispatch',occurrence:0,resource:'gateway',tool:'meridian_submit',args:{label:'synthetic'},byteArgs:{payload_b64:'request'}}]};}").toString('base64');for(const file of fixture.files)file.sha256=sha256(Buffer.from(file.base64,'base64'));fixture.module.files=fixture.files.map(({path,sha256})=>({path,sha256}));fixture.module.digest=sha256(fixture.files.map(file=>`${file.sha256}  ${file.path}\n`).join(''));
 const installed=await f.h.raw('/v1/modules/install',{token:await f.h.login(),headers:{'x-scope-id':'scp_lab'},body:fixture});assert.equal(installed.status,201,JSON.stringify(installed.body));const method=installed.body.data;await f.h.request(`/v1/assets/${method.assetId}/lifecycle`,{version:method.assetVersion,sha256:method.assetSha256,state:'approved'},'bob');await f.h.request('/v1/workers/register',{capabilities:['flow.invoke']},'lab-east-01');const task=await f.submit('hook-without-row-locks','normal',method),first=await until(()=>f.h.request('/v1/workers/claim',{},'lab-east-01'),30_000);
 // Execute the approved transition with the actual worker implementation and
 // isolated Tool host; this is not a manufactured worker transition receipt.
 const report=await executeFlowStep(first,{check:()=>f.h.request(`/v1/workers/operations/${first.operationId}/preflight`,{fencingToken:first.fencingToken},'lab-east-01'),event:event=>f.h.request(`/v1/workers/operations/${first.operationId}/events`,{fencingToken:first.fencingToken,inputRevisionId:first.inputRevisionId,event},'lab-east-01'),signal:new AbortController().signal,directory:f.h.env.CIRCLE_HUB_DATA_DIR!});assert.equal(report.status,'succeeded');await f.h.request(`/v1/workers/operations/${first.operationId}/report`,report,'lab-east-01');const claim=await until(()=>f.h.request('/v1/workers/claim',{},'lab-east-01'),30_000),before=(await f.h.db.query('SELECT before_dispatch_ref,intent FROM flow_steps WHERE operation_id=$1',[claim.operationId])).rows[0];assert.equal(before.before_dispatch_ref,null);assert.equal(before.intent,false);
 const flow=direct(f.h,f.provider.endpoint),identity=(await f.h.db.query("SELECT principal_id FROM policies WHERE worker_id='lab-east-01'")).rows[0],worker={principalId:identity.principal_id,tenantId:'tnt_lab',kind:'worker',workerId:'lab-east-01'};assert.equal(typeof flow.evaluateDispatchHook,'function');const evaluate=flow.evaluateDispatchHook.bind(flow);let enter!:()=>void,release!:()=>void,completed=false,failure:any,decisions:any;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});flow.evaluateDispatchHook=async(work:any)=>{enter();await gate;decisions=await evaluate(work);return decisions;};
 const check=flow.fullCheck(worker,claim.operationId,claim.fencingToken).then(()=>{completed=true;},(error:any)=>{failure=error;completed=true;});
 try{
  await Promise.race([entered,check.then(()=>{throw new Error('The real C Hook evaluator was not reached');})]);
  // NOWAIT is an observation of real PostgreSQL row locks. Retry only a
  // transient collision with the independent scheduler, never a timed sleep
  // offered as evidence that the Hook released its locks.
  await until(async()=>{const connection=await f.h.db.connect();try{await connection.query('BEGIN');for(const [sql,args]of [
   ['SELECT task_id FROM tasks WHERE task_id=$1 FOR UPDATE NOWAIT',[task.taskId]],
   ['SELECT task_id FROM flow_runs WHERE task_id=$1 FOR UPDATE NOWAIT',[task.taskId]],
   ['SELECT operation_id FROM operations WHERE task_id=$1 ORDER BY operation_id FOR UPDATE NOWAIT',[task.taskId]],
   ['SELECT step_key FROM flow_steps WHERE task_id=$1 ORDER BY step_key FOR UPDATE NOWAIT',[task.taskId]],
   ['SELECT resource_id FROM resources WHERE tenant_id=$1 AND resource_id=ANY($2::text[]) ORDER BY resource_id FOR UPDATE NOWAIT',['tnt_lab',[`flow:${task.taskId}`,`provider:${f.resource.assetId}`]]],
   ['SELECT operation_id FROM leases WHERE operation_id=$1 FOR UPDATE NOWAIT',[claim.operationId]],
   ['SELECT * FROM event_clock FOR UPDATE NOWAIT',[]],
  ] as [string,any[]][]){const result=await connection.query(sql,args);assert.ok(result.rowCount,'The barrier must lock real existing rows');}await connection.query('ROLLBACK');return true;}catch(error){await connection.query('ROLLBACK');if((error as any).code==='55P03')return false;throw error;}finally{connection.release();}},10_000);assert.equal(completed,false);
  const change=await f.h.request('/v1/scopes/scp_lab/roles',{principalId:'prn_alice',role:'viewer',idempotencyKey:'revoke-hook-caller-role'}),approval=(await f.h.request(`/v1/tasks/${change.approvalTaskId}/approvals`,undefined,'bob'))[0];await f.h.request(`/v1/tasks/${change.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');assert.equal((await f.h.request('/v1/scopes/scp_lab/roles',undefined,'bob')).items.find((row:any)=>row.principalId==='prn_alice').role,'viewer');assert.equal(completed,false);
 }finally{release();await check;}
 assert.ok(decisions?.length,'The wrapper must return real approved Hook decisions');assert.equal(failure?.code,'FORBIDDEN_ACTION');const after=(await f.h.db.query('SELECT before_dispatch_ref,intent FROM flow_steps WHERE operation_id=$1',[claim.operationId])).rows[0];assert.equal(after.before_dispatch_ref,null);assert.equal(after.intent,false);assert.equal(f.provider.state.calls.length,0);assert.equal(f.provider.state.submissions,0);assert.ok(!(await f.h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);
});
