import {ApiError,Base64Content,MAX_SOURCE_BYTES,SafeRelativePath,SkillPackSubmission,SkillRunInput,ScopeId,canonicalHash,canonicalJson,newId,requireCondition,sha256,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Tasks} from '../../tasks/src/index.ts';
import type {Approvals} from '../../tasks/src/approvals.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {ToolCatalog} from '../../tools/src/catalog.ts';
import type {Operations} from '../../execution/src/operations.ts';
import type {Knowledge} from '../../knowledge/src/index.ts';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';

export class SkillPacks {
  store:Store;auth:Auth;tasks:Tasks;approvals:Approvals;assets:Assets;catalog:ToolCatalog;execution:Operations;objects:Knowledge;
  runtime:any;
  privateSocketPath='';
  secrets=new Map<string,{token:string;digest:string}>();
  constructor(store:Store,auth:Auth,tasks:Tasks,approvals:Approvals,assets:Assets,catalog:ToolCatalog,execution:Operations,objects:Knowledge){this.store=store;this.auth=auth;this.tasks=tasks;this.approvals=approvals;this.assets=assets;this.catalog=catalog;this.execution=execution;this.objects=objects;}
  async initialize(file?:string):Promise<void>{if(!file)return;const schema=z.object({circleBin:z.string().min(1),circleCommit:z.string().regex(/^[a-f0-9]{40}$/),circleVersion:z.string().min(1),model:z.object({kind:z.literal('scripted'),base_url:z.string().url(),model:z.string().min(1),protocol:z.literal('openai'),api_key:z.string().min(1)}).strict()}).strict();this.runtime=schema.parse(JSON.parse(await readFile(file,'utf8')));const url=new URL(this.runtime.model.base_url);requireCondition(url.hostname==='127.0.0.1'&&url.protocol==='http:','FORBIDDEN_ACTION','Development execution permits a loopback script model only');}
  view(row:any):any{return {skillPackId:row.skill_pack_id,digest:row.digest,status:row.status,check:{undeclaredTools:[],missingTools:[]},approvalTaskId:row.approval_task_id,
    manifest:row.manifest,ownerPrincipalId:row.owner_id,scopeId:row.scope_id,assetId:row.asset_id,assetVersion:row.asset_version};}
  async row(ctx:AuthContext,id:string,grant:string,tx?:Transaction):Promise<any>{
    const p=await this.auth.check(ctx,grant,undefined,tx),row=(await (tx??this.store.pool).query('SELECT * FROM skill_packages WHERE skill_pack_id=$1 AND tenant_id=$2 AND scope_id=ANY($3::text[])',[id,p.tenantId,p.scopes])).rows[0];
    requireCondition(row,'SOURCE_FORBIDDEN','Skill package is not available to this identity');await this.assets.row(ctx,row.asset_id,tx,'assets.read');return row;
  }
  async checkWithDetails(ctx:AuthContext,manifest:any,trial:any,tx?:Transaction):Promise<any>{
    const available=new Set((await this.catalog.available(ctx,tx)).map(entry=>entry.view.name)),declared=new Set<string>(manifest.tools),check={undeclaredTools:[...new Set<string>(trial.toolCalls.map((call:any)=>call.name).filter((name:string)=>!declared.has(name)))].sort(),missingTools:manifest.tools.filter((name:string)=>!available.has(name)).sort()};
    if(check.undeclaredTools.length||check.missingTools.length)throw new ApiError('SKILLPACK_CHECK_FAILED','Skill tools do not match the declared accessible catalog',{check});return check;
  }
  async submit(ctx:AuthContext,value:unknown,requestedScope?:string):Promise<any>{
    const input=SkillPackSubmission.parse(value),policy=await this.auth.check(ctx,'skillpacks.submit');
    const scope=requestedScope?ScopeId.parse(requestedScope):policy.scopes.length===1?policy.scopes[0]:null;requireCondition(scope,'INVALID_PAYLOAD','Specify X-Scope-Id when more than one scope is authorized');await this.auth.check(ctx,'skillpacks.submit',scope);
    requireCondition(new Set(input.files.map(file=>file.path)).size===input.files.length&&input.files.some(file=>file.path==='SKILL.md'),'INVALID_PAYLOAD','Skill files require one SKILL.md and unique paths');
    const files=input.files.map(file=>{const bytes=Buffer.from(file.base64,'base64');requireCondition(bytes.length<=MAX_SOURCE_BYTES&&sha256(bytes)===file.sha256,'SOURCE_HASH_MISMATCH','Submitted file SHA differs');return {path:file.path,sha256:file.sha256,size:bytes.length};}).sort((a,b)=>a.path.localeCompare(b.path));
    requireCondition(files.reduce((sum,file)=>sum+file.size,0)<=MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Skill files exceed sixteen MiB');
    await this.checkWithDetails(ctx,input.manifest,input.trial);
    const digest=canonicalHash({manifest:input.manifest,files,trial:input.trial});
    for(const file of input.files)await this.objects.objects.putObject({Bucket:'evidence',Key:file.sha256,Body:Buffer.from(file.base64,'base64')});
    return this.store.transaction(async tx=>{
      await this.checkWithDetails(ctx,input.manifest,input.trial,tx);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson([ctx.tenantId,scope,ctx.principalId,digest])]);
      const old=(await tx.query('SELECT * FROM skill_packages WHERE tenant_id=$1 AND scope_id=$2 AND owner_id=$3 AND digest=$4',[ctx.tenantId,scope,ctx.principalId,digest])).rows[0];if(old)return this.view(old);
      const prior=(await tx.query("SELECT s.* FROM skill_packages s WHERE tenant_id=$1 AND scope_id=$2 AND owner_id=$3 AND manifest->>'id'=$4 ORDER BY created_at DESC LIMIT 1",[ctx.tenantId,scope,ctx.principalId,input.manifest.id])).rows[0];
      const id=newId('skp'),asset=await this.assets.register(ctx,{...(prior?{assetId:prior.asset_id}:{}),scopeId:scope,kind:'skill-package',name:input.manifest.title,version:input.manifest.version,
        declaration:{reads:input.manifest.tools,writes:['artifacts-evidence'],credentials:[]},configuration:{skillPackId:id,digest},readers:[ctx.principalId,'*']},tx);
      const task=await this.tasks.submit(ctx,{scopeId:scope,title:`Register ${input.manifest.title}`,capabilityPackId:'asset-registration',idempotencyKey:canonicalHash(['skill-register',digest]),input:{skillPackId:id,digest,assetId:asset.assetId,assetVersion:asset.version}},tx);
      await tx.query(`INSERT INTO skill_packages(skill_pack_id,tenant_id,scope_id,owner_id,digest,manifest,files,trial,asset_id,asset_version,approval_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,ctx.tenantId,scope,ctx.principalId,digest,JSON.stringify(input.manifest),JSON.stringify(files),JSON.stringify(input.trial),asset.assetId,asset.version,task.taskId]);
      const approval=await this.approvals.propose(ctx,task.taskId,{inputRevisionId:task.inputRevisionId,name:'assets.publish',target:asset.assetId,targetIdentity:asset.sha256,args:{skillPackId:id,digest}},tx);
      await tx.query('UPDATE skill_packages SET approval_id=$2 WHERE skill_pack_id=$1',[id,approval.approvalId]);return this.view((await tx.query('SELECT * FROM skill_packages WHERE skill_pack_id=$1',[id])).rows[0]);
    });
  }
  async list(ctx:AuthContext):Promise<any[]>{
    const p=await this.auth.check(ctx,'skillpacks.read'),rows=(await this.store.pool.query('SELECT * FROM skill_packages WHERE tenant_id=$1 AND scope_id=ANY($2::text[]) ORDER BY created_at DESC,skill_pack_id',[p.tenantId,p.scopes])).rows,visible=[];
    for(const row of rows){try{await this.assets.row(ctx,row.asset_id);visible.push(this.view(row));}catch(error){if(!(error instanceof ApiError))throw error;}}return visible;
  }
  async approvalAuthorize(tx:Transaction,ctx:AuthContext,task:any,action:any):Promise<void>{
    const row=await this.row(ctx,action.args.skillPackId,'skillpacks.submit',tx);
    requireCondition(row.owner_id===ctx.principalId&&row.approval_task_id===task.taskId&&row.digest===action.args.digest&&task.input.digest===row.digest,'APPROVAL_STALE','Package approval binding differs');
    const asset=await this.assets.row(ctx,row.asset_id,tx);requireCondition(asset.sha256===action.targetIdentity&&asset.asset_id===action.target&&asset.version===row.asset_version,'APPROVAL_STALE','Package target revision differs');
  }
  async approvalCheck(tx:Transaction,ctx:AuthContext,task:any,approval:any,answer:any):Promise<void>{
    const actor={principalId:approval.applicant_id,tenantId:task.tenantId,kind:'user'} as AuthContext;await this.approvalAuthorize(tx,actor,task,approval.action);
    const row=await this.row(actor,approval.action.args.skillPackId,'skillpacks.submit',tx);if(answer.approve)await this.checkWithDetails(actor,row.manifest,row.trial,tx);
    await this.auth.check(ctx,'assets.approve',task.scopeId,tx);
  }
  async approved(tx:Transaction,ctx:AuthContext,task:any,approval:any,answer:any):Promise<void>{
    const row=(await tx.query('SELECT * FROM skill_packages WHERE approval_task_id=$1',[task.taskId])).rows[0];
    if(answer.approve)await tx.query("UPDATE asset_versions SET lifecycle='approved',approved_by=$3,approved_digest=sha256 WHERE asset_id=$1 AND version=$2",[row.asset_id,row.asset_version,ctx.principalId]);
    await tx.query('UPDATE skill_packages SET status=$2 WHERE skill_pack_id=$1',[row.skill_pack_id,answer.approve?'registered':'declined']);
    await tx.query("UPDATE tasks SET result_status='succeeded',result=$2 WHERE task_id=$1",[task.taskId,JSON.stringify({skillPackId:row.skill_pack_id,digest:row.digest})]);await this.tasks.stage(tx,task,'delivered','done','task.delivered',{status:answer.approve?'registered':'declined',digest:row.digest});
  }
  async run(ctx:AuthContext,id:string,value:unknown):Promise<any>{
    const input=SkillRunInput.parse(value);return this.store.transaction(async tx=>{
      const row=await this.row(ctx,id,'skillpacks.run',tx);requireCondition(row.status==='registered','APPROVAL_REQUIRED','Package requires bound registration approval');
      requireCondition(row.manifest.triggers.includes('manual'),'FORBIDDEN_ACTION','Package does not allow a manual trigger');await this.checkWithDetails(ctx,row.manifest,row.trial,tx);
      const asset=await this.assets.row(ctx,row.asset_id,tx);requireCondition(asset.version===row.asset_version&&['approved','running'].includes(asset.lifecycle)&&asset.approved_digest===asset.sha256,'APPROVAL_STALE','Package asset revision is no longer approved');
      const task=await this.tasks.submit(ctx,{scopeId:row.scope_id,title:`Run ${row.manifest.title}`,capabilityPackId:'skill-run',idempotencyKey:canonicalHash(['skill-run',id,input.idempotencyKey]),input:{skillPackId:id,digest:row.digest,assetId:row.asset_id,assetVersion:row.asset_version,assetSha256:asset.sha256,inputs:input.inputs}},tx);
      if(!task.deduplicated){await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({privateOwnerId:ctx.principalId})]);await this.tasks.stage(tx,task,'running','runtime-pending','task.running');
        await this.execution.submit(ctx,task.taskId,{name:'assets.execute',inputRevisionId:task.inputRevisionId,target:row.asset_id,targetIdentity:asset.sha256,args:{skillPackId:id,digest:row.digest,inputs:input.inputs},idempotencyKey:input.idempotencyKey,deadlineMs:300_000},tx);}
      return {taskId:task.taskId};
    });
  }
  async authorize(tx:Transaction,ctx:AuthContext,scope:string,spec:any,task:any):Promise<any>{
    const row=await this.row(ctx,spec.args.skillPackId,'skillpacks.run',tx),asset=await this.assets.row(ctx,row.asset_id,tx);
    requireCondition(row.status==='registered'&&['approved','running'].includes(asset.lifecycle)&&asset.approved_digest===asset.sha256,'APPROVAL_REQUIRED','Package registration is not active');
    requireCondition(row.scope_id===scope&&task.principalId===ctx.principalId&&task.capabilityPackId==='skill-run'&&task.input.digest===row.digest&&spec.args.digest===row.digest&&asset.asset_id===spec.target&&asset.sha256===(spec.targetIdentity??spec.target_identity)&&canonicalHash(task.input.inputs)===canonicalHash(spec.args.inputs),'APPROVAL_STALE','Runtime input or package target differs');
    await this.checkWithDetails(ctx,row.manifest,row.trial,tx);requireCondition(this.runtime,'SOURCE_UNREACHABLE','Circle runtime profile is not configured');
    return {effects:{reads:['registered-assets'],writes:['artifacts-evidence']},skillPackId:row.skill_pack_id,manifest:row.manifest,files:row.files,runtime:this.runtime,scopeId:row.scope_id};
  }
  async preflight(tx:Transaction,ctx:AuthContext,operation:any,authorization:any):Promise<any>{
    return {skillPackId:authorization.skillPackId,manifest:authorization.manifest,files:authorization.files,privateSocketPath:this.privateSocketPath,scopeId:authorization.scopeId,principalId:ctx.principalId};
  }
  async privateSecret(worker:AuthContext,operationId:string,fence:number,revoke=false):Promise<any>{
    const checked=await this.execution.preflight(worker,operationId,fence);requireCondition(checked.row.name==='assets.execute','FORBIDDEN_ACTION','Only an authorized runtime operation receives a run token');
    const key=`${operationId}/${fence}`,prior=this.secrets.get(key);
    if(revoke){if(prior){await this.auth.revokeRun(prior.digest);this.secrets.delete(key);}return {revoked:true};}
    const actor={principalId:checked.task.principalId,tenantId:checked.task.tenantId,kind:'user'} as AuthContext,row=await this.row(actor,checked.task.input.skillPackId,'skillpacks.run');
    await this.checkWithDetails(actor,row.manifest,row.trial);const p=await this.auth.policy(actor),entries=(await this.catalog.available(actor)).filter(entry=>row.manifest.tools.includes(entry.view.name));
    const grants=[...new Set(['tasks.read','tasks.submit','sources.read','evidence.read','credentials.use',...entries.map(entry=>entry.definition.permission)])].filter(grant=>p.grants.includes(grant));
    const scopes=[...new Set([row.scope_id,...entries.map(entry=>entry.row.scope_id)])];
    const secret=prior??await this.auth.issueRun(actor,{taskId:checked.task.taskId,tools:row.manifest.tools,grants,scopes});this.secrets.set(key,secret);
    return {runtime:this.runtime,serverToken:secret.token};
  }
  async event(ctx:AuthContext,id:string,fence:number,inputRevisionId:string,event:any):Promise<any>{return this.store.transaction(async tx=>{
    const checked=await this.execution.preflight(ctx,id,fence,tx);requireCondition(checked.row.name==='assets.execute'&&checked.task.inputRevisionId===inputRevisionId,'INPUT_REVISION_STALE','Runtime event input differs');
    requireCondition(event&&typeof event.type==='string'&&event.type.length<100,'INVALID_PAYLOAD','RPC event type is missing');
    await this.tasks.emit(tx,checked.task.taskId,`runtime.${event.type}`,{inputRevisionId,event});return {accepted:true};
  });}
  async stopped(ctx:AuthContext,id:string,value:any):Promise<any>{return this.store.transaction(async tx=>{
    const row=await this.execution.lease(ctx,id,value.fencingToken,tx);requireCondition(row.name==='assets.execute'&&row.input_revision_id===value.inputRevisionId,'FENCING_STALE','Local exit observation belongs to another runtime revision');
    requireCondition(value.localExitObserved===true,'EVIDENCE_INSUFFICIENT','Local process exit was not observed');
    await tx.query("UPDATE operations SET status='unknown',result=$2 WHERE operation_id=$1",[id,JSON.stringify({localExitObserved:true,remoteStoppingVerified:false,observedBy:ctx.workerId})]);await tx.query('DELETE FROM leases WHERE operation_id=$1',[id]);await tx.query('UPDATE resources SET frozen=true WHERE tenant_id=$1 AND resource_id=$2',[row.tenant_id,row.resource_id]);
    const key=`${id}/${value.fencingToken}`,secret=this.secrets.get(key);if(secret){await tx.query('UPDATE auth_tokens SET expires_at=clock_timestamp() WHERE digest=$1',[secret.digest]);this.secrets.delete(key);}
    const task=await this.tasks.internal(tx,row.task_id);if(task.inputRevisionId===row.input_revision_id)await this.tasks.stage(tx,task,'unknown','reconcile','runtime.local-stopped',{operationId:id,localExitObserved:true,remoteStoppingVerified:false});
    return {status:'unknown',localExitObserved:true,remoteStoppingVerified:false};
  });}
  async report(tx:Transaction,task:any,operation:any,report:any):Promise<any>{
    const ctx={principalId:task.principalId,tenantId:task.tenantId,kind:'user'} as AuthContext,row=await this.row(ctx,task.input.skillPackId,'skillpacks.run',tx);
    if(report.status!=='succeeded'){await this.execution.complete(tx,operation,'failed',{error:report.error,reportHash:canonicalHash(report)});await this.tasks.fail(tx,task,report.error);return {operationId:operation.operation_id,status:'failed',deduplicated:false};}
    requireCondition(report.output.runtime?.agentSettled===true&&report.output.runtime.circleCommit===this.runtime.circleCommit&&report.output.runtime.circleVersion===this.runtime.circleVersion,'RUNTIME_VERSION_MISMATCH','Runtime receipt differs from the pinned executable');
    const outputs=report.output.outputs;requireCondition(Array.isArray(outputs)&&outputs.length===row.manifest.outputs.length&&new Set(outputs.map((output:any)=>output.path)).size===outputs.length&&row.manifest.outputs.every((path:string)=>outputs.some((output:any)=>output.path===path)),'EVIDENCE_INSUFFICIENT','Declared runtime outputs are incomplete');
    const inputBytes=Buffer.from(canonicalJson(task.input.inputs)),inputHash=sha256(inputBytes);await this.objects.objects.putObject({Bucket:'evidence',Key:inputHash,Body:inputBytes});
    const source=(await tx.query(`INSERT INTO sources(source_revision_id,tenant_id,scope_id,principal_id,sha256,size,object_key,file_name) VALUES($1,$2,$3,$4,$5,$6,$5,'inputs.json')
      ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,[newId('src'),task.tenantId,task.scopeId,task.principalId,inputHash,inputBytes.length])).rows[0];
    const artifacts=[];let total=0;
    for(const output of outputs){SafeRelativePath.parse(output.path);Base64Content.parse(output.contentBase64);const bytes=Buffer.from(output.contentBase64,'base64');total+=bytes.length;requireCondition(total<=MAX_SOURCE_BYTES&&sha256(bytes)===output.sha256,'SOURCE_HASH_MISMATCH','Runtime artifact SHA or byte limit differs');await this.objects.objects.putObject({Bucket:'evidence',Key:output.sha256,Body:bytes});
      const artifactKey=canonicalHash([row.digest,inputHash,output.path,output.sha256]),mediaType=output.path.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':output.path.endsWith('.json')?'application/json':'text/plain';
      const artifact=(await tx.query(`INSERT INTO artifacts(artifact_id,tenant_id,scope_id,source_revision_id,compilation_key,sha256,size,object_key,file_name,media_type,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10) ON CONFLICT(tenant_id,scope_id,compilation_key) DO UPDATE SET compilation_key=EXCLUDED.compilation_key RETURNING *`,[newId('art'),task.tenantId,task.scopeId,source.source_revision_id,artifactKey,output.sha256,bytes.length,output.path,mediaType,JSON.stringify({skillPackId:row.skill_pack_id,digest:row.digest,producer:'scripted-Circle-RPC',semanticQuality:'not-asserted',runtime:report.output.runtime})])).rows[0];
      await tx.query('INSERT INTO artifact_bindings(task_id,input_revision_id,artifact_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[task.taskId,task.inputRevisionId,artifact.artifact_id,output.path]);artifacts.push(this.objects.artifactReference(artifact));
    }
    const facts=await this.objects.evidence(tx,task,operation.operation_id,'script-conclusion',{checks:{declaredOutputs:'passed',sha256:'passed'},inputRevisionId:task.inputRevisionId,inputSha256:inputHash,skillPackDigest:row.digest,artifacts,conclusionScope:'file-completeness-and-byte-integrity'});
    const judgment=await this.objects.evidence(tx,task,operation.operation_id,'model-judgment',{model:report.output.runtime.model,answer:report.output.answer??'',semanticVerification:'not-asserted'});
    const result={status:'succeeded',artifacts,evidence:[facts,judgment],unmapped:[],runtime:report.output.runtime};await this.execution.complete(tx,operation,'succeeded',{...result,reportHash:canonicalHash(report)});
    await tx.query("UPDATE tasks SET result=$2,result_status='succeeded' WHERE task_id=$1",[task.taskId,JSON.stringify(result)]);await this.tasks.stage(tx,task,'delivered','done','task.delivered',result);
    return {operationId:operation.operation_id,status:'succeeded',deduplicated:false};
  }
}
