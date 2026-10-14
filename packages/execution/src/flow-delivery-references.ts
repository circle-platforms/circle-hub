import {canonicalHash,requireCondition} from '../../contracts/src/index.ts';

// The inline frame is a bounded view. Delivery still proves lineage against
// every persisted observation in this exact task/input revision and B's ACL.
export async function verifyFlowDeliveryReferences(tx:any,knowledge:any,actor:any,task:any,references:any[]){
 if(!references.length)return;
 const rows=(await tx.query('SELECT observation FROM flow_steps WHERE task_id=$1 AND input_revision_id=$2 AND observation IS NOT NULL',[task.taskId,task.inputRevisionId])).rows,known=new Set(rows.map((row:any)=>canonicalHash(row.observation.reference)));
 // A terminal/unknown observation can later be superseded in the step row.
 // Its original and explicit Hub ledger/archive originals remain immutable B
 // records, with C-generated provenance and the same task/revision binding.
 const originals=(await tx.query(`SELECT a.artifact_id,a.sha256,a.size FROM artifact_bindings b JOIN artifacts a USING(artifact_id)
 LEFT JOIN operations o ON o.operation_id=a.metadata->>'operationId'
 LEFT JOIN flow_steps s ON s.operation_id=COALESCE(o.parent_operation_id,o.operation_id)
 WHERE b.task_id=$1 AND b.input_revision_id=$2 AND (
 (a.metadata->>'transformation' IN ('canonical-provider-or-tool-json','canonical-provider-result-failure-json','hub-step-ledger') AND o.task_id=$1 AND o.input_revision_id=$2 AND s.task_id=$1 AND s.input_revision_id=$2)
 OR (a.metadata->>'transformation'='hub-persisted-flow-history' AND a.metadata->>'inputRevisionId'=$2 AND b.role LIKE 'flow-history-%'))`,[task.taskId,task.inputRevisionId])).rows;
 for(const row of originals)known.add(canonicalHash({kind:'artifact',artifactId:row.artifact_id,sha256:row.sha256,size:Number(row.size)}));
 for(const reference of references){
  requireCondition(known.has(canonicalHash(reference)),'SOURCE_FORBIDDEN','Delivery reference is not a frozen task observation');
  requireCondition(reference.kind==='artifact','SOURCE_FORBIDDEN','Flow observations must retain their original B artifact reference');
  const current=await knowledge.contentReference(actor,'artifact',reference.artifactId,tx);
  requireCondition(current.sha256===reference.sha256&&current.size===reference.size,'SOURCE_HASH_MISMATCH','Delivery reference differs from its authorized B original');
 }
}
