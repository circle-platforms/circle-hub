import {PACK_FLOWS,DefectReviewPack} from './contracts.ts';
import {ApiError,OperationRequest,sha256,requireCondition,type AuthContext} from '../../packages/contracts/src/index.ts';
import {connectorIdentity} from './connectors.ts';
import type {Store} from '../../packages/storage/src/index.ts';
import type {Tasks} from '../../packages/tasks/src/index.ts';
import type {Operations} from '../../packages/execution/src/operations.ts';
import type {Records} from '../../packages/knowledge/src/records.ts';
import type {Checklists} from '../../packages/tasks/src/checklists.ts';
import type {Approvals} from '../../packages/tasks/src/approvals.ts';
import type {Assessments} from '../../packages/methods/src/assessments.ts';

export class ProfessionalRunner {
  store:Store;tasks:Tasks;operations:Operations;knowledge:Records;checklists:Checklists;approvals:Approvals;assessments:Assessments;
  constructor(store:Store,tasks:Tasks,operations:Operations,knowledge:Records,checklists:Checklists,approvals:Approvals,assessments:Assessments){Object.assign(this,{store,tasks,operations,knowledge,checklists,approvals,assessments});this.store=store;this.tasks=tasks;this.operations=operations;this.knowledge=knowledge;this.checklists=checklists;this.approvals=approvals;this.assessments=assessments;}
  async runOnce():Promise<void>{
    const rows=(await this.store.pool.query("SELECT * FROM tasks WHERE capability_pack_id IN ('defect-review','synthetic-resource-check') AND phase IN ('running','waiting-resource') ORDER BY created_at")).rows;
    for(const row of rows){
      try{await this.advance(row);}catch(error){
        if(error instanceof ApiError&&['INPUT_REVISION_STALE','RESOURCE_BUSY','DECISION_CONFLICT'].includes(error.code))continue;
        await this.store.transaction(async tx=>{const task=await this.tasks.internal(tx,row.task_id);
          if(task.inputRevisionId===row.input_revision_id&&!['delivered','failed','unknown','cancelled'].includes(task.phase))await this.tasks.fail(tx,task,{code:error instanceof ApiError?error.code:'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'Professional runner failed'});});
      }
    }
  }
  async advance(row:any):Promise<void>{
    requireCondition(row.flow_version===PACK_FLOWS[row.capability_pack_id as keyof typeof PACK_FLOWS]&&row.pack_version==='1.0.0','UNSUPPORTED_VERSION','Pinned professional flow is unsupported');
    const actor={principalId:row.principal_id,tenantId:row.tenant_id,kind:'user'} as AuthContext,task=await this.tasks.load(actor,row.task_id),bindings=task.input.bindings as any;
    requireCondition(bindings&&bindings.documents&&bindings.product,'INVALID_PAYLOAD','Professional capability needs explicit standard role bindings');
    let context=await this.tasks.context(actor,task.taskId,task.inputRevisionId);
    const patch=async(value:any)=>{context=await this.tasks.context(actor,task.taskId,task.inputRevisionId,value);};
    const ensure=async(key:string,name:string,target:string,args:any,approvalId?:string):Promise<any|undefined>=>{
      const token=`op_${key}`;
      if(!context[token]){
        const operation=await this.operations.submit(actor,task.taskId,OperationRequest.parse({inputRevisionId:task.inputRevisionId,name,target,targetIdentity:target===bindings.product?'synthetic-host-key:resource-01':connectorIdentity(target),args,approvalId,idempotencyKey:`${task.taskId}-${task.inputRevisionId}-${key}`}),undefined,context.delegatedOwnerId);
        await patch({[token]:operation.operationId});return undefined;
      }
      const op=(await this.store.pool.query('SELECT * FROM operations WHERE operation_id=$1',[context[token]])).rows[0];
      if(['accepted','running','unknown'].includes(op.status))return undefined;
      requireCondition(['succeeded','reconciled'].includes(op.status),'EVIDENCE_INSUFFICIENT',`Required operation ${name} did not complete`);return op;
    };
    const version=await ensure('version','product.version',bindings.product,{});if(!version)return;
    const document=await ensure('document','docs.fetch',bindings.documents,{documentId:'fixture-resource-policy'});if(!document)return;
    if(!context.manualSourceRevisionId){
      const bytes=Buffer.from(document.result.output.originalBase64,'base64');requireCondition(sha256(bytes)===document.result.output.sourceSha256,'SOURCE_HASH_MISMATCH','Fetched document hash differs');
      const source=await this.knowledge.upload(actor,task.scopeId,document.result.output.fileName,bytes);await patch({manualSourceRevisionId:source.sourceRevisionId});
    }
    if(task.capabilityPackId==='synthetic-resource-check'){
      const observation=await ensure('observation','product.config.read',bindings.product,{});if(!observation)return;
      if(!context.assessment){const fact=await this.assessments.assess(actor,task.taskId,{inputRevisionId:task.inputRevisionId,kind:'script-conclusion',methodId:'resource-comparison',evidenceIds:[observation.result.evidence[0].evidenceId]});await patch({assessment:fact});}
      requireCondition(context.assessment.kind==='script-conclusion','EVIDENCE_INSUFFICIENT','No applicable factual comparison');
      let final=context.assessment;
      if(final.body.verdict==='refutes'&&task.input.correctIfNonConforming===true){
        const action={inputRevisionId:task.inputRevisionId,name:'product.config.write',target:bindings.product,targetIdentity:'synthetic-host-key:resource-01',args:{key:'backend.timeout',value:final.body.minimumTimeout,sourceSha256:final.body.sourceSha256}};
        if(!context.approval){await patch({approval:await this.approvals.propose(actor,task.taskId,action)});return;}
        const approved=(await this.store.pool.query('SELECT status FROM approvals WHERE approval_id=$1',[context.approval.approvalId])).rows[0];if(approved.status==='open')return;requireCondition(approved.status==='approved','APPROVAL_REQUIRED','Change was not approved');
        const changed=await ensure('change','product.config.write',bindings.product,action.args,context.approval.approvalId);if(!changed)return;
        const verified=await ensure('verified','product.config.read',bindings.product,{});if(!verified)return;
        if(!context.finalAssessment)await patch({finalAssessment:await this.assessments.assess(actor,task.taskId,{inputRevisionId:task.inputRevisionId,kind:'script-conclusion',methodId:'resource-comparison',evidenceIds:[verified.result.evidence[0].evidenceId]})});final=context.finalAssessment;
      }
      const predicate=task.input.correctIfNonConforming===true?'configuration-conforms':'assessment-completed';
      await this.checklists.set(actor,task.taskId,{inputRevisionId:task.inputRevisionId,items:[{itemId:'configuration-check',required:true,requiresFact:true,predicate}]});
      await this.checklists.satisfy(actor,task.taskId,'configuration-check',{inputRevisionId:task.inputRevisionId,conclusionId:final.conclusionId});await this.checklists.deliver(actor,task.taskId,task.inputRevisionId);return;
    }
    const defect=await ensure('defect','defects.search',bindings.defects,{defectId:task.input.defectId});if(!defect)return;
    const conversion=await ensure('conversion','docs.convert',bindings.documents,{documentId:'fixture-resource-policy'});if(!conversion)return;
    if(!context.convertedArtifact){const output=conversion.result.output,bytes=Buffer.from(output.convertedBase64,'base64');requireCondition(sha256(bytes)===output.convertedSha256,'SOURCE_HASH_MISMATCH','Converted document hash differs');
      const artifact=await this.store.transaction(tx=>this.knowledge.materialize(tx,task,'converted-document',output.fileName,'text/plain',bytes,{sourceSha256:output.sourceSha256,conversion:output.conversion}));await patch({convertedArtifact:artifact});}
    const issue=defect.result.output.defects[0],manual=JSON.parse((await this.knowledge.sourceBytes(actor,context.manualSourceRevisionId,task.scopeId)).bytes.toString());
    requireCondition(issue&&issue.version===version.result.output.version&&manual.product===issue.product&&typeof manual.backendTimeoutMinimum==='number','EVIDENCE_INSUFFICIENT','Defect product/version and manual are not compatible');
    const comment=await ensure('comment','defects.comment',bindings.defects,{defectId:issue.id,text:`Defect reports ${issue.product} ${issue.version} backend.timeout ${issue.observedTimeout}; manual section ${manual.section} minimum ${manual.backendTimeoutMinimum}`,simulateTimeoutAfterWrite:task.input.simulateCommentTimeout===true});if(!comment)return;
    if(!context.conclusions){const records=await this.store.transaction(async tx=>{
      const facts=[{predicate:'defect-reviewed',verified:true,defectId:issue.id,product:issue.product,version:issue.version,minimumTimeout:manual.backendTimeoutMinimum,sourceRevisionId:context.manualSourceRevisionId},
        {predicate:'documents-converted',verified:true,sourceSha256:conversion.result.output.sourceSha256,artifactSha256:context.convertedArtifact.sha256},
        {predicate:'comment-reconciled',verified:true,operationId:comment.operation_id,observedBy:comment.result.observedBy??comment.worker_id,marker:`[circle ${comment.operation_id}]`,readBack:comment.status==='reconciled'||comment.result.output.readBack===true}];
      return Promise.all(facts.map(body=>this.knowledge.record(tx,task,'script-conclusion',body)));});await patch({conclusions:records});}
    const predicates=['defect-reviewed','documents-converted','comment-reconciled'];await this.checklists.set(actor,task.taskId,{inputRevisionId:task.inputRevisionId,items:predicates.map(itemId=>({itemId,predicate:itemId,requiresFact:true,required:true}))});
    for(let i=0;i<predicates.length;i++)await this.checklists.satisfy(actor,task.taskId,predicates[i],{inputRevisionId:task.inputRevisionId,conclusionId:context.conclusions[i].conclusionId});
    await this.checklists.deliver(actor,task.taskId,task.inputRevisionId);
  }
}
