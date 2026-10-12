import {requireCondition,type AuthContext,type ConclusionKind} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Tasks} from '../../tasks/src/index.ts';
import type {Records} from '../../knowledge/src/records.ts';

export class Assessments {
  store:Store;tasks:Tasks;knowledge:Records;
  constructor(store:Store,tasks:Tasks,knowledge:Records){this.store=store;this.tasks=tasks;this.knowledge=knowledge;}
  async assess(ctx:AuthContext,id:string,request:any):Promise<any>{return this.store.transaction(async tx=>{
    const task=await this.tasks.load(ctx,id,'methods.use',tx,true);requireCondition(task.inputRevisionId===request.inputRevisionId,'INPUT_REVISION_STALE','Conclusion input differs');
    let kind:ConclusionKind=request.kind,body:any;
    const inputs=await Promise.all(request.evidenceIds.map((ref:string)=>this.knowledge.readEvidence(ctx,ref,tx)));
    requireCondition(inputs.every(row=>row.task_id===id&&row.input_revision_id===task.inputRevisionId),'INPUT_REVISION_STALE','Evidence belongs to another task revision');
    if(kind==='model-judgment')body={modelId:'scripted-fixture',actualModelCalled:false,verdict:request.judgment,rationale:request.rationale,evidenceIds:request.evidenceIds};
    else if(kind==='unknown')body={verdict:'undetermined',rationale:request.rationale,missingEvidence:true};
    else {
      requireCondition(request.methodId==='resource-comparison','INVALID_PAYLOAD','A registered deterministic method is required');
      body={methodId:'resource-comparison',methodVersion:'1.0.0',verdict:'undetermined',missingEvidence:[]};
      let manual:any,snapshot:any;
      const runtime=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[id])).rows[0].context;
      const sourceId=task.input.manualSourceRevisionId??runtime.manualSourceRevisionId;
      if(typeof sourceId==='string'){
        const source=await this.knowledge.sourceBytes(ctx,sourceId,task.scopeId,tx);
        try{manual=JSON.parse(source.bytes.toString());}catch{body.missingEvidence.push('manual cannot be parsed');}
        snapshot=await this.knowledge.snapshot(tx,ctx,task.scopeId,[sourceId]);body.snapshotId=snapshot.snapshotId;body.snapshotSha256=snapshot.sha256;body.sourceSha256=source.reference.sha256;
      }
      const observations=inputs.filter(row=>row.content.name==='product.config.read').map(row=>({row,output:row.content.output}));
      if(!manual||manual.product!=='SYNTH'||manual.versionSeries!==String(task.input.version??'').split('.').slice(0,2).join('.')||typeof manual.backendTimeoutMinimum!=='number'||!Number.isFinite(manual.backendTimeoutMinimum))body.missingEvidence.push('no applicable comparable minimum');
      if(!observations.length||observations.some(item=>typeof item.output?.config?.['backend.timeout']!=='number'||item.output.product!==task.input.product||item.output.version!==task.input.version||(task.input.target&&item.row.content?.target!==task.input.target)))body.missingEvidence.push('no matching numeric device observation');
      const distinct=new Set(observations.map(item=>item.output?.config?.['backend.timeout']));if(distinct.size>1)body.missingEvidence.push('cited observations conflict');
      if(body.missingEvidence.length)kind='unknown';
      else {
        const observed=observations[0].output.config['backend.timeout'];body={...body,verdict:observed>=manual.backendTimeoutMinimum?'supports':'refutes',observedTimeout:observed,minimumTimeout:manual.backendTimeoutMinimum,
          product:task.input.product,version:task.input.version,evidenceIds:request.evidenceIds,observationOperationIds:observations.map(item=>item.row.operation_id),rule:'backend.timeout >= synthetic manual section 6.4 minimum'};
      }
    }
    const conclusion=await this.knowledge.record(tx,task,kind,body);await this.tasks.emit(tx,id,'conclusion.recorded',{conclusionId:conclusion.conclusionId,kind,inputRevisionId:task.inputRevisionId});return conclusion;
  });}
}
