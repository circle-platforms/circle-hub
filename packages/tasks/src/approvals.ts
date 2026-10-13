import { ApiError,actionDigest,newId,requireCondition,type AuthContext,type ApprovalView } from '../../contracts/src/index.ts';
import type { Store,Transaction } from '../../storage/src/index.ts';
import type { Auth } from './auth.ts';
import type { Tasks } from './index.ts';

export class Approvals {
  store:Store;auth:Auth;tasks:Tasks;
  ttlMs:number;
  legacyProposal?:(tx:Transaction,ctx:AuthContext,task:any,action:any)=>Promise<any>;
  changeCheck?:(tx:Transaction,task:any,spec:any,row:any)=>Promise<void>;
  constructor(store:Store,auth:Auth,tasks:Tasks,ttlMs=86400000){this.store=store;this.auth=auth;this.tasks=tasks;requireCondition(Number.isInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=30*86400000,'INVALID_PAYLOAD','Approval lifetime must be one second to thirty days');this.ttlMs=ttlMs;}
  policies=new Map<string,{digest?:(action:any)=>string;authorize:(tx:Transaction,ctx:AuthContext,task:any,action:any)=>Promise<void>;check:(tx:Transaction,ctx:AuthContext,task:any,row:any,answer:any)=>Promise<void>;accepted:(tx:Transaction,ctx:AuthContext,task:any,row:any,answer:any)=>Promise<void>}>();
  view(row:any):ApprovalView{return {approvalId:row.approval_id,taskId:row.task_id,inputRevisionId:row.input_revision_id,applicantId:row.applicant_id,
    targetIdentity:row.target_identity,actionDigest:row.action_digest,action:row.action,status:row.status,approvedBy:row.approved_by,expiresAt:row.expires_at.toISOString(),decisionMode:row.decision_mode??null,singleAdminMode:row.single_admin_mode??false,verification:row.eligibility_verification??null};}
  async list(ctx:AuthContext,taskId:string):Promise<ApprovalView[]> {
    await this.tasks.load(ctx,taskId);
    const rows=(await this.store.pool.query('SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at,approval_id',[taskId])).rows;
    return rows.map(row=>this.view(row));
  }
  async propose(ctx:AuthContext,id:string,action:any,tx?:Transaction):Promise<any>{
    const run=async(client:Transaction)=>{
      const task=await this.tasks.load(ctx,id,'tasks.read',client,true);
      requireCondition(task.inputRevisionId===action.inputRevisionId,'INPUT_REVISION_STALE','Approval input differs');
      const policy=this.policies.get(action.name);
      if(!policy&&this.legacyProposal)return this.legacyProposal(client,ctx,task,action);
      if(policy)await policy.authorize(client,ctx,task,action);
      else{await this.auth.target(ctx,action.name,task.scopeId,action.target,client);requireCondition(action.name==='product.config.write','INVALID_PAYLOAD','This approval policy applies to synthetic device changes');}
      const requestId=newId('pin'),digest=policy?.digest?.(action)??actionDigest(action);
      const row=(await client.query(`INSERT INTO approvals(approval_id,task_id,input_revision_id,applicant_id,target_identity,action_digest,action,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::double precision*interval '1 millisecond')) RETURNING *`,[requestId,id,task.inputRevisionId,ctx.principalId,action.targetIdentity,digest,JSON.stringify(action),this.ttlMs])).rows[0];
      await client.query(`INSERT INTO pending_inputs(request_id,task_id,input_revision_id,kind,question,binding,expires_at)
        VALUES($1,$2,$3,'approval',$4,$5,$6)`,[requestId,id,task.inputRevisionId,`Approve ${action.name} on ${action.target}`,JSON.stringify({targetIdentity:action.targetIdentity,actionDigest:digest}),row.expires_at]);
      if(task.phase==='admitted')await this.tasks.stage(client,task,'running','inspect','task.running');
      await this.tasks.stage(client,task,'waiting-review','wait-approval','task.approval-requested',{approvalId:requestId,targetIdentity:action.targetIdentity,actionDigest:digest});
      return this.view(row);
    };return tx?run(tx):this.store.transaction(run);
  }
  async respond(ctx:AuthContext,taskId:string,id:string,answer:any):Promise<any>{
    const result=await this.store.transaction(async tx=>{
      const task=await this.tasks.load(ctx,taskId,'decisions.approve',tx,true),policy=await this.auth.policy(ctx,tx);
      requireCondition(policy.kind==='user','FORBIDDEN_ACTION','Only an authenticated person can approve');
      const row=(await tx.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM approvals WHERE approval_id=$1 AND task_id=$2 FOR UPDATE',[id,taskId])).rows[0];
      requireCondition(row,'TARGET_NOT_FOUND','Approval request not found');
      let eligibility=await this.auth.roles.eligibility(ctx,task.scopeId,row.applicant_id,tx);
      let code:'SELF_APPROVAL'|'APPROVAL_STALE'|'INPUT_EXPIRED'|'DECISION_CONFLICT'|undefined,outcome=answer.approve?'approved':'declined';
      if(!eligibility.eligible){code=row.applicant_id===ctx.principalId?'SELF_APPROVAL':'APPROVAL_STALE';outcome=row.applicant_id===ctx.principalId?'self-approval':'eligibility-mismatch';}
      else if(task.inputRevisionId!==row.input_revision_id||answer.inputRevisionId!==row.input_revision_id||answer.targetIdentity!==row.target_identity||answer.actionDigest!==row.action_digest){code='APPROVAL_STALE';outcome='binding-mismatch';}
      else if(row.expired){code='INPUT_EXPIRED';outcome='expired';}
      else if(row.status!=='open'){code='DECISION_CONFLICT';outcome='already-decided';}
      const decision=(await tx.query('INSERT INTO decisions(request_id,task_id,principal_id,input_revision_id,outcome,response) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[id,taskId,ctx.principalId,answer.inputRevisionId,outcome,JSON.stringify(answer)])).rows[0];
      await tx.query('UPDATE decisions SET decision_mode=$2,single_admin_mode=$3,policy_version=$4 WHERE id=$1',[decision.id,eligibility.decisionMode,eligibility.singleAdminMode,eligibility.policyVersion]);
      await this.tasks.emit(tx,taskId,'approval.response',{approvalId:id,principalId:ctx.principalId,outcome});
      if(code)return {error:new ApiError(code,`Approval rejected: ${outcome}`)};
      // emit() holds the event clock until commit. All role/policy decisions
      // apply under that same lock, so re-read eligibility at the decision point.
      eligibility=await this.auth.roles.eligibility(ctx,task.scopeId,row.applicant_id,tx);if(!eligibility.eligible){await tx.query('UPDATE decisions SET outcome=$2 WHERE id=$1',[decision.id,'eligibility-mismatch']);return {error:new ApiError('SELF_APPROVAL','Scope policy now requires an independent reviewer')};}
      await tx.query('UPDATE decisions SET decision_mode=$2,single_admin_mode=$3,policy_version=$4 WHERE id=$1',[decision.id,eligibility.decisionMode,eligibility.singleAdminMode,eligibility.policyVersion]);
      const registered=this.policies.get(row.action.name);
      if(registered){try{await registered.check(tx,ctx,task,row,answer);}catch(error){if(!(error instanceof ApiError))throw error;await tx.query('UPDATE decisions SET outcome=$2 WHERE id=$1',[decision.id,error.code]);return {error};}}
      await tx.query('UPDATE approvals SET status=$2,approved_by=$3 WHERE approval_id=$1',[id,outcome,ctx.principalId]);
      await tx.query('UPDATE approvals SET decision_mode=$2,single_admin_mode=$3,eligibility_verification=$4 WHERE approval_id=$1',[id,eligibility.decisionMode,eligibility.singleAdminMode,JSON.stringify(eligibility.verification)]);await this.auth.audit(ctx,'approval.decision',{approvalId:id,outcome,decisionMode:eligibility.decisionMode,singleAdminMode:eligibility.singleAdminMode,policyVersion:eligibility.policyVersion,verification:eligibility.verification},task.scopeId,tx);
      await tx.query("UPDATE pending_inputs SET status='answered' WHERE request_id=$1",[id]);
      await this.tasks.stage(tx,task,'running','inspect','task.approval-decided',{approvalId:id,outcome});await this.tasks.wake(tx,taskId,'approval');
      await registered?.accepted(tx,ctx,task,row,answer);
      return {approval:{...this.view(row),status:outcome,approvedBy:ctx.principalId,decisionMode:eligibility.decisionMode,singleAdminMode:eligibility.singleAdminMode,verification:eligibility.verification}};
    });if(result.error)throw result.error;return result.approval;
  }
  async check(tx:Transaction,task:any,spec:any):Promise<void>{
    requireCondition(spec.approvalId,'APPROVAL_REQUIRED','Device changes require approval');
    const row=(await tx.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM approvals WHERE approval_id=$1',[spec.approvalId])).rows[0];
    if(row?.action.name==='changesets.apply'&&this.changeCheck){requireCondition(row.task_id===task.taskId&&row.status==='approved'&&!row.expired,'APPROVAL_STALE','Execution change request is not approved');await this.changeCheck(tx,task,spec,row);return;}
    requireCondition(row&&row.task_id===task.taskId&&row.status==='approved'&&!row.expired&&(row.approved_by!==row.applicant_id||row.decision_mode==='self'),
      'APPROVAL_STALE','Approval is missing, expired or not approved');
    const used=(await tx.query('SELECT operation_id FROM operations WHERE approval_id=$1 AND kind<>\'reconcile\' ORDER BY created_at LIMIT 1',[row.approval_id])).rows[0];requireCondition(spec.operationId?used?.operation_id===spec.operationId:!used,'DECISION_CONFLICT','This historical execution change was already consumed');
    requireCondition(row.input_revision_id===task.inputRevisionId&&row.input_revision_id===spec.inputRevisionId&&row.target_identity===spec.targetIdentity&&row.action_digest===actionDigest(spec)&&row.applicant_id===(spec.requesterId??task.principalId),
      'APPROVAL_STALE','Approval is not bound to this revision, target, action and applicant');
    await this.auth.check({principalId:row.approved_by,tenantId:task.tenantId,kind:'user'},'decisions.approve',task.scopeId,tx);
  }
}
