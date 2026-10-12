import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {ApiError,ToolName,SourceArtifactId,canonicalHash,requireCondition,type AuthContext,type AssetRegistration} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Tasks} from '../../tasks/src/index.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {Operations} from '../../execution/src/operations.ts';
import type {KnowledgeGraph} from '../../knowledge/src/graph.ts';
import {Ingestions} from '../../knowledge/src/ingestion.ts';
import type {SourceArtifacts} from '../../knowledge/src/source-artifacts.ts';
import {ConnectorOptions,type ToolPackage,type ToolDefinition,type ConnectorProfile} from '../../connectors/src/tool-packages.ts';

export class ToolCatalog {
  store:Store;auth:Auth;assets:Assets;tasks:Tasks;execution:Operations;knowledge:KnowledgeGraph;packages:ToolPackage[];profiles:Record<string,ConnectorProfile>={};
  observed?: (tx:Transaction,ctx:AuthContext,assetId:string,raw:any,originTaskId:string)=>Promise<void>;
  ingestions?:Ingestions;
  sourceArtifacts?:SourceArtifacts;
  constructor(store:Store,auth:Auth,assets:Assets,tasks:Tasks,execution:Operations,knowledge:KnowledgeGraph,packages:ToolPackage[]){Object.assign(this,{store,auth,assets,tasks,execution,knowledge,packages});this.store=store;this.auth=auth;this.assets=assets;this.tasks=tasks;this.execution=execution;this.knowledge=knowledge;this.packages=packages;}
  async initialize(profileFile?:string):Promise<void>{
    if(profileFile){const schema=z.object({profiles:z.record(z.string(),z.object({origin:z.string().url(),root:z.string().optional(),index:z.string().optional(),payloadField:z.string().optional(),authorizationScheme:z.enum(['raw','bearer']).optional(),requestConcurrency:z.number().int().min(1).max(8).optional(),requestIntervalMs:z.number().int().min(0).max(60000).optional(),...ConnectorOptions.shape}).strict())}).strict();this.profiles=schema.parse(JSON.parse(await readFile(profileFile,'utf8'))).profiles;}
  }
  profileFor(configuration:Record<string,unknown>):ConnectorProfile|undefined{
    const profile=this.profiles[configuration.runtimeProfileRef as string],pack=this.packageFor(configuration);if(!profile)return undefined;
    return {...profile,...(configuration.productLineId===undefined?pack?.profileOptions:pack?.productLineOptions?.[configuration.productLineId as string])};
  }
  packageFor(configuration:Record<string,unknown>):ToolPackage|undefined{
    const pack=this.packages.find(p=>p.id===configuration.packageId),line=configuration.productLineId;
    return line===undefined||typeof line==='string'&&Object.hasOwn(pack?.productLinePrefixes??{},line)?pack:undefined;
  }
  definition(packageId:string,suffix:string,configuration?:Record<string,unknown>):ToolDefinition|undefined{return (configuration?this.packageFor(configuration):this.packages.find(p=>p.id===packageId))?.tools.find(t=>t.suffix===suffix);}
  async register(ctx:AuthContext,input:AssetRegistration,assetId:string,tx:Transaction):Promise<void>{
    if(input.kind!=='connector-instance'||!input.configuration.packageId)return;const pack=this.packageFor(input.configuration);
    requireCondition(input.configuration.productLineId===undefined||!!pack,'INVALID_PAYLOAD','Product line does not install this tool package');
    // Inventory can retain assets whose execution package has not been installed.
    // They have no advertised tools and do not gain execution from registration.
    if(!pack){await tx.query('DELETE FROM tool_bindings WHERE asset_id=$1',[assetId]);return;}
    const prefix=ToolName.parse(input.configuration.alias??(input.configuration.productLineId===undefined?pack.prefix:pack.productLinePrefixes![input.configuration.productLineId as string]));
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
    for(const row of rows){const definition=this.definition(row.package_id,row.suffix,row.configuration);if(!definition||!p.grants.includes(definition.permission))continue;
      if(ctx.run&&!ctx.run.tools.includes(row.name))continue;
      let credentials=true;for(const reference of row.declaration.credentials){try{const record=await this.assets.row(ctx,reference,tx,'credentials.use');if(record.owner_principal_id!==ctx.principalId||record.lifecycle==='disabled'||record.configuration.connectorAssetId!==row.asset_id)credentials=false;}catch{credentials=false;}}
      if(!credentials)continue;
      const inputSchema=z.toJSONSchema(definition.schema,{io:'input'});inputSchema.properties={...inputSchema.properties,sourceArtifactId:{type:'string',pattern:'^sar_[a-f0-9]{32}$',description:'Bind an independently approved external source artifact; results retain its revision and provenance'}};
      results.push({row,definition,view:{name:row.name,title:definition.title,description:definition.description,inputSchema,effect:definition.effect,mode:definition.mode,permission:definition.permission,assetId:row.asset_id,assetVersion:row.version}});
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
    requireCondition(task.input.sourceArtifactId===spec.args.sourceArtifactId,'INPUT_REVISION_STALE','Tool source binding differs from its accepted input');
    const sourceArtifact=spec.args.sourceArtifactId?await this.sourceArtifacts!.resolve(ctx,spec.args.sourceArtifactId,scope,tx):undefined;
    requireCondition(sourceArtifact||['candidate.submit','consolidation.fragments'].includes(item.definition.handler)||this.profiles[item.row.configuration.runtimeProfileRef],'SOURCE_UNREACHABLE','Runtime source profile is not configured');
    return {effects:{reads:item.definition.effect==='read'?['registered-source']:['knowledge'],writes:item.definition.effect==='write'?['knowledge-candidates']:[]},assetId:item.row.asset_id,assetVersion:item.row.version,
      packageId:item.row.package_id,handler:item.definition.handler,profile:this.profileFor(item.row.configuration),credentialReferences:item.row.declaration.credentials,sourceArtifact};
  }
  async preflight(tx:Transaction,actor:AuthContext,operation:any,authorization:any):Promise<any>{
    if(authorization.sourceArtifact)return {packageId:authorization.packageId,handler:authorization.handler,profile:authorization.profile??{origin:'http://127.0.0.1'},sourceArtifact:authorization.sourceArtifact,cacheNamespace:canonicalHash(authorization.sourceArtifact)};
    const workerProfile=authorization.profile??(['candidate.submit','consolidation.fragments'].includes(authorization.handler)?{origin:'http://127.0.0.1'}:null);
    requireCondition(workerProfile,'SOURCE_UNREACHABLE','Runtime source profile is not configured');
    let injection:any=null;
    for(const reference of authorization.credentialReferences){const value=await this.assets.executionValue(actor,reference,authorization.assetId);
      requireCondition(!injection,'INVALID_PAYLOAD','This connector uses one authorization credential');
      const binding=JSON.stringify([operation.operation_id,operation.worker_id,operation.fencing_token]);
      const existing=(await tx.query('SELECT * FROM tool_injections WHERE operation_id=$1',[operation.operation_id])).rows[0];
      if(existing){requireCondition(existing.binding===binding,'FENCING_STALE','Credential injection belongs to another execution');injection={key:existing.secret_key,binding};}
      else{const key=await this.assets.vault.put(value,binding);await tx.query('INSERT INTO tool_injections(operation_id,secret_key,binding) VALUES($1,$2,$3)',[operation.operation_id,key,binding]);injection={key,binding};}
    }return {packageId:authorization.packageId,handler:authorization.handler,profile:workerProfile,injection,cacheNamespace:canonicalHash([actor.tenantId,actor.principalId,authorization.assetId,authorization.assetVersion,authorization.credentialReferences])};
  }
  async report(tx:Transaction,task:any,operation:any,report:any):Promise<any>{
    const actor={principalId:task.principalId,tenantId:task.tenantId,kind:'user'} as AuthContext,item=await this.entry(actor,operation.args.toolName,tx),evidence=[];
    let result=report.output.result;
    if(report.status==='succeeded'){
      const policy=await this.auth.policy(actor,tx);
      if(Array.isArray(result?.coverage?.missing)&&!policy.grants.includes('sources.diagnose'))result={...result,coverage:{...result.coverage,missing:result.coverage.missing.map((item:any)=>({...item,code:['SOURCE_ABSENT','SOURCE_FORBIDDEN'].includes(item.code)?'SOURCE_FORBIDDEN':item.code}))}};
      if(item.definition.handler==='candidate.submit')result=await this.knowledge.candidateFromReturns(tx,actor,task.scopeId,task.taskId,operation.args.input);
      else if(item.definition.handler==='consolidation.fragments'){const selected=await this.knowledge.sharedFragments(tx,actor,task.scopeId,operation.args.input.limit??20,operation.args.input.after);result=selected.result;evidence.push(...selected.evidence);}
      else{requireCondition(Array.isArray(report.output.raw)&&report.output.raw.length>0,'EVIDENCE_INSUFFICIENT','Read tools require original returns');
        const references=new Map<string,any>();
        const artifact=task.input.sourceArtifactId?await this.sourceArtifacts!.resolve(actor,task.input.sourceArtifactId,task.scopeId,tx):null;
        if(artifact)result={...result,source:{...result?.source,sourceArtifactId:artifact.sourceArtifactId,assetId:artifact.assetId,assetVersion:artifact.assetVersion,manifestSha256:artifact.assetSha256,origin:'uploaded-artifact',live:false}};
        for(const raw of report.output.raw){let ref:any;
          if(artifact)ref=await this.sourceArtifacts!.capture(tx,actor,task.scopeId,artifact,raw,item.definition.permission);
          else ref=await this.knowledge.capture(tx,actor,task.scopeId,item.row.asset_id,{...raw,sourceType:raw.sourceType??report.output.sourceType},item.definition.permission);
          evidence.push({evidenceId:ref.evidenceId,sha256:ref.sha256});references.set(raw.path,ref);if(!artifact)await this.observed?.(tx,actor,item.row.asset_id,raw,task.taskId);}
        const projection=this.packages.find(pack=>pack.id===item.row.package_id)?.projection;
        if(projection){requireCondition(this.ingestions,'INTERNAL_ERROR','Source ingestion outbox is not configured');const profile=this.profileFor(item.row.configuration)??{origin:'http://127.0.0.1'};const indexed=await this.ingestions.enqueue(tx,task,item.row.package_id,projection.version,{...profile,...(artifact?{sourceArtifact:artifact}:{})},[...references.values()]);await this.tasks.emit(tx,task.taskId,'knowledge.indexing.linked',indexed);}
      }
    }
    const receipt={output:{result},evidence,reportHash:canonicalHash(report),error:report.error};
    await this.execution.complete(tx,operation,report.status,receipt);
    if(report.status==='succeeded'){
      await tx.query("UPDATE tasks SET result=$2,result_status='succeeded' WHERE task_id=$1",[task.taskId,JSON.stringify({result,evidence,artifacts:[],unmapped:[]})]);
      await this.tasks.stage(tx,task,'delivered','done','task.delivered',{status:'succeeded',evidence,result});
    }else await this.tasks.fail(tx,task,report.error??{code:'INTERNAL_ERROR',message:'Tool failed'});
    return {operationId:operation.operation_id,status:report.status,deduplicated:false};
  }
  async call(ctx:AuthContext,name:string,input:{args:Record<string,unknown>;idempotencyKey:string;sourceArtifactId?:string},signal?:AbortSignal):Promise<any>{
    const initial=await this.entry(ctx,name),{sourceArtifactId:argumentBinding,...professionalArgs}=input.args,args=initial.definition.schema.parse(professionalArgs);
    const implicit=initial.definition.sourceParameter?args[initial.definition.sourceParameter]:undefined,sourceArtifactId=SourceArtifactId.optional().parse(input.sourceArtifactId??argumentBinding??(this.sourceArtifacts?.external(implicit)?implicit:undefined));
    requireCondition(!input.sourceArtifactId||!argumentBinding||input.sourceArtifactId===argumentBinding,'INVALID_PAYLOAD','Tool source binding fields differ');
    requireCondition(!this.sourceArtifacts?.external(implicit)||implicit===sourceArtifactId,'INVALID_PAYLOAD','Professional selector and source artifact binding differ');
    if(sourceArtifactId)await this.sourceArtifacts!.resolve(ctx,sourceArtifactId,initial.row.scope_id);
    const accepted=await this.store.transaction(async tx=>{
      const item=await this.entry(ctx,name,tx);
      requireCondition(item.row.sha256===initial.row.sha256&&item.row.version===initial.row.version,'APPROVAL_STALE','Tool revision changed during admission');
      const task=await this.tasks.submit(ctx,{scopeId:item.row.scope_id,title:item.definition.title,capabilityPackId:'asset-tool',idempotencyKey:canonicalHash(['tool-call',ctx.run?.taskId??null,name,input.idempotencyKey]),input:{toolName:name,args,assetId:item.row.asset_id,assetVersion:item.row.version,assetSha256:item.row.sha256,...(sourceArtifactId?{sourceArtifactId}:{})}},tx);
      if(!task.deduplicated){await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({privateOwnerId:ctx.principalId,...(ctx.run?{parentRunTaskId:ctx.run.taskId}:{})})]);await this.tasks.stage(tx,task,'running','tool-pending','task.running');await this.execution.submit(ctx,task.taskId,{name:'tools.invoke',inputRevisionId:task.inputRevisionId,target:item.row.asset_id,targetIdentity:item.row.sha256,args:{toolName:name,input:args,assetVersion:item.row.version,...(sourceArtifactId?{sourceArtifactId}:{})},idempotencyKey:canonicalHash([ctx.run?.taskId??null,input.idempotencyKey]),deadlineMs:300_000},tx);}
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
