import {requireCondition} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';

// This is a database serialization boundary, not an authorization grant.
// All live permissions, capability, revision and lease checks still follow.
export async function lockFlowTaskRun(tx:Transaction,taskId:string,inputRevisionId?:string,skipLocked=false){
 const task=(await tx.query(`SELECT * FROM tasks WHERE task_id=$1 FOR UPDATE${skipLocked?' SKIP LOCKED':''}`,[taskId])).rows[0];
 if(skipLocked&&!task)return undefined;
 requireCondition(task,'TARGET_NOT_FOUND','Task not found for flow locking');
 const run=(await tx.query('SELECT * FROM flow_runs WHERE task_id=$1 AND input_revision_id=$2 FOR UPDATE',[taskId,inputRevisionId??task.input_revision_id])).rows[0];
 return {task,run};
}
