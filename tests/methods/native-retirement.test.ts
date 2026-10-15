import assert from 'node:assert/strict';
import {test} from 'node:test';
import {installedWorkerMethods} from '../../packs/worker.ts';
import {assertNativeRetired} from '../fixtures/native-retirement.ts';
import {CompilerExecution} from '../../packs/apv/runtime/operations.ts';

test('Retired execution cannot reach a worker driver or request source bytes',async()=>{
 await assertNativeRetired();
 const methods=installedWorkerMethods();let calls=0;
 const context={check:async()=>{calls++;},source:async()=>{calls++;return Buffer.alloc(0);},signal:new AbortController().signal,directory:'synthetic-only',event:async()=>{calls++;}};
 for(const name of ['cases.verify','cases.execute','cases.observe']){
  assert.ok(!methods.backgroundNames.has(name));
  await assert.rejects(methods.execute({name},context),(error:any)=>error.code==='UNSUPPORTED_VERSION');
 }
 assert.equal(calls,0);
});

test('A worker cannot read or report old compiler work under the new implementation version',async()=>{
 let sourceReads=0;
 const row={task_id:'task_synthetic',principal_id:'prn_synthetic',tenant_id:'tnt_synthetic',input_revision_id:'inrev_synthetic',source_revision_id:'src_synthetic',scope_id:'scp_synthetic'};
 const execution={lease:async()=>row,workerCapability:async()=>{},tasks:{load:async()=>({packVersion:'1.0.0',inputRevisionId:row.input_revision_id,input:{sourceSha256:'a'.repeat(64)}})},knowledge:{source:async()=>{sourceReads++;return {sha256:'a'.repeat(64)};}}};
 const tx={query:async()=>({rows:[{cancel_requested:false}]})};
 await assert.rejects(CompilerExecution.prototype.preflight.call(execution as any,{} as any,'op_synthetic',1,tx as any),(error:any)=>error.code==='UNSUPPORTED_VERSION');
 assert.equal(sourceReads,0);
});
