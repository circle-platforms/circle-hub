import {requireCondition} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';

// This is a database serialization boundary, not an authorization grant.
// All live permissions, capability, revision and lease checks still follow.
export async function lockFlowTaskRuns(tx:Transaction,taskIds:string[],skipLocked=false){
 const ids=[...new Set(taskIds)].sort(),tasks=(await tx.query(`SELECT * FROM tasks WHERE task_id=ANY($1::text[]) ORDER BY task_id FOR UPDATE${skipLocked?' SKIP LOCKED':''}`,[ids])).rows;
 if(skipLocked&&tasks.length!==ids.length)return undefined;
 requireCondition(tasks.length===ids.length,'TARGET_NOT_FOUND','Task not found for flow locking');
 const runs=(await tx.query('SELECT * FROM flow_runs WHERE task_id=ANY($1::text[]) ORDER BY task_id,input_revision_id FOR UPDATE',[ids])).rows;
 const operations=(await tx.query("SELECT operation_id,tenant_id,resource_id FROM operations WHERE task_id=ANY($1::text[]) AND name='flow.invoke' ORDER BY operation_id FOR UPDATE",[ids])).rows;
 await tx.query('SELECT step_key FROM flow_steps WHERE operation_id=ANY($1::text[]) ORDER BY step_key FOR UPDATE',[operations.map(row=>row.operation_id)]);
 const resources=new Map<string,Set<string>>(),add=(tenant:string,id:string)=>{if(!resources.has(tenant))resources.set(tenant,new Set());resources.get(tenant)!.add(id);};
 for(const task of tasks)if(task.capability_pack_id==='module-execute')add(task.tenant_id,`flow:${task.task_id}`);
 for(const operation of operations)add(operation.tenant_id,operation.resource_id);
 for(const run of runs){const task=tasks.find(item=>item.task_id===run.task_id)!;for(const pin of Object.values(run.binding.resources??{}) as any[])add(task.tenant_id,`provider:${pin.assetId}`);}
 for(const [tenant,resourceIds]of [...resources].sort(([a],[b])=>a<b?-1:a>b?1:0))await lockFlowResources(tx,tenant,[...resourceIds]);
 return {tasks,runs,operations};
}

export async function lockFlowResources(tx:Transaction,tenantId:string,resourceIds:string[]){
 const ids=[...new Set(resourceIds)].sort();for(const id of ids)await tx.query('INSERT INTO resources(tenant_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[tenantId,id]);
 await tx.query('SELECT resource_id FROM resources WHERE tenant_id=$1 AND resource_id=ANY($2::text[]) ORDER BY resource_id FOR UPDATE',[tenantId,ids]);
 await tx.query('SELECT operation_id FROM leases WHERE tenant_id=$1 AND resource_id=ANY($2::text[]) ORDER BY resource_id,operation_id FOR UPDATE',[tenantId,ids]);
}

export async function lockFlowTaskRun(tx:Transaction,taskId:string,inputRevisionId?:string,skipLocked=false){
 const locked=await lockFlowTaskRuns(tx,[taskId],skipLocked);if(!locked)return undefined;const task=locked.tasks[0];
 return {task,run:locked.runs.find(row=>row.input_revision_id===(inputRevisionId??task.input_revision_id))};
}
