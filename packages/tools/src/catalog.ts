import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {ApiError,ToolName,canonicalHash,requireCondition,type AuthContext,type AssetRegistration} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Tasks} from '../../tasks/src/index.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {Operations} from '../../execution/src/operations.ts';
import type {KnowledgeGraph} from '../../knowledge/src/graph.ts';
import type {ToolPackage,ToolDefinition,ConnectorProfile} from '../../connectors/src/tool-packages.ts';

export class ToolCatalog {
  store:Store;auth:Auth;assets:Assets;tasks:Tasks;execution:Operations;knowledge:KnowledgeGraph;packages:ToolPackage[];profiles:Record<string,ConnectorProfile>={};
  constructor(store:Store,auth:Auth,assets:Assets,tasks:Tasks,execution:Operations,knowledge:KnowledgeGraph,packages:ToolPackage[]){Object.assign(this,{store,auth,assets,tasks,execution,knowledge,packages});this.store=store;this.auth=auth;this.assets=assets;this.tasks=tasks;this.execution=execution;this.knowledge=knowledge;this.packages=packages;}
  async initialize(profileFile?:string):Promise<void>{
    if(profileFile){const schema=z.object({profiles:z.record(z.string(),z.object({origin:z.string().url(),root:z.string().optional(),index:z.string().optional(),payloadField:z.string().optional()}).strict())}).strict();this.profiles=schema.parse(JSON.parse(await readFile(profileFile,'utf8'))).profiles;}
  }
  definition(packageId:string,suffix:string):ToolDefinition|undefined{return this.packages.find(p=>p.id===packageId)?.tools.find(t=>t.suffix===suffix);}
  async register(ctx:AuthContext,input:AssetRegistration,assetId:string,tx:Transaction):Promise<void>{
    if(input.kind!=='connector-instance'||!input.configuration.packageId)return;const pack=this.packages.find(p=>p.id===input.configuration.packageId);
    // Inventory can retain assets whose execution package has not been installed.
    // They have no advertised tools and do not gain execution from registration.
    if(!pack){await tx.query('DELETE FROM tool_bindings WHERE asset_id=$1',[assetId]);return;}
    const prefix=ToolName.parse(input.configuration.alias??pack.prefix);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`tool-names:${ctx.tenantId}`]);
    for(const definition of pack.tools){const name=ToolName.parse(`${prefix}.${definition.suffix}`),existing=(await tx.query('SELECT asset_id FROM tool_bindings WHERE tenant_id=$1 AND name=$2',[ctx.tenantId,name])).rows[0];requireCondition(!existing||existing.asset_id===assetId,'TOOL_NAME_CONFLICT','Tool name is already registered in this tenant');}
    if(pack.tools.some(tool=>tool.effect==='write'))requireCondition(input.declaration.writes.includes('knowledge-candidates'),'INVALID_PAYLOAD','Asset declaration must include its candidate writes');
    await tx.query('DELETE FROM tool_bindings WHERE asset_id=$1',[assetId]);
    for(const definition of pack.tools)await tx.query('INSERT INTO tool_bindings(tenant_id,name,asset_id,version,package_id,suffix) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,`${prefix}.${definition.suffix}`,assetId,input.version,pack.id,definition.suffix]);
  }
  async available(ctx:AuthContext,tx?:Transaction):Promise<{row:any;definition:ToolDefinition;view:any}[]>{
    const p=await this.auth.policy(ctx,tx);
    if(!['tasks.read','tasks.submit'].every(grant=>p.grants.includes(grant)))return [];
    const rows=(await (tx??this.store.pool).query(`SELECT b.*,a.scope_id,a.owner_principal_id,v.sha256,v.configuration,v.declaration FROM tool_bindings b
      JOIN assets a ON a.asset_id=b.asset_id AND a.current_version=b.version JOIN asset_versions v ON v.asset_id=b.asset_id AND v.version=b.version
      WHERE b.tenant_id=$1 AND a.scope_id=ANY($2::text[]) AND v.lifecycle='running' AND v.approved_digest=v.sha256
      AND (a.owner_principal_id=$3 OR v.readers ? $3 OR v.readers ? '*') ORDER BY b.name`,[p.tenantId,p.scopes,p.principalId])).rows;
    const results=[];
    for(const row of rows){const definition=this.definition(row.package_id,row.suffix);if(!definition||!p.grants.includes(definition.permission))continue;
      if(ctx.run&&!ctx.run.tools.includes(row.name))continue;
      let credentials=true;for(const reference of row.declaration.credentials){try{const record=await this.assets.row(ctx,reference,tx,'credentials.use');if(record.owner_principal_id!==ctx.principalId||record.lifecycle==='disabled'||record.configuration.connectorAssetId!==row.asset_id)credentials=false;}catch{credentials=false;}}
      if(!credentials)continue;
      results.push({row,definition,view:{name:row.name,title:definition.title,description:definition.description,inputSchema:z.toJSONSchema(definition.schema),effect:definition.effect,mode:definition.mode,permission:definition.permission,assetId:row.asset_id,assetVersion:row.version}});
    }return results;
  }
  async list(ctx:AuthContext):Promise<{tools:any[];etag:string}>{return this.store.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const entries=await this.available(ctx,tx),tools=entries.map(entry=>entry.view);
    return {tools,etag:`"${canonicalHash({principalId:ctx.principalId,tenantId:ctx.tenantId,tools,pins:entries.map(entry=>entry.row.sha256)})}"`};
  });}
  async entry(ctx:AuthContext,name:string,tx?:Transaction):Promise<any>{
    const item=(await this.available(ctx,tx)).find(entry=>entry.row.name===name);if(item)return item;
    const p=await this.auth.policy(ctx,tx);if(p.grants.includes('sources.diagnose')){const exists=(await (tx??this.store.pool).query('SELECT 1 FROM tool_bindings WHERE tenant_id=$1 AND name=$2',[p.tenantId,name])).rowCount;if(!exists)throw new ApiError('SOURCE_ABSENT','Tool is absent from the authorized catalog');}
    throw new ApiError('SOURCE_FORBIDDEN','Tool is not available to this identity');
  }
  async authorize(tx:Transaction,ctx:AuthContext,scope:string,spec:any,task:any):Promise<any>{
    const item=await this.entry(ctx,spec.args.toolName,tx);
    requireCondition(task.capabilityPackId==='asset-tool'&&task.principalId===ctx.principalId,'FORBIDDEN_ACTION','Registered calls require their own accepted task');
    requireCondition(task.input.toolName===spec.args.toolName&&canonicalHash(task.input.args)===canonicalHash(spec.args.input)&&task.input.assetId===spec.target&&task.input.assetVersion===spec.args.assetVersion&&task.input.assetSha256===(spec.targetIdentity??spec.target_identity),'INPUT_REVISION_STALE','Operation differs from the pinned tool input');
    const context=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[task.taskId])).rows[0].context;
    if(context.parentRunTaskId){const parent=(await tx.query('SELECT phase,cancel_requested FROM tasks WHERE task_id=$1',[context.parentRunTaskId])).rows[0];requireCondition(parent&&!parent.cancel_requested&&!['failed','delivered','unknown','cancelled'].includes(parent.phase),'DECISION_CONFLICT','Parent run no longer authorizes new child effects');}
    requireCondition(item.row.scope_id===scope&&item.row.asset_id===(spec.target??spec.assetId),'FORBIDDEN_SCOPE','Tool asset partition differs');
    requireCondition(item.row.version===spec.args.assetVersion&&item.row.sha256===(spec.targetIdentity??spec.target_identity),'APPROVAL_STALE','Tool asset revision changed');
    item.definition.schema.parse(spec.args.input);
    requireCondition(item.definition.handler==='candidate.submit'||this.profiles[item.row.configuration.runtimeProfileRef],'SOURCE_UNREACHABLE','Runtime source profile is not configured');
    return {effects:{reads:item.definition.effect==='read'?['registered-source']:['knowledge'],writes:item.definition.effect==='write'?['knowledge-candidates']:[]},assetId:item.row.asset_id,assetVersion:item.row.version,
      packageId:item.row.package_id,handler:item.definition.handler,profile:this.profiles[item.row.configuration.runtimeProfileRef],credentialReferences:item.row.declaration.credentials};
  }
  async preflight(tx:Transaction,actor:AuthContext,operation:any,authorization:any):Promise<any>{
    const workerProfile=authorization.profile??(authorization.handler==='candidate.submit'?{origin:'http://127.0.0.1'}:null);
    requireCondition(workerProfile,'SOURCE_UNREACHABLE','Runtime source profile is not configured');
    let injection:any=null;
    for(const reference of authorization.credentialReferences){const value=await this.assets.executionValue(actor,reference,authorization.assetId);
      requireCondition(!injection,'INVALID_PAYLOAD','This connector uses one authorization credential');
      const binding=JSON.stringify([operation.operation_id,operation.worker_id,operation.fencing_token]);
      const existing=(await tx.query('SELECT * FROM tool_injections WHERE operation_id=$1',[operation.operation_id])).rows[0];
      if(existing){requireCondition(existing.binding===binding,'FENCING_STALE','Credential injection belongs to another execution');injection={key:existing.secret_key,binding};}
      else{const key=await this.assets.vault.put(value,binding);await tx.query('INSERT INTO tool_injections(operation_id,secret_key,binding) VALUES($1,$2,$3)',[operation.operation_id,key,binding]);injection={key,binding};}
    }return {packageId:authorization.packageId,handler:authorization.handler,profile:workerProfile,injection};
  }
  async report(tx:Transaction,task:any,operation:any,report:any):Promise<any>{
    const actor={principalId:task.principalId,tenantId:task.tenantId,kind:'user'} as AuthContext,item=await this.entry(actor,operation.args.toolName,tx),evidence=[];
    let result=report.output.result;
    if(report.status==='succeeded'){
      if(item.definition.handler==='candidate.submit')result=await this.knowledge.candidateFromReturns(tx,actor,task.scopeId,task.taskId,operation.args.input);
      else{requireCondition(Array.isArray(report.output.raw)&&report.output.raw.length>0,'EVIDENCE_INSUFFICIENT','Read tools require original returns');
        for(const raw of report.output.raw)evidence.push(await this.knowledge.capture(tx,actor,task.scopeId,item.row.asset_id,{...raw,sourceType:raw.sourceType??report.output.sourceType}));}
    }
    const receipt={output:{result},evidence,reportHash:canonicalHash(report),error:report.error};
    await this.execution.complete(tx,operation,report.status,receipt);
    if(report.status==='succeeded'){
      await tx.query("UPDATE tasks SET result=$2,result_status='succeeded' WHERE task_id=$1",[task.taskId,JSON.stringify({result,evidence,artifacts:[],unmapped:[]})]);
      await this.tasks.stage(tx,task,'delivered','done','task.delivered',{status:'succeeded',evidence,result});
    }else await this.tasks.fail(tx,task,report.error??{code:'INTERNAL_ERROR',message:'Tool failed'});
    return {operationId:operation.operation_id,status:report.status,deduplicated:false};
  }
  async call(ctx:AuthContext,name:string,input:{args:Record<string,unknown>;idempotencyKey:string},signal?:AbortSignal):Promise<any>{
    const initial=await this.entry(ctx,name),args=initial.definition.schema.parse(input.args);
    const accepted=await this.store.transaction(async tx=>{
      const item=await this.entry(ctx,name,tx);
      requireCondition(item.row.sha256===initial.row.sha256&&item.row.version===initial.row.version,'APPROVAL_STALE','Tool revision changed during admission');
      const task=await this.tasks.submit(ctx,{scopeId:item.row.scope_id,title:item.definition.title,capabilityPackId:'asset-tool',idempotencyKey:canonicalHash(['tool-call',ctx.run?.taskId??null,name,input.idempotencyKey]),input:{toolName:name,args,assetId:item.row.asset_id,assetVersion:item.row.version,assetSha256:item.row.sha256}},tx);
      if(!task.deduplicated){await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({privateOwnerId:ctx.principalId,...(ctx.run?{parentRunTaskId:ctx.run.taskId}:{})})]);await this.tasks.stage(tx,task,'running','tool-pending','task.running');await this.execution.submit(ctx,task.taskId,{name:'tools.invoke',inputRevisionId:task.inputRevisionId,target:item.row.asset_id,targetIdentity:item.row.sha256,args:{toolName:name,input:args,assetVersion:item.row.version},idempotencyKey:canonicalHash([ctx.run?.taskId??null,input.idempotencyKey]),deadlineMs:300_000},tx);}
      return task;
    });
    if(initial.definition.mode==='task')return {taskId:accepted.taskId,phase:accepted.phase};
    const deadline=Date.now()+30_000;
    do{
      const result=await this.tasks.result(ctx,accepted.taskId);
      if(result.status==='succeeded')return {result:result.result,evidence:result.evidence.map((e:any)=>({evidenceId:e.evidenceId,sha256:e.sha256}))};
      if(result.error){let error=result.error;const p=await this.auth.policy(ctx);if(['SOURCE_ABSENT','SOURCE_FORBIDDEN'].includes(error.code)&&!p.grants.includes('sources.diagnose'))error={code:'SOURCE_FORBIDDEN',message:'Source is not available to this identity'};throw new ApiError(error.code,error.message,error.details??{});}
      if(signal?.aborted||Date.now()>deadline)throw new ApiError('UPSTREAM_TIMEOUT','Tool task has not returned a verified receipt',{taskId:accepted.taskId,remoteStoppingVerified:false});
      await delay(25);
    }while(true);
  }
}
