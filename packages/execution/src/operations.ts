import { ApiError,ExecutionReport,HEARTBEAT_MS,LEASE_TTL_MS,STANDARD_OPERATIONS,actionDigest,canonicalHash,newId,requireCondition,
  type AuthContext,type OperationRequest } from '../../contracts/src/index.ts';
import type { Transaction } from '../../storage/src/index.ts';
import { Execution } from './index.ts';

export class Operations extends Execution {
  approvalCheck?: (tx:Transaction,task:any,spec:any)=>Promise<void>;
  connectorCheck?: (tx:Transaction,actor:AuthContext,scope:string,spec:any)=>Promise<any>;
  view(row:any):any {return {operationId:row.operation_id,inputRevisionId:row.input_revision_id,name:row.name,kind:row.kind,status:row.status,
    target:row.target,targetIdentity:row.target_identity,actionDigest:row.action_digest,workerId:row.worker_id,fencingToken:row.fencing_token?Number(row.fencing_token):undefined,
    parentOperationId:row.parent_operation_id,result:row.result};}
  async list(ctx:AuthContext,taskId:string):Promise<any[]> {await this.tasks.load(ctx,taskId);return (await this.store.pool.query('SELECT * FROM operations WHERE task_id=$1 ORDER BY created_at,operation_id',[taskId])).rows.map(row=>this.view(row));}
  async submit(ctx:AuthContext,taskId:string,spec:OperationRequest,tx?:Transaction,delegatedOwnerId?:string):Promise<any> {
    const run=async(client:Transaction)=>{
      const task=await this.tasks.load(ctx,taskId,'tasks.read',client);
      requireCondition(task.inputRevisionId===spec.inputRevisionId,'INPUT_REVISION_STALE','Operation is not bound to the current revision');
      requireCondition(!['delivered','failed','cancelled'].includes(task.phase),'DECISION_CONFLICT','Task is terminal');
      requireCondition(spec.name!=='mindmaps.compile','FORBIDDEN_ACTION','Compile through the capability task interface');
      await this.auth.target(ctx,spec.name,task.scopeId,spec.target,client);
      const keys=[task.tenantId,task.scopeId,ctx.principalId,spec.name,spec.idempotencyKey];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(keys)]);
      const hash=canonicalHash(spec),old=(await client.query('SELECT k.*,o.status FROM operation_keys k JOIN operations o USING(operation_id) WHERE k.tenant_id=$1 AND k.scope_id=$2 AND k.principal_id=$3 AND k.name=$4 AND k.idem_key=$5',[...keys])).rows[0];
      if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_MISMATCH','Operation key has different content');return {...this.view((await client.query('SELECT * FROM operations WHERE operation_id=$1',[old.operation_id])).rows[0]),deduplicated:true};}
      const resource=`target:${spec.target}`;
      await client.query('INSERT INTO resources(tenant_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[task.tenantId,resource]);
      const res=(await client.query('SELECT * FROM resources WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE',[task.tenantId,resource])).rows[0];
      requireCondition(!res.frozen,'RESOURCE_BUSY','Resource is frozen until independent reconciliation');
      if(STANDARD_OPERATIONS[spec.name].writes.includes('device-config' as never)) {
        requireCondition(this.approvalCheck,'APPROVAL_REQUIRED','Device changes require a bound approval');await this.approvalCheck(client,task,{...spec,requesterId:ctx.principalId});
      }
      if(this.connectorCheck)await this.connectorCheck(client,ctx,task.scopeId,{...spec,delegatedOwnerId});
      const id=newId('op'),row=(await client.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,status,deadline_at,target,target_identity,args,action_digest,effects,approval_id,delegated_owner_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',clock_timestamp()+($9::double precision*interval '1 millisecond'),$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [id,task.tenantId,task.scopeId,taskId,task.inputRevisionId,ctx.principalId,spec.name,resource,spec.deadlineMs,spec.target,spec.targetIdentity,JSON.stringify(spec.args),actionDigest(spec),JSON.stringify(STANDARD_OPERATIONS[spec.name]),spec.approvalId??null,delegatedOwnerId??null])).rows[0];
      await client.query('INSERT INTO operation_keys(tenant_id,scope_id,principal_id,name,idem_key,request_hash,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...keys,hash,id]);
      await this.tasks.emit(client,taskId,'operation.accepted',{operationId:id,name:spec.name,effects:STANDARD_OPERATIONS[spec.name]});await this.tasks.wake(client,taskId,'operation');
      await this.auth.audit(ctx,'operations.submit',{operationId:id,actionDigest:row.action_digest,effects:row.effects},task.scopeId,client);
      return {...this.view(row),deduplicated:false};
    };return tx?run(tx):this.store.transaction(run);
  }
  async requestReconcile(ctx:AuthContext,taskId:string,id:string):Promise<any> {
    return this.store.transaction(async tx=>{
      const task=await this.tasks.load(ctx,taskId,'operations.reconcile',tx);
      const old=(await tx.query('SELECT * FROM operations WHERE operation_id=$1 AND task_id=$2 FOR UPDATE',[id,taskId])).rows[0];
      requireCondition(old && old.status==='unknown','DECISION_CONFLICT','Only an unknown operation can be reconciled');
      const existing=(await tx.query("SELECT * FROM operations WHERE parent_operation_id=$1 AND status IN ('accepted','running')",[id])).rows[0];if(existing)return this.view(existing);
      await this.auth.target(ctx,old.name.startsWith('product.')?'product.config.read':old.name==='defects.comment'?'defects.search':old.name,task.scopeId,old.target,tx);
      const operationId=newId('op'),row=(await tx.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,status,deadline_at,kind,target,target_identity,args,action_digest,effects,parent_operation_id,delegated_owner_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',clock_timestamp()+interval '5 minutes','reconcile',$9,$10,'{}',$11,$12,$13,$14) RETURNING *`,
        [operationId,task.tenantId,task.scopeId,taskId,task.inputRevisionId,ctx.principalId,old.name,old.resource_id,old.target,old.target_identity,old.action_digest,JSON.stringify(STANDARD_OPERATIONS[old.name.startsWith('product.')?'product.config.read':old.name==='defects.comment'?'defects.search':old.name as keyof typeof STANDARD_OPERATIONS]),id,old.delegated_owner_id])).rows[0];
      await tx.query('UPDATE operations SET args=$2 WHERE operation_id=$1',[operationId,JSON.stringify({...old.args,holdAfterEffectMs:0,simulateTimeoutAfterWrite:false})]);
      await this.tasks.emit(tx,taskId,'operation.reconciliation-requested',{operationId,parentOperationId:id});return this.view(row);
    });
  }
  async claim(ctx:AuthContext):Promise<any> {
    const generic=await this.store.transaction(async tx=>{
      const policy=await this.auth.check(ctx,'workers.execute',undefined,tx);requireCondition(policy.kind==='worker'&&policy.workerId,'FORBIDDEN_ACTION','Worker required');
      const worker=(await tx.query('UPDATE workers SET last_seen=clock_timestamp() WHERE worker_id=$1 AND principal_id=$2 RETURNING *',[policy.workerId,policy.principalId])).rows[0];requireCondition(worker,'FORBIDDEN_ACTION','Register first');if(worker.draining)return null;
      const rows=(await tx.query(`SELECT o.* FROM operations o LEFT JOIN operations parent ON parent.operation_id=o.parent_operation_id
        WHERE o.name<>'mindmaps.compile' AND o.status='accepted' AND o.tenant_id=$1 AND o.scope_id=ANY($2::text[]) AND o.deadline_at>clock_timestamp()
        AND (o.kind<>'reconcile' OR parent.worker_id<>$3) ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 10`,[policy.tenantId,policy.scopes,policy.workerId])).rows;
      for(const row of rows){
        const resource=(await tx.query('SELECT * FROM resources WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE',[row.tenant_id,row.resource_id])).rows[0];
        if(resource.frozen&&row.kind!=='reconcile')continue;
        if((await tx.query('SELECT 1 FROM leases WHERE tenant_id=$1 AND resource_id=$2 AND expires_at>clock_timestamp()',[row.tenant_id,row.resource_id])).rowCount)continue;
        try{await this.authorize(tx,row);}catch(error){
          if(!(error instanceof ApiError))throw error;
          await this.complete(tx,row,'failed',{error:{code:error.code,message:error.message},executionStarted:false});
          return {denial:error};
        }
        const token=Number((await tx.query('UPDATE resources SET next_fencing=next_fencing+1 WHERE tenant_id=$1 AND resource_id=$2 RETURNING next_fencing',[row.tenant_id,row.resource_id])).rows[0].next_fencing);
        await tx.query(`INSERT INTO leases(tenant_id,resource_id,operation_id,worker_id,fencing_token,expires_at) VALUES($1,$2,$3,$4,$5,LEAST(clock_timestamp()+interval '60 seconds',$6))
          ON CONFLICT(tenant_id,resource_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,worker_id=EXCLUDED.worker_id,fencing_token=EXCLUDED.fencing_token,expires_at=EXCLUDED.expires_at`,[row.tenant_id,row.resource_id,row.operation_id,policy.workerId,token,row.deadline_at]);
        await tx.query("UPDATE operations SET status='running',worker_id=$2,fencing_token=$3 WHERE operation_id=$1",[row.operation_id,policy.workerId,token]);
        await this.tasks.emit(tx,row.task_id,'operation.running',{operationId:row.operation_id,workerId:policy.workerId,fencingToken:token});
        return {operationId:row.operation_id,taskId:row.task_id,inputRevisionId:row.input_revision_id,name:row.name,kind:row.kind,target:row.target,targetIdentity:row.target_identity,args:row.args,
          actionDigest:row.action_digest,parentOperationId:row.parent_operation_id??undefined,fencingToken:token,leaseTtlMs:LEASE_TTL_MS,heartbeatMs:HEARTBEAT_MS};
      }return null;
    });if(generic?.denial)throw generic.denial;return generic??super.claim(ctx);
  }
  async preflight(ctx:AuthContext,id:string,fence:number,tx?:Transaction):Promise<any> {
    const run=async(client:Transaction)=>{
      const row=await this.lease(ctx,id,fence,client);if(row.name==='mindmaps.compile')return super.preflight(ctx,id,fence,client);
      const {task,authorization}=await this.authorize(client,row);
      const worker=await this.auth.policy(ctx,client);requireCondition(worker.targets.includes(row.target),'FORBIDDEN_TARGET','Worker cannot reach this target');
      return {row,task,authorization};
    };return tx?run(tx):this.store.transaction(run);
  }
  async authorize(client:Transaction,row:any):Promise<any>{
    const actor={principalId:row.principal_id,tenantId:row.tenant_id,kind:'user'} as const,task=await this.tasks.load(actor,row.task_id,'tasks.read',client);
    requireCondition(task.inputRevisionId===row.input_revision_id,'INPUT_REVISION_STALE','Operation input changed');
    const grant=row.kind==='reconcile'?(row.name.startsWith('product.')?'product.config.read':row.name==='defects.comment'?'defects.search':row.name):row.name;
    await this.auth.target(actor,grant,row.scope_id,row.target,client);
    const cancel=(await client.query('SELECT cancel_requested FROM tasks WHERE task_id=$1',[row.task_id])).rows[0].cancel_requested;requireCondition(!cancel,'DECISION_CONFLICT','Task cancellation is pending');
    if(row.kind!=='reconcile'&&row.name==='product.config.write'){requireCondition(this.approvalCheck,'APPROVAL_REQUIRED','Approval required');await this.approvalCheck(client,task,{inputRevisionId:row.input_revision_id,name:row.name,target:row.target,targetIdentity:row.target_identity,args:row.args,approvalId:row.approval_id,requesterId:row.principal_id});}
    const authorization=this.connectorCheck?await this.connectorCheck(client,actor,row.scope_id,{...row,name:grant,delegatedOwnerId:row.delegated_owner_id}):undefined;
    return {task,authorization};
  }
  async report(ctx:AuthContext,id:string,body:unknown):Promise<any> {
    const report=ExecutionReport.parse(body);
    return this.store.transaction(async tx=>{
      const prior=await this.lease(ctx,id,report.fencingToken,tx,true);
      if(['succeeded','failed'].includes(prior.status)){requireCondition(prior.result.reportHash===canonicalHash(report),'IDEMPOTENCY_MISMATCH','Different completed receipt');return {deduplicated:true};}
      const {row,task}=await this.preflight(ctx,id,report.fencingToken,tx);requireCondition(report.inputRevisionId===row.input_revision_id,'INPUT_REVISION_STALE','Report revision differs');
      const evidence=await this.knowledge.evidence(tx,task,id,row.kind==='reconcile'?'script-conclusion':'unknown',{
        source:'authenticated-worker-observation',workerId:ctx.workerId,inputRevisionId:row.input_revision_id,operationId:id,name:row.name,target:row.target,
        targetIdentity:row.target_identity,actionDigest:row.action_digest,args:row.args,output:report.output,error:report.error},{effects:row.effects});
      const result={output:report.output,error:report.error,evidence:[evidence],reportHash:canonicalHash(report)};
      if(row.kind==='reconcile'){
        const parent=(await tx.query('SELECT * FROM operations WHERE operation_id=$1 FOR UPDATE',[row.parent_operation_id])).rows[0],observed=report.output.observation as any;
        requireCondition(parent.status==='unknown'&&parent.worker_id!==ctx.workerId,'DECISION_CONFLICT','Independent observation required');
        requireCondition(report.status==='succeeded'&&observed?.completed===true&&observed.operationId===parent.operation_id&&observed.actionDigest===parent.action_digest,'EVIDENCE_INSUFFICIENT','Read-back does not prove the bound operation outcome');
        await tx.query("UPDATE operations SET status='reconciled',result=$2,updated_at=clock_timestamp() WHERE operation_id=$1",[parent.operation_id,JSON.stringify({...result,observedBy:ctx.workerId,observedOutcome:observed.outcome})]);
        await this.complete(tx,row,'succeeded',result);await tx.query('UPDATE resources SET frozen=EXISTS(SELECT 1 FROM operations WHERE tenant_id=$1 AND resource_id=$2 AND status=\'unknown\') WHERE tenant_id=$1 AND resource_id=$2',[row.tenant_id,row.resource_id]);
        if(task.phase==='unknown')await this.tasks.stage(tx,task,'running','inspect','task.reconciled',{operationId:parent.operation_id,evidence});
        await this.tasks.emit(tx,task.taskId,'operation.reconciled',{operationId:parent.operation_id,observedBy:ctx.workerId,evidence});
      }else if(report.status==='unknown'){
        await tx.query("UPDATE operations SET status='unknown',result=$2 WHERE operation_id=$1",[id,JSON.stringify(result)]);await tx.query('UPDATE resources SET frozen=true WHERE tenant_id=$1 AND resource_id=$2',[row.tenant_id,row.resource_id]);
        await tx.query('DELETE FROM leases WHERE operation_id=$1',[id]);await this.tasks.stage(tx,task,'unknown','reconcile','operation.unknown',{operationId:id,error:report.error});
      }else await this.complete(tx,row,report.status,result);
      return {operationId:id,status:report.status,deduplicated:false};
    });
  }
  async drain(ctx:AuthContext,id:string):Promise<any>{return this.store.transaction(async tx=>{
    const admin=await this.auth.check(ctx,'admin.manage',undefined,tx),worker=(await tx.query('SELECT w.*,p.scopes FROM workers w JOIN policies p USING(principal_id) WHERE w.worker_id=$1',[id])).rows[0];
    requireCondition(worker,'TARGET_NOT_FOUND','Worker not found');requireCondition(worker.tenant_id===admin.tenantId&&worker.scopes.every((scope:string)=>admin.scopes.includes(scope)),'FORBIDDEN_SCOPE','Worker exceeds admin scope');
    await tx.query('UPDATE workers SET draining=true WHERE worker_id=$1',[id]);await this.auth.audit(ctx,'workers.drain',{workerId:id},undefined,tx);
    const count=(await tx.query("SELECT count(*)::integer AS count FROM operations WHERE worker_id=$1 AND status='running'",[id])).rows[0].count;return {workerId:id,draining:true,inFlight:count};
  });}
}
