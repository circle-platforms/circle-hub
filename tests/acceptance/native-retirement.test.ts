import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setup} from './harness.ts';
import {sha256,canonicalHash,newId} from '../../packages/contracts/src/index.ts';
import {caseExecutionMigration} from '../../packs/apv/runtime/execution-history-migration.ts';
import {executionHistoryReadonlyMigration} from '../../packs/apv/runtime/execution-history-readonly-migration.ts';
import {assertNativeRetired} from '../fixtures/native-retirement.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {compileMindmap} from '../../packs/apv/methods/mindmap.ts';

test('Retired native capability is absent and old submissions never create an operation',async t=>{
 const h=await setup(t);await assertNativeRetired();
 const packs=await h.request('/v1/packs');
 assert.ok(!packs.some((pack:any)=>pack.capabilityPackId==='apv-case-execute'));
 assert.ok(packs.some((pack:any)=>pack.capabilityPackId==='module-execute'));
 await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:'retired-native-submit',input:{}},'UNSUPPORTED_VERSION');
 assert.equal((await h.db.query("SELECT count(*)::int AS n FROM operations WHERE name LIKE 'cases.%'")).rows[0].n,0);
});

test('Retirement preserves deployed migration bytes and existing receipts while rejecting every write',async t=>{
 const h=await setup(t);
 assert.equal(sha256(await readFile(new URL('../../packs/apv/runtime/execution-history-migration.ts',import.meta.url))),'a0ecdc4f68088cfc45d696a258fe324c99fb1ef20ed133752dabec916fb14fa7');
 const journal=(await h.db.query('SELECT version,sha256 FROM schema_migrations WHERE version IN (20,44) ORDER BY version')).rows;
 assert.deepEqual(journal,[{version:20,sha256:sha256(caseExecutionMigration.sql)},{version:44,sha256:sha256(executionHistoryReadonlyMigration.sql)}]);
 // A separate synthetic schema starts with migration 20 and a real prior receipt;
 // applying the same new migration proves upgrade preservation, not only fresh DDL.
 const db=await h.db.connect();
 try{
  await db.query('CREATE SCHEMA retirement_fixture');await db.query('SET search_path TO retirement_fixture');
  await db.query('CREATE TABLE operations(operation_id text PRIMARY KEY)');await db.query(caseExecutionMigration.sql);
  await db.query("INSERT INTO operations VALUES('op_synthetic_history')");
  await db.query("INSERT INTO case_gateway_receipts(operation_id,input_revision_id,workbook_sha256,gateway_task_id,receipt) VALUES('op_synthetic_history','inrev_synthetic_history',$1,'synthetic-remote-history',$2)",['a'.repeat(64),{task_id:'synthetic-remote-history',sha256:'a'.repeat(64)}]);
  const before=(await db.query('SELECT * FROM case_gateway_receipts')).rows;
  await db.query(executionHistoryReadonlyMigration.sql);
  for(const sql of ['UPDATE case_gateway_receipts SET submit_intent=true','DELETE FROM case_gateway_receipts','TRUNCATE case_gateway_receipts',"INSERT INTO case_gateway_receipts(operation_id,input_revision_id,workbook_sha256) VALUES('new','new','new')"])
   await assert.rejects(db.query(sql),(error:any)=>error.code==='25006');
  assert.deepEqual((await db.query('SELECT * FROM case_gateway_receipts')).rows,before);
 }finally{await db.query('RESET search_path');db.release();}
});

test('Seeded terminal native history remains readable across restart without changing its input or result',async t=>{
 const h=await setup(t),history:any[]=[];
 for(const phase of ['delivered','failed']){
  const task=await h.submit({methodAssetId:'ast_'+'a'.repeat(32),origin:'synthetic historical fixture'},'scp_lab','retired-history-'+phase);
  const bytes=Buffer.from('Synthetic immutable native '+phase),digest=sha256(bytes),artifactId=newId('art');
  await new LocalObjects(h.scratch+'/objects').putObject({Bucket:'evidence',Key:digest,Body:bytes});
  const owner=(await h.db.query('SELECT tenant_id,scope_id FROM tasks WHERE task_id=$1',[task.taskId])).rows[0];
  await h.db.query('INSERT INTO artifacts(artifact_id,tenant_id,scope_id,compilation_key,sha256,size,object_key,file_name,media_type,metadata) VALUES($1,$2,$3,$4,$5,$6,$5,$7,$8,$9)',[artifactId,owner.tenant_id,owner.scope_id,'synthetic-retired-'+phase,digest,bytes.length,'history.txt','text/plain',{}]);
  await h.db.query('INSERT INTO artifact_bindings(task_id,input_revision_id,artifact_id,role) VALUES($1,$2,$3,$4)',[task.taskId,task.inputRevisionId,artifactId,'native-history']);
  const reference={artifactId,sha256:digest,size:bytes.length,fileName:'history.txt',mediaType:'text/plain',downloadPath:`/v1/artifacts/${artifactId}/content`};
  const result:any={artifacts:[reference],evidence:[],unmapped:[]};
  if(phase==='delivered')result.result={synthetic:true,originalMethod:'1.1.1'};
  else result.error={code:'GATEWAY_REFUSED',message:'Synthetic historical refusal',details:{synthetic:true}};
  await h.db.query("UPDATE tasks SET capability_pack_id='apv-case-execute',pack_version='1.1.1',flow_version='apv-case-execute/1',phase=$2,stage='done',result_status=$3,result=$4 WHERE task_id=$1",[task.taskId,phase,phase==='delivered'?'succeeded':'failed',JSON.stringify(result)]);
  const snapshot=(await h.db.query('SELECT input_revision_id,input,pack_version,flow_version,result FROM tasks WHERE task_id=$1',[task.taskId])).rows[0];
  history.push({task,phase,result,bytes,before:canonicalHash(snapshot)});
 }
 const check=async()=>{for(const {task,phase,result,bytes,before} of history){
  const status=await h.status(task.taskId),read=await h.request(`/v1/tasks/${task.taskId}/result`);
  assert.equal(status.packVersion,'1.1.1');assert.equal(status.phase,phase);
  assert.deepEqual(read.artifacts,result.artifacts);
  const downloaded=await fetch(h.url+read.artifacts[0].downloadPath,{headers:{authorization:'Bearer '+await h.login()}});assert.equal(downloaded.status,200);const original=Buffer.from(await downloaded.arrayBuffer());assert.deepEqual(original,bytes);assert.equal(sha256(original),read.artifacts[0].sha256);
  if(phase==='delivered')assert.deepEqual(read.result,result.result);else assert.deepEqual(read.error,result.error);
  assert.equal(canonicalHash((await h.db.query('SELECT input_revision_id,input,pack_version,flow_version,result FROM tasks WHERE task_id=$1',[task.taskId])).rows[0]),before);
 }};
 await check();
 await h.stop();await h.startServer();
 await check();
});

test('Compiler version upgrade refuses old queued work without rebinding it and current work still delivers',async t=>{
 const h=await setup(t),bytes=Buffer.from(JSON.stringify([{rootTopic:{title:'Synthetic root',children:{attached:[{title:'Synthetic case'}]}}}]));
 const source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'synthetic.json',contentBase64:bytes.toString('base64')});
 const submit=(key:string)=>h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'mindmap-compile',idempotencyKey:key,input:{sourceRevisionId:source.sourceRevisionId}});
 const old=await submit('compiler-old-fixture');await h.phase(old.taskId,'waiting-resource');
 const inputBefore=canonicalHash((await h.status(old.taskId)).input);await h.stop();
 await h.db.query("UPDATE tasks SET pack_version='1.0.0' WHERE task_id=$1",[old.taskId]);
 await h.startServer();await h.phase(old.taskId,'failed');
 assert.equal((await h.request(`/v1/tasks/${old.taskId}/result`)).error.code,'UNSUPPORTED_VERSION');
 assert.equal((await h.status(old.taskId)).packVersion,'1.0.0');
 assert.equal(canonicalHash((await h.status(old.taskId)).input),inputBefore);
 assert.equal((await h.db.query("SELECT count(*)::int AS n FROM operations WHERE task_id=$1 AND status='accepted'",[old.taskId])).rows[0].n,0);
 await h.startWorker();const current=await submit('compiler-current-version');await h.phase(current.taskId,'delivered',30_000);
 assert.equal((await h.status(current.taskId)).packVersion,'1.1.0');
 const artifacts=(await h.request(`/v1/tasks/${current.taskId}/result`)).artifacts;assert.equal(artifacts.length,1);
});

test('An old compiler task cancelled before dispatch remains cancelled across the version boundary',async t=>{
 const h=await setup(t),source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'synthetic.json',contentBase64:Buffer.from('{"title":"Synthetic cancel fixture"}').toString('base64')});
 const task=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'mindmap-compile',idempotencyKey:'old-compiler-cancel',input:{sourceRevisionId:source.sourceRevisionId}});
 await h.stop();
 await h.db.query("UPDATE tasks SET pack_version='1.0.0',phase='running',stage='inspect',cancel_requested=true WHERE task_id=$1",[task.taskId]);
 await h.startServer();await h.phase(task.taskId,'cancelled');
 assert.equal((await h.status(task.taskId)).packVersion,'1.0.0');
 assert.equal((await h.db.query("SELECT count(*)::int AS n FROM operations WHERE task_id=$1 AND status='running'",[task.taskId])).rows[0].n,0);
});

test('Only a compiler-capable worker can claim or report a new compiler operation',async t=>{
 const h=await setup(t),bytes=Buffer.from(JSON.stringify([{rootTopic:{title:'Synthetic root',children:{attached:[{title:'Synthetic group',children:{attached:[{title:'Synthetic case'}]}}]}}}]));
 const source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'synthetic.json',contentBase64:bytes.toString('base64')});
 const task=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'mindmap-compile',idempotencyKey:'compiler-worker-capability',input:{sourceRevisionId:source.sourceRevisionId}});
 await h.phase(task.taskId,'waiting-resource');
 await h.request('/v1/workers/register',{capabilities:['flow.invoke']},'lab-east-01');
 assert.equal(await h.request('/v1/workers/claim',{},'lab-east-01'),null);
 await h.request('/v1/workers/register',{capabilities:['mindmaps.compile']},'lab-east-01');
 const work=await h.request('/v1/workers/claim',{},'lab-east-01');assert.equal(work.taskId,task.taskId);
 assert.equal((await h.db.query('SELECT required_worker_capability FROM operations WHERE operation_id=$1',[work.operationId])).rows[0].required_worker_capability,'mindmaps.compile');
 const compiled=await compileMindmap(bytes,'synthetic.json'),report={fencingToken:work.fencingToken,inputRevisionId:work.inputRevisionId,status:'succeeded',artifactBase64:compiled.workbook.toString('base64')};
 await h.request('/v1/workers/register',{capabilities:[]},'lab-east-01');
 await h.reject(`/v1/workers/operations/${work.operationId}/preflight`,{fencingToken:work.fencingToken},'FORBIDDEN_ACTION','lab-east-01');
 await h.reject(`/v1/workers/operations/${work.operationId}/report`,report,'FORBIDDEN_ACTION','lab-east-01');
 assert.equal((await h.db.query('SELECT count(*)::int AS n FROM artifact_bindings WHERE task_id=$1',[task.taskId])).rows[0].n,0);
 await h.request('/v1/workers/register',{capabilities:['mindmaps.compile']},'lab-east-01');
 await h.request(`/v1/workers/operations/${work.operationId}/report`,report,'lab-east-01');await h.phase(task.taskId,'delivered');
});
