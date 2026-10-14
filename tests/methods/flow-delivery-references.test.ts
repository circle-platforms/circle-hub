import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyFlowDeliveryReferences} from '../../packages/execution/src/flow-delivery-references.ts';

const task={taskId:'task_frozen',inputRevisionId:'inrev_frozen'},actor={principalId:'prn_synthetic'},reference={kind:'artifact',artifactId:'art_older',sha256:'a'.repeat(64),size:17};
test('Flow delivery references remain bound to full revision history outside the inline window and recheck B visibility',async()=>{
 const checked:any[]=[],tx={query:async(sql:string,args:any[])=>{assert.match(sql,/input_revision_id/);assert.deepEqual(args,[task.taskId,task.inputRevisionId]);return {rows:sql.includes('artifact_bindings')?[]:[{observation:{reference}}]};}},knowledge={contentReference:async(ctx:any,kind:string,id:string)=>{checked.push({ctx,kind,id});return reference;}};
 await verifyFlowDeliveryReferences(tx,knowledge,actor,task,[reference]);assert.deepEqual(checked,[{ctx:actor,kind:'artifact',id:'art_older'}]);
 await assert.rejects(verifyFlowDeliveryReferences(tx,knowledge,actor,task,[{...reference,artifactId:'art_other'}]),(e:any)=>e.code==='SOURCE_FORBIDDEN');
 await assert.rejects(verifyFlowDeliveryReferences(tx,{contentReference:async()=>({...reference,sha256:'b'.repeat(64)})},actor,task,[reference]),(e:any)=>e.code==='SOURCE_HASH_MISMATCH');
 await assert.rejects(verifyFlowDeliveryReferences(tx,{contentReference:async()=>{throw Object.assign(new Error('Hidden'),{code:'SOURCE_FORBIDDEN'});}},actor,task,[reference]),(e:any)=>e.code==='SOURCE_FORBIDDEN');
});

test('Flow delivery can cite an earlier terminal or Hub ledger original only through its exact revision binding',async()=>{
 const tx={query:async(sql:string,args:any[])=>{assert.deepEqual(args,[task.taskId,task.inputRevisionId]);return {rows:sql.includes('artifact_bindings')?[{artifact_id:reference.artifactId,sha256:reference.sha256,size:reference.size}]:[]};}},knowledge={contentReference:async()=>reference};
 await verifyFlowDeliveryReferences(tx,knowledge,actor,task,[reference]);
 await assert.rejects(verifyFlowDeliveryReferences({query:async()=>({rows:[]})},knowledge,actor,task,[reference]),(e:any)=>e.code==='SOURCE_FORBIDDEN');
});
