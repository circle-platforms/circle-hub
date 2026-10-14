import {projectWorkerErrors,retainWorkerReport} from './worker-report.ts';
import { ApiError,ExecutionReport,HEARTBEAT_MS,LEASE_TTL_MS,STANDARD_OPERATIONS,actionDigest,canonicalHash,newId,requireCondition,
  type AuthContext,type OperationRequest } from '../../contracts/src/index.ts';
import type { Transaction } from '../../storage/src/index.ts';
import { Execution } from './index.ts';

export class Operations extends Execution {
  capabilityOnlyOperations=new Set<string>();
  customReports=new Map<string,(ctx:AuthContext,id:string,body:unknown)=>Promise<any>>();
  customEvents=new Map<string,(ctx:AuthContext,id:string,fence:number,revision:string,event:any)=>Promise<any>>();
  customReconciliations=new Map<string,(ctx:AuthContext,taskId:string,id:string)=>Promise<any>>();
  managedNames=new Set(['tools.invoke']);
  approvalCheck?: (tx:Transaction,task:any,spec:any)=>Promise<void>;
  consumeChange?:(tx:Transaction,task:any,spec:any,id:string)=>Promise<void>;
  connectorCheck?: (tx:Transaction,actor:AuthContext,scope:string,spec:any)=>Promise<any>;
  managedAuthorization?: (tx:Transaction,actor:AuthContext,scope:string,spec:any,task:any)=>Promise<any>;
  managedPreflight?: (tx:Transaction,actor:AuthContext,row:any,authorization:any)=>Promise<any>;
  managedReport?: (tx:Transaction,task:any,row:any,report:any)=>Promise<any>;
  view(row:any):any {return {operationId:row.operation_id,inputRevisionId:row.input_revision_id,name:row.name,kind:row.kind,status:row.status,
    target:row.target,targetIdentity:row.target_identity,actionDigest:row.action_digest,workerId:row.worker_id,fencingToken:row.fencing_token?Number(row.fencing_token):undefined,
    parentOperationId:row.parent_operation_id,result:row.result};}
  async list(ctx:AuthContext,taskId:string):Promise<any[]> {await this.tasks.load(ctx,taskId);return (await this.store.pool.query('SELECT * FROM operations WHERE task_id=$1 ORDER BY created_at,operation_id',[taskId])).rows.map(row=>this.view(row));}
  async submit(ctx:AuthContext,taskId:string,spec:OperationRequest,tx?:Transaction,delegatedOwnerId?:string):Promise<any> {
    const run=async(client:Transaction)=>{
      const task=await this.tasks.load(ctx,taskId,'tasks.read',client);
      requireCondition(task.inputRevisionId===spec.inputRevisionId,'INPUT_REVISION_STALE','Operation is not bound to the current revision');
      requireCondition(!['delivered','failed','cancelled'].includes(task.phase),'DECISION_CONFLICT','Task is terminal');
      requireCondition(!this.capabilityOnlyOperations.has(spec.name),'FORBIDDEN_ACTION','Use the registered capability controller');
      const managed=this.managedNames.has(spec.name);
      const authorization=managed?await this.managedAuthorization?.(client,ctx,task.scopeId,spec,task):undefined;
      if(managed)requireCondition(authorization,'FORBIDDEN_ACTION','Registered execution authorizer is unavailable');else await this.auth.target(ctx,spec.name,task.scopeId,spec.target,client);
      const effects=authorization?.effects??STANDARD_OPERATIONS[spec.name];
      const keys=[task.tenantId,task.scopeId,ctx.principalId,spec.name,spec.idempotencyKey];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(keys)]);
      const hash=canonicalHash(spec),old=(await client.query('SELECT k.*,o.status FROM operation_keys k JOIN operations o USING(operation_id) WHERE k.tenant_id=$1 AND k.scope_id=$2 AND k.principal_id=$3 AND k.name=$4 AND k.idem_key=$5',[...keys])).rows[0];
      if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_MISMATCH','Operation key has different content');return {...this.view((await client.query('SELECT * FROM operations WHERE operation_id=$1',[old.operation_id])).rows[0]),deduplicated:true};}
      const resource=authorization?.resourceId??`target:${spec.target}`;
      await client.query('INSERT INTO resources(tenant_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[task.tenantId,resource]);
      const res=(await client.query('SELECT * FROM resources WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE',[task.tenantId,resource])).rows[0];
      requireCondition(!res.frozen,'RESOURCE_BUSY','Resource is frozen until independent reconciliation');
      if(spec.approvalId) {
        requireCondition(this.approvalCheck,'APPROVAL_REQUIRED','Execution change verification is unavailable');const proof={...spec,requesterId:ctx.principalId};await this.approvalCheck(client,task,proof);if(proof.authorizationAssetId)spec.authorizationAssetId=proof.authorizationAssetId;
      }
      if(this.connectorCheck&&!managed)await this.connectorCheck(client,ctx,task.scopeId,{...spec,delegatedOwnerId});
      const id=newId('op');await this.consumeChange?.(client,task,spec,id);const row=(await client.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,status,deadline_at,target,target_identity,args,action_digest,effects,approval_id,delegated_owner_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',clock_timestamp()+($9::double precision*interval '1 millisecond'),$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [id,task.tenantId,task.scopeId,taskId,task.inputRevisionId,ctx.principalId,spec.name,resource,spec.deadlineMs,spec.target,spec.targetIdentity,JSON.stringify(spec.args),actionDigest(spec),JSON.stringify(effects),spec.approvalId??null,delegatedOwnerId??null])).rows[0];
      await client.query('UPDATE operations SET authorization_asset_id=$2,approval_consumed=$3 WHERE operation_id=$1',[id,spec.authorizationAssetId??null,!!spec.approvalId]);
      await client.query('UPDATE operations SET source_effect=$2 WHERE operation_id=$1',[id,authorization?.sourceEffect??'write']);
      await client.query('INSERT INTO operation_keys(tenant_id,scope_id,principal_id,name,idem_key,request_hash,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...keys,hash,id]);
      await this.tasks.emit(client,taskId,'operation.accepted',{operationId:id,name:spec.name,effects});await this.tasks.wake(client,taskId,'operation');
      await this.auth.audit(ctx,'operations.submit',{operationId:id,actionDigest:row.action_digest,effects:row.effects},task.scopeId,client);
      return {...this.view(row),deduplicated:false};
    };return tx?run(tx):this.store.transaction(run);
  }
  async requestReconcile(ctx:AuthContext,taskId:string,id:string):Promise<any> {
    const name=(await this.store.pool.query('SELECT name FROM operations WHERE operation_id=$1 AND task_id=$2',[id,taskId])).rows[0]?.name,custom=this.customReconciliations.get(name);if(custom)return custom(ctx,taskId,id);
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
  async event(ctx:AuthContext,id:string,fence:number,revision:string,event:any):Promise<any>{
    const name=(await this.store.pool.query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0]?.name,handler=this.customEvents.get(name);requireCondition(handler,'FORBIDDEN_ACTION','Worker event handler is not registered');return handler(ctx,id,fence,revision,event);
  }
  async claim(ctx:AuthContext,exclude:string[]=[]):Promise<any> {
    const generic=await this.store.transaction(async tx=>{
      const policy=await this.auth.check(ctx,'workers.execute',undefined,tx);requireCondition(policy.kind==='worker'&&policy.workerId,'FORBIDDEN_ACTION','Worker required');
      const worker=(await tx.query('UPDATE workers SET last_seen=clock_timestamp() WHERE worker_id=$1 AND principal_id=$2 RETURNING *',[policy.workerId,policy.principalId])).rows[0];requireCondition(worker,'FORBIDDEN_ACTION','Register first');if(worker.draining)return null;
      const rows=(await tx.query(`SELECT o.* FROM operations o LEFT JOIN operations parent ON parent.operation_id=o.parent_operation_id
        WHERE o.name<>ALL($5::text[]) AND o.status='accepted' AND o.tenant_id=$1 AND o.scope_id=ANY($2::text[]) AND o.deadline_at>clock_timestamp()
        AND o.name<>ALL($4::text[]) AND (o.kind<>'reconcile' OR parent.worker_id<>$3) ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 10`,[policy.tenantId,policy.scopes,policy.workerId,exclude,[...this.customClaimers.keys()]])).rows;
      for(const row of rows){
        const resource=(await tx.query('SELECT * FROM resources WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE',[row.tenant_id,row.resource_id])).rows[0];
        if(resource.frozen&&row.kind!=='reconcile')continue;
        if((await tx.query('SELECT 1 FROM leases WHERE tenant_id=$1 AND resource_id=$2 AND expires_at>clock_timestamp()',[row.tenant_id,row.resource_id])).rowCount)continue;
        try{await this.authorize(tx,row);}catch(error){
          if(!(error instanceof ApiError))throw error;
          const failure={code:error.code,message:error.message,details:error.details};
          await this.complete(tx,row,'failed',{error:failure,executionStarted:false});
          if(this.managedNames.has(row.name)&&row.kind!=='reconcile')await this.tasks.fail(tx,await this.tasks.internal(tx,row.task_id),failure);
          else if(row.kind==='reconcile')await this.tasks.emit(tx,row.task_id,'operation.reconciliation-failed',{operationId:row.operation_id,parentOperationId:row.parent_operation_id,error:failure,remoteStoppingVerified:false});
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
    });if(generic?.denial)throw generic.denial;return generic??super.claim(ctx,exclude);
  }
  async preflight(ctx:AuthContext,id:string,fence:number,tx?:Transaction,lightweight=false):Promise<any> {
    const declared=(await (tx??this.store.pool).query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0]?.name;
    if(this.customPreflights.has(declared))return super.preflight(ctx,id,fence,tx,lightweight);
    const run=async(client:Transaction)=>{
      await this.lockPreflight(ctx,id,fence,client);const row=await this.lease(ctx,id,fence,client);if(this.customPreflights.has(row.name))return super.preflight(ctx,id,fence,client,lightweight);
      const {task,authorization}=await this.authorize(client,row);
      const worker=await this.auth.policy(ctx,client);
      if(this.managedNames.has(row.name)){
        requireCondition(worker.scopes.includes(row.scope_id),'FORBIDDEN_SCOPE','Worker cannot reach this asset scope');
        const actor={principalId:row.principal_id,tenantId:row.tenant_id,kind:'user'} as AuthContext;
        return {row,task,authorization:await this.managedPreflight?.(client,actor,row,authorization)};
      }
      requireCondition(worker.targets.includes(row.target),'FORBIDDEN_TARGET','Worker cannot reach this target');return {row,task,authorization};
    };return tx?run(tx):this.store.transaction(run);
  }
  async authorize(client:Transaction,row:any):Promise<any>{
    const actor={principalId:row.principal_id,tenantId:row.tenant_id,kind:'user'} as const,task=await this.tasks.load(actor,row.task_id,'tasks.read',client);
    if(row.kind!=='reconcile')requireCondition(!['delivered','failed','cancelled','unknown'].includes(task.phase),'DECISION_CONFLICT','Task no longer authorizes execution');
    requireCondition(task.inputRevisionId===row.input_revision_id,'INPUT_REVISION_STALE','Operation input changed');
    const cancel=(await client.query('SELECT cancel_requested FROM tasks WHERE task_id=$1',[row.task_id])).rows[0].cancel_requested;if(row.kind!=='reconcile')requireCondition(!cancel,'DECISION_CONFLICT','Task cancellation is pending');
    if(this.managedNames.has(row.name)){
      requireCondition(this.managedAuthorization,'FORBIDDEN_ACTION','Registered execution authorizer is unavailable');return {task,authorization:await this.managedAuthorization(client,actor,row.scope_id,row,task)};
    }
    const grant=row.kind==='reconcile'?(row.name.startsWith('product.')?'product.config.read':row.name==='defects.comment'?'defects.search':row.name):row.name;
    await this.auth.target(actor,grant,row.scope_id,row.target,client);
    if(row.kind!=='reconcile'&&row.approval_id){requireCondition(this.approvalCheck,'APPROVAL_REQUIRED','Bound change verification is unavailable');await this.approvalCheck(client,task,{operationId:row.operation_id,inputRevisionId:row.input_revision_id,name:row.name,target:row.target,targetIdentity:row.target_identity,args:row.args,approvalId:row.approval_id,requesterId:row.principal_id});}
    const authorization=this.connectorCheck?await this.connectorCheck(client,actor,row.scope_id,{...row,name:grant,delegatedOwnerId:row.delegated_owner_id}):undefined;
    return {task,authorization};
  }
  async report(ctx:AuthContext,id:string,body:unknown):Promise<any> {
    const declared=(await this.store.pool.query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0]?.name,custom=this.customReports.get(declared);if(custom)return custom(ctx,id,body);
    const originalReport=ExecutionReport.parse(body),originalReportHash=canonicalHash(originalReport),report=projectWorkerErrors(originalReport);
    Object.defineProperty(report,'originalReportHash',{value:originalReportHash,enumerable:false});
    return this.store.transaction(async tx=>{
      const prior=await this.lease(ctx,id,report.fencingToken,tx,true);
      if(['succeeded','failed'].includes(prior.status)){requireCondition(prior.result.reportHash===originalReportHash,'IDEMPOTENCY_MISMATCH','Different completed receipt');return {deduplicated:true};}
      const {row,task}=await this.preflight(ctx,id,report.fencingToken,tx);requireCondition(report.inputRevisionId===row.input_revision_id,'INPUT_REVISION_STALE','Report revision differs');
      const workerReport=await retainWorkerReport(this.knowledge,tx,task,id,body);Object.defineProperty(report,'workerReport',{value:workerReport,enumerable:false});
      if(row.source_effect==='read'&&report.status==='unknown'){report.status='failed';report.error={code:'UPSTREAM_TIMEOUT',message:'Read outcome is unavailable; retry the query',details:{sideEffects:'none'}};}
      if(this.managedNames.has(row.name)&&report.status!=='unknown'){
        await tx.query('SAVEPOINT managed_receipt');
        try{
          requireCondition(this.managedReport,'EVIDENCE_INSUFFICIENT','Registered receipt processor is unavailable');
          const result=await this.managedReport(tx,task,row,report);await tx.query('RELEASE SAVEPOINT managed_receipt');return result;
        }catch(error){
          await tx.query('ROLLBACK TO SAVEPOINT managed_receipt');await tx.query('RELEASE SAVEPOINT managed_receipt');
          const failure=error instanceof ApiError?{code:error.code,message:error.message,details:error.details}:{code:'RECEIPT_PROCESSING_FAILED',message:'Worker receipt could not be retained',details:{operationId:id,...(/^[0-9A-Z]{5}$/.test(String((error as any)?.code))?{storageCode:String((error as any).code)}:{})}};
          await this.complete(tx,row,'failed',{output:{},error:failure,evidence:[],workerReport,reportHash:originalReportHash,receiptRejected:true,workerStatus:report.status});
          await this.tasks.fail(tx,task,failure);
          return {operationId:id,status:'failed',receiptRejected:true,deduplicated:false};
        }
      }
      const evidence=await this.knowledge.evidence(tx,task,id,row.kind==='reconcile'?'script-conclusion':'unknown',{
        source:'authenticated-worker-observation',workerId:ctx.workerId,inputRevisionId:row.input_revision_id,operationId:id,name:row.name,target:row.target,
        targetIdentity:row.target_identity,actionDigest:row.action_digest,args:row.args,output:report.output,error:report.error},{effects:row.effects});
      const result={output:report.output,error:report.error,evidence:[evidence],workerReport,reportHash:originalReportHash};
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
