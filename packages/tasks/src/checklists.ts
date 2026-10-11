import {requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Records} from '../../knowledge/src/records.ts';
import type {Tasks} from './index.ts';

export class Checklists {
  store:Store;tasks:Tasks;knowledge:Records;
  constructor(store:Store,tasks:Tasks,knowledge:Records){this.store=store;this.tasks=tasks;this.knowledge=knowledge;}
  async set(ctx:AuthContext,id:string,request:any):Promise<any>{return this.store.transaction(async tx=>{
    const task=await this.tasks.load(ctx,id,'tasks.input',tx,true);requireCondition(task.inputRevisionId===request.inputRevisionId,'INPUT_REVISION_STALE','Checklist input differs');
    requireCondition(!['delivered','failed','cancelled','unknown'].includes(task.phase),'DECISION_CONFLICT','Checklist is frozen in this phase');
    requireCondition(new Set(request.items.map((item:any)=>item.itemId)).size===request.items.length,'INVALID_PAYLOAD','Duplicate checklist item');
    await tx.query('DELETE FROM checklist_items WHERE task_id=$1 AND input_revision_id=$2',[id,task.inputRevisionId]);
    for(const item of request.items)await tx.query('INSERT INTO checklist_items(task_id,input_revision_id,item_id,requires_fact,required,predicate) VALUES($1,$2,$3,$4,$5,$6)',[id,task.inputRevisionId,item.itemId,item.requiresFact,item.required,item.predicate]);
    await this.tasks.emit(tx,id,'checklist.created',{inputRevisionId:task.inputRevisionId,items:request.items});return request;
  });}
  accepts(predicate:string,record:any):boolean {
    if(record.kind==='unknown')return false;
    if(predicate==='professional-opinion')return record.body.verdict==='supports';
    if(predicate==='assessment-completed')return record.body.methodId==='lbx-healthcheck'&&typeof record.body.observedTimeout==='number'&&typeof record.body.minimumTimeout==='number';
    if(predicate==='configuration-conforms')return record.body.methodId==='lbx-healthcheck'&&record.body.verdict==='supports';
    return record.body.predicate===predicate&&record.body.verified===true;
  }
  async satisfy(ctx:AuthContext,id:string,itemId:string,request:any):Promise<any>{return this.store.transaction(async tx=>{
    const task=await this.tasks.load(ctx,id,'tasks.input',tx,true);requireCondition(task.inputRevisionId===request.inputRevisionId,'INPUT_REVISION_STALE','Checklist response input differs');
    const conclusion=await this.knowledge.conclusion(ctx,id,request.conclusionId,tx);
    requireCondition(conclusion.inputRevisionId===task.inputRevisionId,'INPUT_REVISION_STALE','Conclusion is from a prior input revision');
    const item=(await tx.query('SELECT * FROM checklist_items WHERE task_id=$1 AND input_revision_id=$2 AND item_id=$3',[id,task.inputRevisionId,itemId])).rows[0];requireCondition(item,'EVIDENCE_INSUFFICIENT','No checklist for the current revision');
    requireCondition(!item.requires_fact||conclusion.kind==='script-conclusion','EVIDENCE_INSUFFICIENT','A model opinion cannot satisfy a fact requirement');
    requireCondition(this.accepts(item.predicate,conclusion),'EVIDENCE_INSUFFICIENT','Conclusion does not establish this checklist predicate');
    await tx.query('UPDATE checklist_items SET satisfied=true,conclusion_id=$4 WHERE task_id=$1 AND input_revision_id=$2 AND item_id=$3',[id,task.inputRevisionId,itemId,request.conclusionId]);
    await this.tasks.emit(tx,id,'checklist.satisfied',{itemId,conclusionId:request.conclusionId,inputRevisionId:task.inputRevisionId});return {itemId,satisfied:true};
  });}
  async deliver(ctx:AuthContext,id:string,inputRevisionId:string):Promise<any>{return this.store.transaction(async tx=>{
    const task=await this.tasks.load(ctx,id,'tasks.input',tx,true);requireCondition(task.inputRevisionId===inputRevisionId,'INPUT_REVISION_STALE','Delivery input differs');
    requireCondition(!['unknown','delivered','failed','cancelled'].includes(task.phase),'DECISION_CONFLICT','Task cannot deliver in this phase');
    const items=(await tx.query('SELECT * FROM checklist_items WHERE task_id=$1 AND input_revision_id=$2',[id,inputRevisionId])).rows;
    requireCondition(items.length&&items.every(item=>!item.required||item.satisfied),'EVIDENCE_INSUFFICIENT','Required current-revision checklist items are missing');
    const active=(await tx.query("SELECT 1 FROM operations WHERE task_id=$1 AND input_revision_id=$2 AND status NOT IN ('succeeded','failed','reconciled','stopped-observed')",[id,inputRevisionId])).rowCount;
    const pending=(await tx.query("SELECT 1 FROM pending_inputs WHERE task_id=$1 AND input_revision_id=$2 AND status='open'",[id,inputRevisionId])).rowCount;
    requireCondition(!active&&!pending,'EVIDENCE_INSUFFICIENT','Open operations or human decisions prevent delivery');
    const conclusions=[];
    for(const item of items.filter(item=>item.satisfied)){
      const record=await this.knowledge.conclusion(ctx,id,item.conclusion_id,tx);
      requireCondition(record.inputRevisionId===inputRevisionId&&(!item.requires_fact||record.kind==='script-conclusion')&&this.accepts(item.predicate,record),'EVIDENCE_INSUFFICIENT','Delivery recheck failed');conclusions.push(record);
    }
    const status=conclusions.some(record=>record.body.verdict==='refutes'||record.kind==='unknown')?'partial':'succeeded';
    const result:any={status,inputRevisionId,checklist:items,conclusions,evidence:conclusions.map(record=>record.evidence),unmapped:[]};
    const artifact=await this.knowledge.reportArtifact(tx,task,result);result.artifacts=[artifact];
    await tx.query('UPDATE tasks SET result_status=$2,result=$3 WHERE task_id=$1',[id,status,JSON.stringify(result)]);
    await this.tasks.stage(tx,task,'under-review','review','task.verifying');await this.tasks.stage(tx,task,'delivered','done','task.delivered',{status,artifacts:result.artifacts,inputRevisionId});
    return {taskId:id,...result};
  });}
}
