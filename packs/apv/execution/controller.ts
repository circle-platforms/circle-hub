import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ApiError,ExecutionReport,IDEMPOTENCY_WINDOW_MS,actionDigest,canonicalHash,canonicalJson,newId,requireCondition,sha256,type AuthContext} from '../../../packages/contracts/src/index.ts';
import {GatewayProfile} from '../../../packages/connectors/src/case-gateway.ts';
import {resolveTrust} from '../../../packages/connectors/src/private-http.ts';
import {HttpSource,type RawReturn} from '../../../packages/connectors/src/readonly-sdk.ts';
import {BuildSite,resolveBuilds} from '../../../packages/connectors/src/build-site.ts';
import {commandCheck} from '../../../packages/methods/src/command-tree.ts';
import {ExecutionInput,ExecutionPack} from './contracts.ts';
import {readExecutionWorkbook,type ExecutionBook} from './workbook.ts';
import {executionResults} from './results.ts';
import {environmentBuild} from './environment.ts';
import {FunctionContract} from './function-contract.ts';
import {z as schema} from 'zod';

export class CaseExecution {
  services:any;
  constructor(services:any){
    this.services=services;const {tasks,execution,approvals}=services;
    services.methods?.register({capabilityPackId:ExecutionPack.capabilityPackId,version:ExecutionPack.version,flowVersion:ExecutionPack.flowVersion,implementationSha256:ExecutionPack.implementationSha256});
    tasks.capabilities.set(ExecutionPack.capabilityPackId,{version:ExecutionPack.version,flowVersion:'apv-case-execute/1'});
    const authorize=execution.managedAuthorization,preflight=execution.managedPreflight;
    for(const name of ['cases.verify','cases.execute','cases.observe']){
      execution.managedNames.add(name);execution.customPreflights.set(name,(ctx:any,id:string,fence:number,tx:any)=>this.preflight(ctx,id,fence,tx));
      execution.customReports.set(name,(ctx:any,id:string,body:any)=>this.report(ctx,id,body));
    }
    execution.managedAuthorization=(tx:any,ctx:any,scope:any,spec:any,task:any)=>spec.name.startsWith('cases.')?this.authorize(tx,ctx,task,spec):authorize(tx,ctx,scope,spec,task);
    execution.managedPreflight=(tx:any,ctx:any,row:any,authorization:any)=>row.name.startsWith('cases.')?authorization:preflight(tx,ctx,row,authorization);
    execution.customEvents.set('cases.execute',(ctx:any,id:string,fence:number,revision:string,event:any)=>this.event(ctx,id,fence,revision,event));
    execution.customReconciliations.set('cases.execute',(ctx:any,taskId:string,id:string)=>this.reconcile(ctx,taskId,id));
    services.executionChanges.handlers.set('cases.execute',async(tx:any,ctx:any,task:any,action:any,assetId:string)=>{await this.startExecution(tx,task,action,assetId);});
    tasks.deliveryValidators.set(ExecutionPack.capabilityPackId,async(_tx:any,task:any,result:any)=>{
      requireCondition(result.result?.sourceSha256===task.input.sourceSha256&&result.evidence.some((record:any)=>record.kind==='script-conclusion'),'EVIDENCE_INSUFFICIENT','Execution delivery requires a bound source and independently parsed gateway receipt');
      return [{itemId:'bound-gateway-receipt',conclusionId:result.evidence.find((record:any)=>record.kind==='script-conclusion').evidenceId}];
    });
  }
  actor(task:any):AuthContext{return {principalId:task.principalId,tenantId:task.tenantId,kind:'user'};}
  async profiles(){
    try{return z.object({profiles:z.record(z.string(),GatewayProfile)}).strict().parse(JSON.parse(await readFile(process.env.CIRCLE_SERVER_EXECUTION_GATEWAYS??'','utf8'))).profiles;}
    catch{throw new ApiError('SOURCE_UNREACHABLE','Runtime execution gateway profile is not configured');}
  }
  async asset(ctx:AuthContext,id:string,scope:string,tx?:any,kinds=['connector-instance']){
    const row=await this.services.assets.row(ctx,id,tx);requireCondition(row.scope_id===scope,'FORBIDDEN_SCOPE','Execution asset is outside the task scope');
    requireCondition(kinds.includes(row.kind)&&(row.kind==='knowledge-source'?['approved','running'].includes(row.lifecycle):row.lifecycle==='running')&&row.approved_digest===row.sha256,'APPROVAL_STALE','Execution asset must be current and approved');return row;
  }
  async credential(ctx:AuthContext,row:any,tx:any){
    requireCondition(row.declaration.credentials.length===1,'SOURCE_LOGIN_EXPIRED','Register one personal gateway credential including its refresh token');
    const reference=await this.services.assets.resourceCredential(ctx,row,row.declaration.credentials[0],tx),credential=reference.row;
    const oauth=await this.services.oauth?.credentialProfile(ctx,credential);return {key:reference.key,binding:reference.binding,...(credential.configuration.credentialMode==='static-secret'?{provider:'static-secret'}:{}),...(oauth?{oauth}:{})};
  }
  async bindings(ctx:AuthContext,input:any,scope:string,tx:any){
    await this.services.auth.check(ctx,'tasks.submit',scope,tx);await this.services.auth.check(ctx,'methods.use',scope,tx);
    const method=await this.services.methods.resolve(ctx,scope,ExecutionPack.capabilityPackId,tx,input.methodAssetId);
    const gateway=await this.asset(ctx,input.gatewayAssetId,scope,tx),build=await this.asset(ctx,input.commandSourceAssetId,scope,tx,['connector-instance','knowledge-source']);
    requireCondition(gateway.configuration.packageId==='case-gateway'&&gateway.declaration.writes.includes('device-config'),'INVALID_PAYLOAD','Gateway must declare device execution');
    await this.services.auth.check(ctx,'builds.read',scope,tx);
    const sourceArtifact=build.kind==='knowledge-source'?await this.services.sourceArtifacts.snapshot(ctx,build.asset_id,scope,tx):null;
    if(sourceArtifact){const declaration=schema.object({buildName:schema.string().min(1).max(200),platform:schema.string().nullable().optional()}).passthrough().parse(sourceArtifact.metadata);requireCondition(input.build===sourceArtifact.sourceArtifactId||input.build===declaration.buildName,'INPUT_REVISION_STALE','Execution must bind the selected source artifact id');requireCondition(input.platform===undefined||input.platform===declaration.platform,'INPUT_REVISION_STALE','Execution platform differs from the source declaration');requireCondition(sourceArtifact.files.filter((file:any)=>file.role==='command-tree').length===1&&sourceArtifact.files.filter((file:any)=>file.role==='function-contract').length===1,'INVALID_PAYLOAD','Execution source artifact needs one command-tree and one function-contract file');}
    else requireCondition(build.configuration.packageId==='build-site','INVALID_PAYLOAD','Bind an approved command source');
    const allProfiles=await this.profiles(),profileRef=gateway.configuration.runtimeProfileRef,configured=Object.hasOwn(allProfiles,profileRef)?allProfiles[profileRef]:undefined,buildProfile=this.services.catalog.profileFor(build.configuration);
    const profile=configured?{...configured,caSha256:(await resolveTrust(configured)).caSha256,issuerCaSha256:(await resolveTrust({caFile:configured.issuerCaFile??configured.caFile,caSha256:configured.issuerCaSha256??configured.caSha256})).caSha256}:undefined;
    const serviceClientId=gateway.configuration.serviceClientId;let gatewayInjection:any;
    if(serviceClientId){requireCondition(!gateway.declaration.credentials.length&&!configured?.issuer,'INVALID_PAYLOAD','Server-issued resource authorization does not use an external issuer or personal credential');await this.services.serviceClients.binding(ctx,serviceClientId,gateway.asset_id,scope,['jumphost:run'],tx);gatewayInjection={provider:'server',clientId:serviceClientId};}
    else gatewayInjection=await this.credential(ctx,gateway,tx);requireCondition(!gateway.configuration.credentialMode||gateway.configuration.credentialMode===(gatewayInjection.provider==='server'?'server-issued':gatewayInjection.provider??'external-oauth'),'INVALID_PAYLOAD','Resource credential mode differs from its binding');let buildInjection:any;
    requireCondition(profile&&(gatewayInjection.provider==='server'||gatewayInjection.provider==='static-secret'||profile.issuer||gatewayInjection.oauth)&&(buildProfile||sourceArtifact),'SOURCE_UNREACHABLE','Gateway authorization and command source must be configured at runtime');
    if(build.declaration.credentials.length)buildInjection=await this.credential(ctx,build,tx);
    const policy=gateway.configuration.executionPolicy;if(policy)requireCondition(!policy.allowedPrincipals||policy.allowedPrincipals.includes('*')||policy.allowedPrincipals.includes(ctx.principalId),'PERMISSION_DENIED','Resource policy does not allow this execution identity');
    const blocked=[...await this.services.changeSets.dependencies(tx,ctx,gateway),...await this.services.changeSets.dependencies(tx,ctx,build)];if(blocked.length)throw new ApiError('SOURCE_NOT_APPROVED','Execution dependencies are not approved',{ruleId:'execution-source-bindings',ruleVersion:'1.0.0',blockedReasons:blocked});
    return {gateway,build,method,profile,buildProfile,gatewayInjection,buildInjection,sourceArtifact,pin:canonicalHash({method,gateway:[gateway.asset_id,gateway.version,gateway.sha256,profile,...(gatewayInjection.oauth?[gatewayInjection.oauth]:[]),...(serviceClientId?[{serviceClientId}]:[])],source:[build.asset_id,build.version,build.sha256,buildProfile,...(sourceArtifact?[sourceArtifact]:[])]})};
  }
  async prepare(ctx:AuthContext,scope:string,value:any,tx:any,idempotencyKey?:string){
    await this.services.auth.check(ctx,'tasks.submit',scope,tx);await this.services.auth.check(ctx,'methods.use',scope,tx);
    const input=ExecutionInput.parse(value),{knowledge}=this.services;
    let source=input.sourceRevisionId;
    if(input.artifactId){const artifact=await knowledge.content(ctx,'artifact',input.artifactId);requireCondition(!input.sourceSha256||input.sourceSha256===artifact.reference.sha256,'SOURCE_HASH_MISMATCH','Artifact hash differs');source=(await knowledge.upload(ctx,scope,'case.xlsx',artifact.bytes,tx)).sourceRevisionId;}
    const original=await knowledge.sourceBytes(ctx,source,scope,tx),book=await readExecutionWorkbook(original.bytes);
    requireCondition(book.sha256===original.reference.sha256&&(!input.sourceSha256||input.sourceSha256===book.sha256),'SOURCE_HASH_MISMATCH','Execution source hash differs');
    let binding:any,hostFunctions:FunctionContract|undefined;try{binding=await this.bindings(ctx,input,scope,tx);}catch(error){if(error instanceof ApiError&&['SOURCE_NOT_APPROVED','SOURCE_UNREACHABLE','SOURCE_LOGIN_EXPIRED'].includes(error.code)){const {artifactId,...rest}=input;return {...rest,sourceRevisionId:source,sourceSha256:book.sha256};}throw error;}if(binding.sourceArtifact){const raws=await this.services.sourceArtifacts.bytes(ctx,binding.sourceArtifact,scope,tx),contract=binding.sourceArtifact.files.find((file:any)=>file.role==='function-contract');hostFunctions=new FunctionContract(raws.find((raw:any)=>raw.sha256===contract.sha256).bytes);await readExecutionWorkbook(original.bytes,hostFunctions);}await this.hostHooks(tx,{principalId:ctx.principalId,tenantId:ctx.tenantId,scopeId:scope,inputRevisionId:null},binding,book,hostFunctions);
    const resource=(await tx.query('SELECT frozen FROM resources WHERE tenant_id=$1 AND resource_id=$2',[ctx.tenantId,`gateway:${sha256(binding.profile.endpoint)}`])).rows[0],existing=idempotencyKey?(await tx.query("SELECT 1 FROM idempotency WHERE tenant_id=$1 AND scope_id=$2 AND principal_id=$3 AND action='submit' AND idem_key=$4 AND created_at>clock_timestamp()-($5::double precision*interval '1 millisecond')",[ctx.tenantId,scope,ctx.principalId,idempotencyKey,IDEMPOTENCY_WINDOW_MS])).rowCount:0;requireCondition(!resource?.frozen||existing,'RESOURCE_BUSY','Gateway environment is frozen until independent reconciliation');const {artifactId,...rest}=input;return {...rest,methodAssetId:binding.method.assetId,sourceRevisionId:source,sourceSha256:book.sha256};
  }
  async book(ctx:AuthContext,scope:string,binding:any,bytes:Buffer,contractBytes:Buffer|undefined,tx:any):Promise<ExecutionBook>{
    const functions=contractBytes?new FunctionContract(contractBytes):undefined;
    const checked=await readExecutionWorkbook(bytes,functions);
    if(binding.method.toolPaths?.includes('tools/workbook.ts'))return this.services.productModules.call(ctx,binding.method.hookAssetId,scope,'tools/workbook.ts','readExecutionWorkbook',[bytes,...(contractBytes?[{$instance:{path:'tools/function-contract.ts',export:'FunctionContract',args:[{$bytes:contractBytes.toString('base64')}]}}]:[])],tx);
    return checked;
  }
  hostInputs(task:any,binding:any,book:ExecutionBook,functions?:FunctionContract){
    const base=this.hookBinding(task,binding),inputs=[];
    for(const command of book.hostCommands){
      const hookBinding=base;
      inputs.push({event:'verify.workbook',binding:hookBinding,subject:{client:command.host,contract:{testEnvEnabled:functions?[...functions.methods].filter(([key,status])=>JSON.parse(key)[0]==='test_env'&&functions.status('test_env',JSON.parse(key)[1])==='enabled').map(([key])=>JSON.parse(key)[1]):binding.gateway.declaration.allowedTestHosts??[]}},location:{row:command.row,autoid:command.autoid,object:command.object,method:command.method}});
      inputs.push({event:'verify.hostCommand',binding:hookBinding,subject:{command:command.command,host:command.host,method:command.method,kwargs:command.kwargs},location:command});
    }return inputs;
  }
  async hostHooks(tx:any,task:any,binding:any,book:ExecutionBook,functions?:FunctionContract){return this.hookBatch(tx,task,binding,this.hostInputs(task,binding,book,functions));}
  hookBinding(task:any,binding:any){return {method:binding.method,resource:{assetId:binding.gateway.asset_id,version:binding.gateway.version,sha256:binding.gateway.sha256,declaration:binding.gateway.declaration},source:{assetId:binding.build.asset_id,sourceArtifactId:binding.sourceArtifact?.sourceArtifactId??null},inputRevision:task.inputRevisionId??null};}
  async authorize(tx:any,ctx:AuthContext,task:any,spec:any){
    requireCondition(task.capabilityPackId===ExecutionPack.capabilityPackId&&task.principalId===ctx.principalId,'FORBIDDEN_ACTION','Use the accepted execution capability task');
    const binding=await this.bindings(ctx,task.input,task.scopeId,tx),context=(await tx.query('SELECT context,cancel_requested FROM tasks WHERE task_id=$1',[task.taskId])).rows[0];
    requireCondition(spec.inputRevisionId===task.inputRevisionId||spec.input_revision_id===task.inputRevisionId,'INPUT_REVISION_STALE','Execution input revision changed');
    if(spec.name!=='cases.observe')requireCondition(!context.cancel_requested,'DECISION_CONFLICT','Cancellation prevents new execution effects');
    let gate=context.context.commandGate;
    if(spec.name!=='cases.verify'){
      requireCondition(gate?.inputRevisionId===task.inputRevisionId&&gate.bindingPin===binding.pin,'APPROVAL_STALE','Gateway or command source identity changed');
      const expected=this.action(task,gate);
      requireCondition(actionDigest(expected)===actionDigest({inputRevisionId:spec.inputRevisionId??spec.input_revision_id,name:spec.name==='cases.observe'?'cases.execute':spec.name,target:spec.target,targetIdentity:spec.targetIdentity??spec.target_identity,args:spec.args}),'APPROVAL_STALE','Execution action differs from the server command gate');
      if(spec.name==='cases.execute'&&binding.gateway.declaration.executionIsChange===true&&!spec.approvalProposal){requireCondition(spec.authorizationAssetId??spec.authorization_asset_id,'SOURCE_NOT_APPROVED','Resource execution requires an approved change submission');if(spec.operation_id)await this.services.executionChanges.check(tx,task,spec);}
    }else requireCondition(spec.target===task.input.commandSourceAssetId&&canonicalHash(spec.args)===canonicalHash(task.input),'INPUT_REVISION_STALE','Verification arguments differ from the workbook binding');
    return {...binding,gate,effects:{reads:['knowledge','registered-source','test-bed'],writes:spec.name==='cases.execute'?['device-config','artifacts-evidence']:['artifacts-evidence']},resourceId:spec.name==='cases.verify'?`case-verify:${task.taskId}:${task.inputRevisionId}`:`gateway:${sha256(binding.profile.endpoint)}`};
  }
  async hookBatch(tx:any,task:any,binding:any,inputs:any[]){
    const results=await this.services.productModules.runBatch(this.actor(task),binding.method.hookAssetId,task.scopeId,inputs,tx);
    for(const item of results)for(const decision of item.decisions){await this.services.auth.audit(this.actor(task),'hook.verification',{...decision,inputRevisionId:task.inputRevisionId},task.scopeId,tx);if(task.taskId)await this.services.tasks.emit(tx,task.taskId,'hook.verification',decision);if(decision.result.decision==='block')throw new ApiError(decision.result.code,'Hook blocked the operation',{...decision.result.facts,...inputs[item.index].location,ruleId:decision.ruleId,ruleVersion:decision.ruleVersion,inputRevisionId:task.inputRevisionId});}
  }
  async hook(tx:any,task:any,binding:any,event:string,hookBinding:any,subject:any,location:any={}){return this.hookBatch(tx,task,binding,[{event,binding:hookBinding,subject,location}]);}
  async startExecution(tx:any,task:any,action:any,authorizationAssetId?:string){const operation=await this.services.execution.submit(this.actor(task),task.taskId,{...action,...(authorizationAssetId?{authorizationAssetId}:{}),idempotencyKey:canonicalHash([task.taskId,task.inputRevisionId,'execute']),deadlineMs:task.input.deadlineMs},tx);await this.services.tasks.stage(tx,task,'waiting-resource','wait-worker','task.waiting-worker',{operationId:operation.operationId});}
  action(task:any,gate:any){return {name:'cases.execute',inputRevisionId:task.inputRevisionId,target:task.input.gatewayAssetId,targetIdentity:canonicalHash([gate.bindingPin,gate.treeSha256]),args:{...task.input,treeSha256:gate.treeSha256,buildId:gate.buildId,buildName:gate.buildName,...(gate.excelContractSha256?{excelContractSha256:gate.excelContractSha256,sourceArtifactId:gate.sourceArtifactId}:{}) ,commandReportSha256:gate.reportSha256,commandCheckArtifactId:gate.reportArtifactId,commandCheckArtifactSha256:gate.reportArtifactSha256,hostDispatch:gate.hostDispatch}};}
  async preflight(ctx:AuthContext,id:string,fence:number,tx:any){
    const row=await this.services.execution.lease(ctx,id,fence,tx),task=await this.services.tasks.internal(tx,row.task_id),actor=this.actor(task),binding=await this.authorize(tx,actor,task,row),source=await this.services.knowledge.source(actor,task.input.sourceRevisionId,task.scopeId,tx);
    requireCondition(source.sha256===task.input.sourceSha256,'SOURCE_HASH_MISMATCH','Execution source binding changed');
    const remote=row.parent_operation_id?(await tx.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1',[row.parent_operation_id])).rows[0]:null;
    if(binding.gatewayInjection.provider==='server'&&row.name!=='cases.verify')binding.gatewayInjection=await this.services.serviceClients.issueForOperation(tx,actor,row,binding.gatewayInjection.clientId,['jumphost:run'],'methods.use');
    return {row,task,source,authorization:{profile:binding.profile,buildProfile:binding.buildProfile,sourceArtifact:binding.sourceArtifact,buildCacheNamespace:canonicalHash([actor.tenantId,actor.principalId,binding.build.asset_id,binding.build.version,binding.build.declaration.credentials]),gatewayInjection:binding.gatewayInjection,buildInjection:binding.buildInjection,method:binding.method,gate:binding.gate,remoteTaskId:remote?.gateway_task_id}};
  }
  async validation(tx:any,task:any,output:any){
    const original=await this.services.knowledge.sourceBytes(this.actor(task),task.input.sourceRevisionId,task.scopeId,tx),binding=await this.bindings(this.actor(task),task.input,task.scopeId,tx),raw:RawReturn[]=z.array(z.object({path:z.string(),sha256:z.string(),contentBase64:z.string(),sourceType:z.string().optional()})).min(1).max(256).parse(output.raw).map(item=>{
      const bytes=Buffer.from(item.contentBase64,'base64');requireCondition(sha256(bytes)===item.sha256,'SOURCE_HASH_MISMATCH','Command source bytes differ from the worker receipt');return {...item,bytes,mediaType:'application/octet-stream',etag:null};
    });
    const byPath=new Map(raw.map(item=>[item.path,item])),replay=new HttpSource(binding.buildProfile?.origin??'http://127.0.0.1');replay.read=async path=>{const value=byPath.get(replay.path(path));requireCondition(value,'EVIDENCE_INSUFFICIENT','Bound listing bytes are missing');return value;};
    const site=new BuildSite(replay);let build:any,xml:RawReturn|undefined,functions:FunctionContract|undefined,sourceProof:Record<string,unknown>={};
    if(binding.sourceArtifact){const artifact=binding.sourceArtifact,originals=await this.services.sourceArtifacts.bytes(this.actor(task),artifact,task.scopeId,tx),tree=artifact.files.find((file:any)=>file.role==='command-tree'),contract=artifact.files.find((file:any)=>file.role==='function-contract');
      for(const file of [tree,contract])requireCondition(byPath.get(`/${file.path}`)?.sha256===file.sha256,'SOURCE_HASH_MISMATCH','Worker proof does not contain the pinned external original');
      xml=originals.find((raw:any)=>raw.sha256===tree.sha256);functions=new FunctionContract(originals.find((raw:any)=>raw.sha256===contract.sha256).bytes);build={buildId:artifact.sourceArtifactId,name:artifact.metadata.buildName};sourceProof={sourceArtifactId:artifact.sourceArtifactId,excelContractSha256:contract.sha256,association:'operator-declared'};
    }else{const records=[];for(const page of raw.filter(item=>item.sourceType==='build-record'))records.push(...(await site.listing(page.path,site.contextFor(page.path,binding.buildProfile.buildSite))).result);
      const selected=resolveBuilds(records).filter(build=>(build.buildId===task.input.build||build.name===task.input.build)&&(task.input.platform===undefined||build.platform===task.input.platform));requireCondition(selected.length===1&&!selected[0].conflict,'EVIDENCE_INSUFFICIENT','Command tree requires one unambiguous current build');build=selected[0];xml=byPath.get(build.files.commands??'');}
    requireCondition(xml,'EVIDENCE_INSUFFICIENT','Command tree is not linked by the bound source');const contractBytes=binding.sourceArtifact?(await this.services.sourceArtifacts.bytes(this.actor(task),binding.sourceArtifact,task.scopeId,tx)).find((file:any)=>file.sha256===sourceProof.excelContractSha256)?.bytes:undefined;const book=await this.book(this.actor(task),task.scopeId,binding,original.bytes,contractBytes,tx);
    requireCondition(book.sha256===task.input.sourceSha256,'SOURCE_HASH_MISMATCH','Server workbook bytes differ from the accepted input');const checked=commandCheck(await site.commandsFrom(xml.bytes),book.commands.map(item=>item.command));
    const invalid=checked.commands.flatMap((command:any,index:number)=>command.status!=='hit'||command.violations.length?[{...book.commands[index],status:command.status,violations:command.violations}]:[]);
    const hookBinding={method:binding.method,resource:{assetId:binding.gateway.asset_id,version:binding.gateway.version,sha256:binding.gateway.sha256,declaration:binding.gateway.declaration},source:{assetId:binding.build.asset_id,sourceArtifactId:binding.sourceArtifact?.sourceArtifactId??null,sha256:xml.sha256},inputRevision:task.inputRevisionId};
    const deviceInputs=book.commands.map((command,index)=>({event:'verify.deviceCommand',binding:hookBinding,subject:{command:command.command,tree:{heads:[{command:command.command,present:checked.commands[index].status==='hit'&&checked.commands[index].violations.length===0}]}},location:{...command,treeSha256:xml.sha256,status:checked.commands[index].status,violations:checked.commands[index].violations}}));
    await this.hookBatch(tx,task,binding,[...deviceInputs,...this.hostInputs(task,binding,book,functions)]);

    return {book,binding,gate:{inputRevisionId:task.inputRevisionId,bindingPin:binding.pin,treeSha256:xml.sha256,...sourceProof,buildId:build.buildId,buildName:build.name,caseIds:book.cases.map(item=>item.autoid),hostDispatch:{count:book.hostCommands.length,hosts:[...new Set(book.hostCommands.map(row=>row.host))],sha256:canonicalHash(book.hostCommands)},reportSha256:canonicalHash({checked,rows:book.commands,hostCommands:book.hostCommands,treeSha256:xml.sha256,...sourceProof})},report:{checked,rows:book.commands,hostCommands:book.hostCommands,buildId:build.buildId,buildName:build.name,treeSha256:xml.sha256,...sourceProof,raw:output.raw}};
  }
  async runOnce(){
    const {store,tasks,execution}=this.services,rows=(await store.pool.query("SELECT task_id FROM tasks WHERE capability_pack_id=$1 AND ((phase='running' AND stage='inspect') OR (cancel_requested AND phase NOT IN ('delivered','failed','cancelled','unknown')))",[ExecutionPack.capabilityPackId])).rows;
    for(const item of rows)await store.transaction(async(tx:any)=>{
      const row=(await tx.query("SELECT * FROM tasks WHERE task_id=$1 AND phase NOT IN ('delivered','failed','cancelled','unknown') FOR UPDATE SKIP LOCKED",[item.task_id])).rows[0];if(!row)return;const task=await tasks.internal(tx,row.task_id);
      if(row.cancel_requested){const active=(await tx.query("SELECT 1 FROM operations WHERE task_id=$1 AND input_revision_id=$2 AND name='cases.execute' AND status IN ('running','unknown')",[task.taskId,task.inputRevisionId])).rowCount;if(active)return;
        await tx.query("UPDATE operations SET status='failed',result=$3 WHERE task_id=$1 AND input_revision_id=$2 AND status='accepted'",[task.taskId,task.inputRevisionId,JSON.stringify({executionStarted:false,cancelledBeforeDispatch:true})]);await tx.query("UPDATE pending_inputs SET status='cancelled' WHERE task_id=$1 AND status='open'",[task.taskId]);await tasks.stage(tx,task,'cancelled','done','task.cancelled',{executionStarted:false,deviceSubmitted:false});return;
      }
      if(row.phase!=='running'||row.stage!=='inspect')return;
      try{const binding=await this.bindings(this.actor(task),task.input,task.scopeId,tx);const operation=await execution.submit(this.actor(task),task.taskId,{name:'cases.verify',inputRevisionId:task.inputRevisionId,target:task.input.commandSourceAssetId,targetIdentity:binding.build.sha256,args:task.input,idempotencyKey:canonicalHash([task.taskId,task.inputRevisionId,'verify']),deadlineMs:300000},tx);await tasks.stage(tx,task,'waiting-resource','wait-worker','task.waiting-command-validation',{operationId:operation.operationId});}
      catch(error){if(!(error instanceof ApiError))throw error;await this.runFailure(tx,task,{code:error.code,message:error.message,details:error.details});}
    });
  }
  async event(ctx:AuthContext,id:string,fence:number,revision:string,event:any){return this.services.store.transaction(async(tx:any)=>{
    const {execution,tasks}=this.services,row=await execution.lease(ctx,id,fence,tx),task=await tasks.internal(tx,row.task_id);requireCondition(revision===task.inputRevisionId&&revision===row.input_revision_id,'INPUT_REVISION_STALE','Gateway event input changed');
    if(event.stage==='environment'){await this.preflight(ctx,id,fence,tx);const observation=environmentBuild(event.environment,row.args.buildName),artifact=await this.services.knowledge.artifact(tx,task,task.input.sourceRevisionId,Buffer.from(canonicalJson(event.environment)),observation,{key:canonicalHash([id,'environment']),fileName:'environment-observation.json',mediaType:'application/json',role:'environment-observation'});await tasks.emit(tx,task.taskId,'execution.environment.observed',{...observation,artifact});return {recorded:true};}
    if(event.stage==='validation'){
      await this.preflight(ctx,id,fence,tx);const verified=await this.validation(tx,task,event.output),expected=row.args.treeSha256;
      requireCondition(verified.gate.treeSha256===expected&&verified.gate.reportSha256===row.args.commandReportSha256,'APPROVAL_STALE','Command tree changed after approval');
      const checkpoint=await tx.query(`INSERT INTO case_gateway_receipts(operation_id,input_revision_id,workbook_sha256,validation_fence,verified_tree_sha256,verified_report_sha256) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(operation_id) DO UPDATE SET validation_fence=$4,verified_tree_sha256=$5,verified_report_sha256=$6,updated_at=clock_timestamp() WHERE NOT case_gateway_receipts.submit_intent RETURNING operation_id`,[id,revision,task.input.sourceSha256,fence,expected,verified.gate.reportSha256]);requireCondition(checkpoint.rowCount,'DECISION_CONFLICT','Gateway submission already has an intent');
      await tasks.emit(tx,task.taskId,'execution.commands.rechecked',{treeSha256:expected,commandReportSha256:verified.gate.reportSha256,commandCount:verified.book.commands.length});return {authorized:true};
    }
    if(event.stage==='submit-intent'){
      const dispatched=await this.preflight(ctx,id,fence,tx);await this.hook(tx,task,{method:dispatched.authorization.method??(await this.bindings(this.actor(task),task.input,task.scopeId,tx)).method},'beforeDispatch',this.hookBinding(task,await this.bindings(this.actor(task),task.input,task.scopeId,tx)),{input:task.input,operationId:id});const updated=await tx.query(`UPDATE case_gateway_receipts SET submit_intent=true,updated_at=clock_timestamp() WHERE operation_id=$1 AND input_revision_id=$2 AND workbook_sha256=$3 AND validation_fence=$4 AND verified_tree_sha256=$5 AND verified_report_sha256=$6 AND NOT submit_intent AND updated_at>clock_timestamp()-interval '5 minutes' RETURNING operation_id`,[id,revision,task.input.sourceSha256,fence,row.args.treeSha256,row.args.commandReportSha256]);requireCondition(updated.rowCount,'DECISION_CONFLICT','Fresh server command proof is required and a submit intent can be consumed only once');
      await tasks.emit(tx,task.taskId,'execution.gateway.submit-intent',{operationId:id,sourceSha256:task.input.sourceSha256});return {authorized:true};
    }
    const receipt=(await tx.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1 FOR UPDATE',[id])).rows[0];requireCondition(receipt?.submit_intent,'DECISION_CONFLICT','Gateway submission has no persisted intent');
    if(event.stage==='submitted'){
      const submitted=z.object({task_id:z.string().regex(/^[A-Za-z0-9_-]{1,240}$/),sha256:z.string(),case_ids:z.array(z.string()),submit_autoid:z.string(),module:z.string()}).passthrough().parse(event.receipt);
      requireCondition(!receipt.gateway_task_id||receipt.gateway_task_id===submitted.task_id&&canonicalHash(receipt.receipt)===canonicalHash(submitted),'IDEMPOTENCY_MISMATCH','Gateway task differs from the persisted receipt');if(receipt.gateway_task_id)return {recorded:true,deduplicated:true};
      const gate=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[task.taskId])).rows[0].context.commandGate,bindingAccepted=submitted.sha256===task.input.sourceSha256&&canonicalHash(submitted.case_ids)===canonicalHash(gate.caseIds);
      await tx.query('UPDATE case_gateway_receipts SET gateway_task_id=$2,receipt=$3,updated_at=clock_timestamp() WHERE operation_id=$1',[id,submitted.task_id,JSON.stringify(submitted)]);await tasks.emit(tx,task.taskId,'execution.gateway.submitted',{operationId:id,remoteTaskId:submitted.task_id,sourceSha256:submitted.sha256,bindingAccepted});return {recorded:true,bindingAccepted};
    }
    requireCondition(event.stage==='status'&&event.remoteTaskId===receipt.gateway_task_id&&['running','done','lost','unknown'].includes(event.state),'INVALID_PAYLOAD','Gateway status is not bound to its receipt');
    if(receipt.observed_state!==event.state){await tx.query('UPDATE case_gateway_receipts SET observed_state=$2 WHERE operation_id=$1',[id,event.state]);await tasks.emit(tx,task.taskId,'execution.gateway.status',{operationId:id,remoteTaskId:receipt.gateway_task_id,state:event.state});}return {recorded:true};
  });}
  async runFailure(tx:any,task:any,error:any){const codes:Record<string,string>={SOURCE_UNREACHABLE:'GATEWAY_UNREACHABLE',SOURCE_LOGIN_EXPIRED:'GATEWAY_UNREACHABLE',RESOURCE_BUSY:'LEASE_UNAVAILABLE',FORBIDDEN_ACTION:'PERMISSION_DENIED',ASSET_NOT_VISIBLE:'PERMISSION_DENIED',APPROVAL_STALE:'SOURCE_NOT_APPROVED'};const failure={...error,code:codes[error?.code]??error?.code??'GATEWAY_UNREACHABLE',details:{ruleId:'execution-enforcement',ruleVersion:'1.0.0',...error?.details,inputRevisionId:task.inputRevisionId,sourceSha256:task.input.sourceSha256}};const evidence=await this.services.knowledge.evidence(tx,task,null,'script-conclusion',{kind:'execution-enforcement-failure',...failure});failure.details.evidenceId=evidence.evidenceId;const reason:Record<string,string>={GATEWAY_UNREACHABLE:'gateway-configuration',BUILD_MISMATCH:'build-mismatch',SOURCE_NOT_APPROVED:'source-not-approved',LEASE_UNAVAILABLE:'lease-unavailable'};if(reason[failure.code])await this.services.tasks.waitForInput(tx,task,reason[failure.code],failure,[evidence]);else await this.services.tasks.fail(tx,task,failure,[evidence]);}
  async unknown(tx:any,task:any,row:any,report:any,reportHash=canonicalHash(report)){
    const evidence=await this.services.knowledge.evidence(tx,task,row.operation_id,'unknown',{error:report.error,receipt:report.output,remoteStoppingVerified:false});
    await tx.query("UPDATE operations SET status='unknown',result=$2 WHERE operation_id=$1",[row.operation_id,JSON.stringify({output:report.output,error:report.error,evidence:[evidence],reportHash})]);await tx.query('UPDATE resources SET frozen=true WHERE tenant_id=$1 AND resource_id=$2',[row.tenant_id,row.resource_id]);await tx.query('DELETE FROM leases WHERE operation_id=$1',[row.operation_id]);await this.services.tasks.stage(tx,task,'unknown','reconcile','operation.unknown',{operationId:row.operation_id,error:report.error,remoteStoppingVerified:false});return {status:'unknown'};
  }
  async report(ctx:AuthContext,id:string,body:any){
    const report=ExecutionReport.parse(body),reportHash=canonicalHash(report);return this.services.store.transaction(async(tx:any)=>{
      const {execution,tasks,knowledge,approvals}=this.services,row=await execution.lease(ctx,id,report.fencingToken,tx,true),task=await tasks.internal(tx,row.task_id);
      requireCondition(report.inputRevisionId===task.inputRevisionId&&report.inputRevisionId===row.input_revision_id,'INPUT_REVISION_STALE','Gateway report revision changed');
      if(['succeeded','failed'].includes(row.status)){requireCondition(row.result.reportHash===reportHash,'IDEMPOTENCY_MISMATCH','Completed gateway receipt differs');return {deduplicated:true};}
      if(report.error?.code==='SOURCE_ABSENT'){let diagnostic=false;try{diagnostic=(await this.services.auth.policy(this.actor(task),tx)).grants.includes('sources.diagnose');}catch{/* Revocation must not prevent failure bookkeeping. */}if(!diagnostic)report.error={code:'SOURCE_FORBIDDEN',message:'Source is not available to this identity'};}
      if(task.phase==='cancelled'&&row.name==='cases.verify'){await execution.complete(tx,row,'failed',{cancelledBeforeDispatch:true,reportHash});return {status:'cancelled'};}
      const intent=(await tx.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1',[id])).rows[0];
      if(report.status==='unknown'||(report.status==='failed'&&intent?.submit_intent))return this.unknown(tx,task,row,report,reportHash);
      if(report.status==='failed'){await execution.complete(tx,row,'failed',{error:report.error,reportHash});if(row.name==='cases.observe'){await tasks.emit(tx,task.taskId,'operation.reconciliation-failed',{operationId:id,parentOperationId:row.parent_operation_id,error:report.error,remoteStoppingVerified:false});return {status:'failed'};}const cancelled=(await tx.query('SELECT cancel_requested FROM tasks WHERE task_id=$1',[task.taskId])).rows[0].cancel_requested;if(cancelled){await tx.query("UPDATE pending_inputs SET status='cancelled' WHERE task_id=$1 AND status='open'",[task.taskId]);await tasks.stage(tx,task,'cancelled','done','task.cancelled',{executionStarted:false,deviceSubmitted:false});return {status:'cancelled'};}await this.runFailure(tx,task,report.error);return {status:'failed'};}
      try{
        if(row.name==='cases.verify'){
          await this.preflight(ctx,id,report.fencingToken,tx);const verified=await this.validation(tx,task,report.output);
          const artifact=await knowledge.artifact(tx,task,task.input.sourceRevisionId,Buffer.from(canonicalJson(verified.report)),{sourceSha256:task.input.sourceSha256},{key:canonicalHash([id,'server-command-check']),fileName:'command-check.json',mediaType:'application/json',role:'command-validation'});
          const gate={...verified.gate,reportArtifactId:artifact.artifactId,reportArtifactSha256:artifact.sha256},evidence=await knowledge.evidence(tx,task,id,'script-conclusion',{kind:'server-command-validation',...gate,commandCount:verified.book.commands.length,artifact});
          await tx.query("UPDATE tasks SET context=context || jsonb_build_object('commandGate',$2::jsonb) WHERE task_id=$1",[task.taskId,JSON.stringify(gate)]);await execution.complete(tx,row,'succeeded',{gate,artifact,evidence,reportHash});
          const action=this.action(task,gate);if(verified.binding.gateway.declaration.executionIsChange===true)await this.services.executionChanges.propose(tx,this.actor(task),task,action,[verified.binding.method,{assetId:verified.binding.gateway.asset_id,version:verified.binding.gateway.version,sha256:verified.binding.gateway.sha256},{assetId:verified.binding.build.asset_id,version:verified.binding.build.version,sha256:verified.binding.build.sha256}]);else await this.startExecution(tx,task,action);return {status:'verified'};
        }
        const parent=row.parent_operation_id?(await tx.query('SELECT * FROM operations WHERE operation_id=$1 FOR UPDATE',[row.parent_operation_id])).rows[0]:row,receipt=(await tx.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1',[parent.operation_id])).rows[0],remote=report.output.results as any;
        requireCondition(receipt?.gateway_task_id&&remote?.task_id===receipt.gateway_task_id&&remote.xlsx_sha256===task.input.sourceSha256,'EVIDENCE_INSUFFICIENT','Gateway result is not bound to the persisted submission and workbook');
        const observedStatus=report.output.status as any;requireCondition(observedStatus?.state==='done'&&observedStatus?.task_id===receipt.gateway_task_id,'EVIDENCE_INSUFFICIENT','Gateway has not independently observed terminal execution');
        const original=await knowledge.sourceBytes(this.actor(task),task.input.sourceRevisionId,task.scopeId,tx),book=await readExecutionWorkbook(original.bytes),result=executionResults(book,remote),binding=await this.bindings(this.actor(task),task.input,task.scopeId,tx);await this.hook(tx,task,binding,'afterResult',this.hookBinding(task,binding),{result,operationId:id});
        const rawArtifact=await knowledge.artifact(tx,task,task.input.sourceRevisionId,Buffer.from(canonicalJson(report.output)),{remoteTaskId:receipt.gateway_task_id},{key:canonicalHash([id,'gateway-original']),fileName:'gateway-results.json',mediaType:'application/json',role:'gateway-original'});
        const parsedArtifact=await knowledge.artifact(tx,task,task.input.sourceRevisionId,Buffer.from(canonicalJson(result)),{parserVersion:result.parserVersion},{key:canonicalHash([id,'normalized-results']),fileName:'execution-results.json',mediaType:'application/json',role:'execution-results'});
        const evidence=await knowledge.evidence(tx,task,id,'script-conclusion',{kind:'gateway-observed-execution',inputRevisionId:task.inputRevisionId,sourceSha256:book.sha256,remoteTaskId:receipt.gateway_task_id,rawSha256:rawArtifact.sha256,resultSha256:parsedArtifact.sha256,caseVerdicts:result.cases.map(item=>({autoid:item.autoid,verdict:item.verdict})),unmapped:result.unmapped,remoteStoppingVerified:false});
        await execution.complete(tx,row,'succeeded',{result,evidence:[evidence],reportHash});
        if(row.name==='cases.observe'){
          requireCondition(parent.status==='unknown'&&parent.worker_id!==ctx.workerId,'DECISION_CONFLICT','Reconciliation requires an independent worker');await tx.query("UPDATE operations SET status='reconciled',result=$2 WHERE operation_id=$1",[parent.operation_id,JSON.stringify({result,evidence:[evidence],observedBy:ctx.workerId})]);await tx.query("UPDATE resources SET frozen=EXISTS(SELECT 1 FROM operations WHERE tenant_id=$1 AND resource_id=$2 AND status='unknown') WHERE tenant_id=$1 AND resource_id=$2",[row.tenant_id,row.resource_id]);await tasks.emit(tx,task.taskId,'operation.reconciled',{operationId:parent.operation_id,observedBy:ctx.workerId});
        }
        const gate=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[task.taskId])).rows[0].context.commandGate,validationArtifact=(await tx.query('SELECT * FROM artifacts WHERE artifact_id=$1',[gate.reportArtifactId])).rows[0];requireCondition(validationArtifact&&validationArtifact.sha256===gate.reportArtifactSha256,'EVIDENCE_INSUFFICIENT','Command proof artifact is not available');
        await tasks.deliver(tx,task,{status:result.unmapped.length||remote.channel!=='ready'?'partial':'succeeded',result,artifacts:[knowledge.artifactReference(validationArtifact),rawArtifact,parsedArtifact],evidence:[evidence],unmapped:result.unmapped});return {status:'succeeded'};
      }catch(error){if(!(error instanceof ApiError))throw error;
        if(row.name==='cases.execute'&&intent?.submit_intent)return this.unknown(tx,task,row,{...report,error:{code:error.code,message:error.message}},reportHash);
        await execution.complete(tx,row,'failed',{error:{code:error.code,message:error.message,details:error.details},reportHash});if(row.name==='cases.observe'){await tasks.emit(tx,task.taskId,'operation.reconciliation-failed',{operationId:id,parentOperationId:row.parent_operation_id,error:{code:error.code,message:error.message},remoteStoppingVerified:false});return {status:'failed'};}await this.runFailure(tx,task,{code:error.code,message:error.message,details:error.details});return {status:'failed'};
      }
    });
  }
  async reconcile(ctx:AuthContext,taskId:string,id:string){return this.services.store.transaction(async(tx:any)=>{
    const {tasks,auth}=this.services,task=await tasks.load(ctx,taskId,'operations.reconcile',tx),parent=(await tx.query('SELECT * FROM operations WHERE operation_id=$1 AND task_id=$2 FOR UPDATE',[id,taskId])).rows[0];
    requireCondition(parent?.status==='unknown','DECISION_CONFLICT','Only unknown gateway execution can be reconciled');requireCondition(ctx.principalId===task.principalId,'FORBIDDEN_ACTION','The original owner requests personal-source reconciliation');
    const receipt=(await tx.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1',[id])).rows[0];requireCondition(receipt?.gateway_task_id,'EVIDENCE_INSUFFICIENT','Submission outcome is unknown without a gateway task receipt; do not replay');
    const existing=(await tx.query("SELECT * FROM operations WHERE parent_operation_id=$1 AND status IN ('accepted','running')",[id])).rows[0];if(existing)return this.services.execution.view(existing);
    const operationId=newId('op'),row=(await tx.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,status,deadline_at,kind,target,target_identity,args,action_digest,effects,parent_operation_id)
      VALUES($1,$2,$3,$4,$5,$6,'cases.observe',$7,'accepted',clock_timestamp()+interval '5 minutes','reconcile',$8,$9,$10,$11,$12,$13) RETURNING *`,[operationId,parent.tenant_id,parent.scope_id,taskId,parent.input_revision_id,parent.principal_id,parent.resource_id,parent.target,parent.target_identity,JSON.stringify(parent.args),parent.action_digest,JSON.stringify({reads:['test-bed'],writes:['artifacts-evidence']}),id])).rows[0];
    await tasks.emit(tx,taskId,'operation.reconciliation-requested',{operationId,parentOperationId:id});await auth.audit(ctx,'operations.reconcile',{operationId,parentOperationId:id},task.scopeId,tx);return this.services.execution.view(row);
  });}
}
