import { createServer, type IncomingMessage, type ServerResponse,type RequestListener } from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {serverTLS} from './tls.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { z } from 'zod';
import { API_VERSION, MAX_BODY_BYTES, MAX_SOURCE_BYTES, MAX_WORKER_REPORT_BYTES, CLIENT_ROUTES, TaskListQuery, ApiError, SubmitRequest,
  InputRequest, OperationRequest, ApprovalProposal, ApprovalRequest, ConclusionRequest, ChecklistRequest, ChecklistResponse, RuleRequest, InputRevisionId, TaskId, ScopeId, SourceUpload, Base64Content, DevLoginRequest, requireCondition,
  EntityId,RelationId,ObjectListQuery,ObjectTypePackage,ObjectObservation,RelationObservation,AuthRefreshRequest,
  AssetId,AssetRegistration,AssetListQuery,AssetTransition,CredentialRegistration,KnowledgeRecordId,KnowledgeSearchQuery,KnowledgeReviewRequest,ToolName,ToolCallInput,SkillPackId,StandardOperation,ServiceClientId } from '../../../packages/contracts/src/index.ts';
import { Store } from '../../../packages/storage/src/index.ts';
import { taskMigration } from '../../../packages/tasks/src/migration.ts';
import { Auth } from '../../../packages/tasks/src/auth.ts';
import { Tasks } from '../../../packages/tasks/src/index.ts';
import { deliveryMigration } from '../../../packages/tasks/src/delivery-migration.ts';
import { knowledgeMigration } from '../../../packages/knowledge/src/migration.ts';
import { Knowledge } from '../../../packages/knowledge/src/index.ts';
import { LocalObjects } from '../../../packages/knowledge/src/objects.ts';
import { executionMigration } from '../../../packages/execution/src/migration.ts';
import { Operations } from '../../../packages/execution/src/operations.ts';
import { approvalMigration } from '../../../packages/tasks/src/approval-migration.ts';
import { Approvals } from '../../../packages/tasks/src/approvals.ts';
import { conclusionMigration } from '../../../packages/knowledge/src/conclusion-migration.ts';
import { Records } from '../../../packages/knowledge/src/records.ts';
import { Assessments } from '../../../packages/methods/src/assessments.ts';
import { Checklists } from '../../../packages/tasks/src/checklists.ts';
import { checklistMigration } from '../../../packages/tasks/src/checklist-migration.ts';
import { connectorMigration } from '../../../packages/tasks/src/connector-migration.ts';
import { ConnectorRegistry } from '../../../packages/tasks/src/connector-registry.ts';
import {installPackages,packageMigrations,packageConnectors,installedToolPackages} from '../../../packs/index.ts';
import { closeHttpServer } from './shutdown.ts';
import {entityMigration} from '../../../packages/knowledge/src/entity-migration.ts';
import {TypeCatalog} from '../../../packages/knowledge/src/type-catalog.ts';
import {Entities} from '../../../packages/knowledge/src/entities.ts';
import {assetMigration} from '../../../packages/assets/src/migration.ts';
import {Assets} from '../../../packages/assets/src/index.ts';
import {OAuthCredentials} from '../../../packages/assets/src/oauth.ts';
import {oauthMigration} from '../../../packages/assets/src/oauth-migration.ts';
import {graphMigration} from '../../../packages/knowledge/src/graph-migration.ts';
import {KnowledgeGraph} from '../../../packages/knowledge/src/graph.ts';
import {SourceArtifacts} from '../../../packages/knowledge/src/source-artifacts.ts';
import {toolMigration} from '../../../packages/tools/src/migration.ts';
import {ToolCatalog} from '../../../packages/tools/src/catalog.ts';
import {skillMigration} from '../../../packages/skillpacks/src/migration.ts';
import {SkillPacks} from '../../../packages/skillpacks/src/index.ts';
import {PrivateIPC} from '../../../packages/runtime/src/private-ipc.ts';
import {automationMigration} from '../../../packages/tasks/src/automation-migration.ts';
import {Automations} from '../../../packages/tasks/src/automations.ts';
import {automationOutcomeMigration} from '../../../packages/tasks/src/automation-outcome-migration.ts';
import {knowledgePageMigration} from '../../../packages/knowledge/src/page-migration.ts';
import {automationOriginMigration} from '../../../packages/tasks/src/automation-origin-migration.ts';
import {ingestionMigration} from '../../../packages/knowledge/src/ingestion-migration.ts';
import {Ingestions} from '../../../packages/knowledge/src/ingestion.ts';
import {resourceIdentityMigration} from '../../../packages/tasks/src/resource-identity-migration.ts';
import {ServiceClients} from '../../../packages/tasks/src/service-clients.ts';

function environment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const store = new Store(JSON.parse(environment('CIRCLE_SERVER_DATABASE_CONFIG')));
await store.migrate([taskMigration,deliveryMigration,knowledgeMigration,executionMigration,...packageMigrations,approvalMigration,conclusionMigration,checklistMigration,connectorMigration,entityMigration,assetMigration,graphMigration,toolMigration,skillMigration,automationMigration,automationOutcomeMigration,knowledgePageMigration,automationOriginMigration,ingestionMigration,oauthMigration,resourceIdentityMigration]);
const auth = new Auth(store,{developmentTtlMs:process.env.CIRCLE_SERVER_DEV_TOKEN_TTL_MS?Number(process.env.CIRCLE_SERVER_DEV_TOKEN_TTL_MS):undefined,runTokenTtlMs:process.env.CIRCLE_SERVER_RUN_TOKEN_TTL_MS?Number(process.env.CIRCLE_SERVER_RUN_TOKEN_TTL_MS):undefined});
requireCondition(process.env.CIRCLE_SERVER_DEV_AUTH === '1', 'INVALID_PAYLOAD', 'Phase one requires explicitly enabled development authentication');
await auth.initializeDevelopment(environment('CIRCLE_SERVER_DEV_IDENTITIES'));
await mkdir(environment('CIRCLE_SERVER_DATA_DIR'), { recursive: true, mode: 0o700 });
const tasks = new Tasks(store, auth, Number(process.env.CIRCLE_SERVER_INPUT_TTL_MS ?? 300_000));
const knowledge = new Records(store,auth,new LocalObjects(environment('CIRCLE_SERVER_DATA_DIR')));
const objectTypes=new TypeCatalog(store,auth),entities=new Entities(store,auth,knowledge,objectTypes);
const assets=new Assets(store,auth,`${environment('CIRCLE_SERVER_DATA_DIR')}/private-credentials`);
const oauth=new OAuthCredentials(store,auth,assets,process.env.CIRCLE_SERVER_OAUTH_PROFILES);
assets.materializeCredential=(ctx,row,link,value)=>oauth.materialize(ctx,row,link,value);
const graph=new KnowledgeGraph(store,auth,knowledge);
const sourceArtifacts=new SourceArtifacts(store,auth,assets,knowledge,graph);
const serviceClients=new ServiceClients(store,auth,assets,Number(process.env.CIRCLE_SERVER_RESOURCE_TOKEN_TTL_SECONDS??300));
knowledge.sourceAccess=async(ctx,id,tx)=>{await entities.checkSourceAccess(ctx,id,tx);await graph.checkSourceAccess(ctx,id,tx);};
const execution = new Operations(store,auth,tasks,knowledge);
const catalog=new ToolCatalog(store,auth,assets,tasks,execution,graph,installedToolPackages);await catalog.initialize(process.env.CIRCLE_SERVER_CONNECTOR_PROFILES);
const ingestions=new Ingestions(store,tasks,graph,installedToolPackages);catalog.ingestions=ingestions;
catalog.sourceArtifacts=sourceArtifacts;
assets.prepareRegistration=(ctx,input,id,tx)=>sourceArtifacts.prepare(ctx,input,id,tx);
assets.decorateView=row=>row.kind==='knowledge-source'&&row.configuration.schema==='external-source-artifact/1'?sourceArtifacts.view(row):{};
assets.validateRegistration=async(ctx,input,id,tx)=>{await sourceArtifacts.validate(ctx,input,id,tx);await catalog.register(ctx,input,id,tx);};
const approvals=new Approvals(store,auth,tasks,Number(process.env.CIRCLE_SERVER_APPROVAL_TTL_MS??86400000));execution.approvalCheck=(tx,task,spec)=>approvals.check(tx,task,spec);
const skills=new SkillPacks(store,auth,tasks,approvals,assets,catalog,execution,knowledge);await skills.initialize(process.env.CIRCLE_RUNTIME_CONFIG);
execution.managedNames.add('assets.execute');
execution.managedAuthorization=(tx,actor,scope,spec,task)=>spec.name==='assets.execute'?skills.authorize(tx,actor,scope,spec,task):catalog.authorize(tx,actor,scope,spec,task);
execution.managedPreflight=(tx,actor,row,authorization)=>row.name==='assets.execute'?skills.preflight(tx,actor,row,authorization):catalog.preflight(tx,actor,row,authorization);
execution.managedReport=(tx,task,row,report)=>row.name==='assets.execute'?skills.report(tx,task,row,report):catalog.report(tx,task,row,report);
approvals.policies.set('assets.publish',{authorize:(tx,ctx,task,action)=>skills.approvalAuthorize(tx,ctx,task,action),check:(tx,ctx,task,row,answer)=>skills.approvalCheck(tx,ctx,task,row,answer),accepted:(tx,ctx,task,row,answer)=>skills.approved(tx,ctx,task,row,answer)});
const privateIPC=new PrivateIPC();skills.privateSocketPath=privateIPC.path;
const automations=new Automations(store,auth,tasks,assets,skills);catalog.observed=(tx,ctx,id,raw,taskId)=>automations.observed(tx,ctx,id,raw,taskId);
await privateIPC.start(async(message)=>{const worker=await auth.authenticate(message.authorization),id=z.string().parse(message.operationId),fence=z.number().int().positive().parse(message.fencingToken);return skills.privateSecret(worker,id,fence,message.revoke===true);});
const assessments=new Assessments(store,tasks,knowledge),checklists=new Checklists(store,tasks,knowledge);
const registry=new ConnectorRegistry(store,auth,packageConnectors);await registry.initialize();execution.connectorCheck=(tx,actor,scope,spec)=>registry.check(tx,actor,scope,spec);
const packages=installPackages({store,auth,tasks,knowledge,execution,registry,checklists,approvals,assessments,assets,catalog,sourceArtifacts,oauth,serviceClients}),rules=packages.rules;
let closing = false;
const shutdownSignal=new AbortController();
const activeRequests=new Set<Promise<void>>();
const bootId=randomUUID();
let restartRequested=false;
process.on('message',message=>{if(restartRequested&&(message as any)?.type==='graceful-restart-now')void shutdown();});

async function bytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireCondition(size <= limit, 'BODY_TOO_LARGE', 'Request body exceeds the limit'); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  requireCondition(request.headers['content-type']?.split(';')[0] === 'application/json', 'INVALID_PAYLOAD', 'JSON content type required');
  const data = await bytes(request,limit);
  try { return JSON.parse(data.toString('utf8')); }
  catch { throw new ApiError('INVALID_PAYLOAD', 'Invalid JSON'); }
}
function closeOnShutdown(response:ServerResponse):void{
  if(closing){response.shouldKeepAlive=false;response.setHeader('connection','close');}
}
async function waitForEvents():Promise<void>{
  try{await delay(30,undefined,{signal:shutdownSignal.signal});}
  catch(error){if(!shutdownSignal.signal.aborted)throw error;}
}
function send(response: ServerResponse, status: number, data: unknown): void {
  closeOnShutdown(response);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  const object = data as any;
  const phase = object.data?.phase;
  const semanticStatus = object.data?.status ?? (phase === 'admitted' ? 'accepted' : phase && !['delivered','failed','cancelled'].includes(phase) ? 'running' : 'succeeded');
  response.end(JSON.stringify({ apiVersion: API_VERSION, status: status >= 400 ? 'failed' : semanticStatus, ...object }));
}
function download(response: ServerResponse, value: { reference: any; bytes: Buffer }): void {
  closeOnShutdown(response);
  response.writeHead(200,{ 'content-type':value.reference.mediaType ?? 'application/octet-stream','content-length':value.bytes.length,
    'cache-control':'no-store','x-content-sha256':value.reference.sha256,
    'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(value.reference.fileName)}` }); response.end(value.bytes);
}
function protocolJSON(response:ServerResponse,status:number,value:unknown){closeOnShutdown(response);response.writeHead(status,{'content-type':'application/json','cache-control':'no-store','pragma':'no-cache'});response.end(JSON.stringify(value));}
async function form(request:IncomingMessage){requireCondition(request.headers['content-type']?.split(';')[0]==='application/x-www-form-urlencoded','INVALID_PAYLOAD','Form content type required');const values=new URLSearchParams((await bytes(request,MAX_BODY_BYTES)).toString('utf8')),result:Record<string,string>={};for(const [key,value] of values){requireCondition(!Object.hasOwn(result,key),'INVALID_PAYLOAD','Duplicate form field');result[key]=value;}return result;}
function base64(value: string): Buffer {
  Base64Content.parse(value);
  return Buffer.from(value,'base64');
}
const tls=await serverTLS(process.env.CIRCLE_SERVER_TLS_CONFIG),createListener=tls?(handler:RequestListener)=>createHttpsServer(tls,handler):createServer;
const server = createListener(async (request, response) => {
  const completed=Promise.withResolvers<void>();activeRequests.add(completed.promise);
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if(['/token','/v1/introspect'].includes(url.pathname)&&request.method==='POST'){
      try{const client=await serviceClients.basic(request.headers.authorization),input=await form(request);
        if(url.pathname==='/token'){if(input.grant_type!=='client_credentials')throw new ApiError('INVALID_PAYLOAD','Client credentials grant required',{oauthError:'unsupported_grant_type'});protocolJSON(response,200,await serviceClients.grant(client,input.scope??''));}
        else{const token=z.string().min(1).max(16384).parse(input.token);protocolJSON(response,200,await serviceClients.introspect(client,token));}
      }catch(error){const failure=error instanceof ApiError?error:error instanceof z.ZodError?new ApiError('INVALID_PAYLOAD','Invalid protocol request'):new ApiError('INTERNAL_ERROR','Service authorization is unavailable'),unauth=failure.code==='UNAUTHENTICATED';if(unauth)response.setHeader('www-authenticate','Basic realm="resource-identity"');protocolJSON(response,unauth?401:failure.code==='FORBIDDEN_ACTION'?403:failure.httpStatus>=500?500:failure.code==='BODY_TOO_LARGE'?413:400,{error:unauth?'invalid_client':failure.httpStatus>=500?'server_error':failure.details.oauthError??(failure.code==='FORBIDDEN_ACTION'?'insufficient_scope':'invalid_request')});}return;
    }
    const bundle=/^\/v1\/builds\/([^/]+)\/bundle$/.exec(url.pathname),blob=/^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
    if((bundle||blob)&&request.method==='GET'){let identity;try{identity=await auth.authenticate(request.headers.authorization);}catch(error){if(!(error instanceof ApiError)||error.code!=='UNAUTHENTICATED')throw error;identity=await serviceClients.bundleIdentity(request.headers.authorization);}requireCondition(!identity.run,'FORBIDDEN_ACTION','Run delegation cannot download resource bundles');if(bundle)protocolJSON(response,200,await sourceArtifacts.bundle(identity,z.string().min(1).max(200).parse(decodeURIComponent(bundle[1]))));else download(response,await sourceArtifacts.blob(identity,blob![1]));return;}
    if (['/v1/auth/token','/v1/auth/dev-login'].includes(url.pathname) && request.method === 'POST') {
      const input = DevLoginRequest.parse(await body(request));
      const issued = await auth.issue(input.username,input.password,input.expiresInMs);
      const identity = await auth.authenticate(`Bearer ${issued.token}`); const policy = await auth.policy(identity);
      send(response,200,{ data:{ ...issued,tokenType:'Bearer',principalId:policy.principalId,tenantId:policy.tenantId,scopes:policy.scopes } }); return;
    }
    const ctx = await auth.authenticate(request.headers.authorization);
    if(ctx.run){const allowed=request.method==='GET'&&['/v1/tools','/v1/tasks','/v1/status'].includes(url.pathname)||request.method==='POST'&&/^\/v1\/tools\/[^/]+\/call$/.test(url.pathname)||request.method==='GET'&&/^\/v1\/tasks\/[^/]+\/(?:status|result|events)$/.test(url.pathname)||request.method==='GET'&&/^\/v1\/(?:sources|artifacts|evidence)\/[^/]+\/content$/.test(url.pathname);requireCondition(allowed,'FORBIDDEN_ACTION','Run token authorizes only its declared tools and task reads');}
    if(url.pathname===CLIENT_ROUTES.authRefresh.path&&request.method==='POST'){
      AuthRefreshRequest.parse(await body(request));const issued=await auth.refresh(request.headers.authorization!),policy=await auth.policy(ctx);send(response,200,{data:{...issued,tokenType:'Bearer',principalId:policy.principalId,tenantId:policy.tenantId,scopes:policy.scopes}});return;
    }
    if(url.pathname==='/v1/service-clients'){if(request.method==='POST')send(response,201,{data:await serviceClients.register(ctx,await body(request))});else if(request.method==='GET')send(response,200,{data:await serviceClients.list(ctx,z.coerce.number().int().min(1).max(100).default(20).parse(url.searchParams.get('limit')??undefined),ServiceClientId.optional().parse(url.searchParams.get('after')??undefined))});else throw new ApiError('INVALID_PAYLOAD','Unsupported service client method');return;}
    const serviceClient=/^\/v1\/service-clients\/([^/]+)(?:\/(rotate|revoke))?$/.exec(url.pathname);if(serviceClient){const id=ServiceClientId.parse(serviceClient[1]);if(request.method==='GET'&&!serviceClient[2])send(response,200,{data:serviceClients.view(await serviceClients.row(ctx,id))});else if(request.method==='POST'&&serviceClient[2]==='rotate')send(response,200,{data:await serviceClients.rotate(ctx,id,await body(request))});else if(request.method==='POST'&&serviceClient[2]==='revoke'){z.object({}).strict().parse(await body(request));send(response,200,{data:await serviceClients.revoke(ctx,id)});}else throw new ApiError('INVALID_PAYLOAD','Unsupported service client method');return;}
    if(request.method==='POST'&&url.pathname==='/v1/automations/triggers'){send(response,201,{data:await automations.trigger(ctx,await body(request))});return;}
    if(request.method==='POST'&&url.pathname==='/v1/automations/bots'){send(response,201,{data:await automations.bot(ctx,await body(request))});return;}
    const botRuns=/^\/v1\/automations\/bots\/([^/]+)\/runs$/.exec(url.pathname);if(botRuns&&request.method==='GET'){send(response,200,{data:await automations.runs(ctx,AssetId.parse(botRuns[1]))});return;}
    const connectorEvent=/^\/v1\/connectors\/([^/]+)\/events$/.exec(url.pathname);if(connectorEvent&&request.method==='POST'){send(response,201,{data:await automations.event(ctx,AssetId.parse(connectorEvent[1]),await body(request))});return;}
    if(url.pathname===CLIENT_ROUTES.sourceArtifactSubmit.path&&request.method==='POST'){send(response,201,{data:await sourceArtifacts.register(ctx,await body(request))});return;}
    const sourceArtifact=/^\/v1\/source-artifacts\/([^/]+)$/.exec(url.pathname);if(sourceArtifact&&request.method==='GET'){send(response,200,{data:await sourceArtifacts.get(ctx,AssetId.parse(sourceArtifact[1]))});return;}
    if(request.method==='POST'&&[CLIENT_ROUTES.oauthDevice.path,CLIENT_ROUTES.oauthClientCredentials.path].includes(url.pathname as any)){send(response,201,{data:await oauth.start(ctx,await body(request),url.pathname===CLIENT_ROUTES.oauthDevice.path?'device_authorization':'client_credentials')});return;}
    const oauthPoll=/^\/v1\/credentials\/oauth\/device\/(ofl_[a-f0-9]{32})\/poll$/.exec(url.pathname);if(oauthPoll&&request.method==='POST'){CLIENT_ROUTES.oauthPoll.request.parse(await body(request));send(response,200,{data:await oauth.poll(ctx,oauthPoll[1])});return;}
    if(url.pathname===CLIENT_ROUTES.skillpacks.path){
      if(request.method==='GET'){send(response,200,{data:await skills.list(ctx)});return;}
      if(request.method==='POST'){send(response,201,{data:await skills.submit(ctx,await body(request,MAX_WORKER_REPORT_BYTES),z.string().optional().parse(request.headers['x-scope-id']))});return;}
    }
    const skillRun=/^\/v1\/skillpacks\/([^/]+)\/runs$/.exec(url.pathname);
    if(skillRun&&request.method==='POST'){send(response,202,{data:await skills.run(ctx,SkillPackId.parse(skillRun[1]),await body(request,MAX_WORKER_REPORT_BYTES))});return;}
    if(url.pathname===CLIENT_ROUTES.tools.path&&request.method==='GET'){
      const listing=await catalog.list(ctx);response.setHeader('etag',listing.etag);response.setHeader('vary','Authorization');
      if(request.headers['if-none-match']===listing.etag){closeOnShutdown(response);response.writeHead(304);response.end();}
      else send(response,200,{data:listing.tools});return;
    }
    const toolCall=/^\/v1\/tools\/([^/]+)\/call$/.exec(url.pathname);
    if(toolCall&&request.method==='POST'){const name=ToolName.parse(decodeURIComponent(toolCall[1])),value=await catalog.call(ctx,name,ToolCallInput.parse(await body(request)),shutdownSignal.signal);send(response,'taskId' in value?202:200,{data:value});return;}
    if(url.pathname==='/v1/knowledge/search'&&request.method==='GET'){
      const query=KnowledgeSearchQuery.parse({q:url.searchParams.get('q')??undefined,mode:url.searchParams.get('mode')??undefined,limit:url.searchParams.get('limit')??undefined,includeCandidates:url.searchParams.get('includeCandidates')??undefined});
      send(response,200,{data:await graph.search(ctx,query)});return;
    }
    const knowledgeContent=/^\/v1\/knowledge\/records\/([^/]+)\/content$/.exec(url.pathname);
    if(knowledgeContent&&request.method==='GET'){download(response,await graph.content(ctx,KnowledgeRecordId.parse(knowledgeContent[1])));return;}
    const knowledgeRead=/^\/v1\/knowledge\/(records|reviews)\/([^/]+)$/.exec(url.pathname);
    if(knowledgeRead&&request.method==='GET'){const id=KnowledgeRecordId.parse(knowledgeRead[2]);send(response,200,{data:knowledgeRead[1]==='records'?await graph.get(ctx,id):await graph.reviewBundle(ctx,id)});return;}
    const knowledgeReview=/^\/v1\/knowledge\/claims\/([^/]+)\/(request-review|review)$/.exec(url.pathname);
    if(knowledgeReview&&request.method==='POST'){const id=KnowledgeRecordId.parse(knowledgeReview[1]),value=await body(request);
      send(response,200,{data:knowledgeReview[2]==='request-review'?await graph.requestReview(ctx,id,KnowledgeReviewRequest.parse(value).reviewerId):await graph.review(ctx,id,value)});return;}
    if(request.method==='POST'&&url.pathname.startsWith('/v1/knowledge/')){
      const action=url.pathname.slice('/v1/knowledge/'.length),value=await body(request,MAX_WORKER_REPORT_BYTES);
      if(action==='sources')send(response,201,{data:await graph.source(ctx,value)});
      else if(action==='evidence')send(response,201,{data:await graph.evidence(ctx,value)});
      else if(action==='entities')send(response,201,{data:await graph.entity(ctx,value)});
      else if(action==='claims')send(response,201,{data:await graph.claim(ctx,value)});
      else if(action==='snapshots')send(response,201,{data:await graph.snapshot(ctx,value)});
      else throw new ApiError('TARGET_NOT_FOUND','API route not found');return;
    }
    if(url.pathname==='/v1/assets'){
      if(request.method==='POST'){send(response,201,{data:await assets.register(ctx,AssetRegistration.parse(await body(request)))});return;}
      if(request.method==='GET'){const query=AssetListQuery.parse({limit:url.searchParams.get('limit')??undefined,after:url.searchParams.get('after')??undefined,kind:url.searchParams.get('kind')??undefined,lifecycle:url.searchParams.get('lifecycle')??undefined});send(response,200,{data:await assets.list(ctx,query)});return;}
    }
    const assetRoute=/^\/v1\/assets\/([^/]+)(?:\/(credentials|lifecycle|health))?$/.exec(url.pathname);
    if(assetRoute){const id=AssetId.parse(assetRoute[1]);
      if(request.method==='GET'&&!assetRoute[2]){send(response,200,{data:await assets.get(ctx,id)});return;}
      if(request.method==='POST'){
        if(assetRoute[2]==='credentials')send(response,201,{data:await assets.credential(ctx,id,CredentialRegistration.parse(await body(request,MAX_BODY_BYTES*2)))});
        else if(assetRoute[2]==='lifecycle')send(response,200,{data:await assets.transition(ctx,id,AssetTransition.parse(await body(request)))});
        else if(assetRoute[2]==='health'){await body(request);send(response,200,{data:await assets.check(ctx,id)});}else throw new ApiError('TARGET_NOT_FOUND','API route not found');return;
      }
    }
    if(url.pathname===CLIENT_ROUTES.objectTypes.path&&request.method==='GET'){send(response,200,{data:await objectTypes.list(ctx)});return;}
    if(url.pathname===CLIENT_ROUTES.objects.path&&request.method==='GET'){
      const query=ObjectListQuery.parse({limit:url.searchParams.get('limit')??undefined,after:url.searchParams.get('after')??undefined,
        typeId:url.searchParams.get('typeId')??undefined,system:url.searchParams.get('system')??undefined});
      send(response,200,{data:await entities.list(ctx,query)});return;
    }
    const objectRoute=/^\/v1\/objects\/([^/]+)(?:\/(observations|relations))?$/.exec(url.pathname);
    if(objectRoute&&request.method==='GET'){
      const id=EntityId.parse(objectRoute[1]);
      if(objectRoute[2]==='observations')send(response,200,{data:await entities.observations(ctx,id)});
      else if(objectRoute[2]==='relations'){
        const limit=ObjectListQuery.shape.limit.parse(url.searchParams.get('limit')??undefined),after=RelationId.optional().parse(url.searchParams.get('after')??undefined);
        send(response,200,{data:await entities.relations(ctx,id,limit,after)});
      }else send(response,200,{data:await entities.get(ctx,id)});return;
    }
    if (url.pathname === '/v1/status' && request.method === 'GET') { send(response,200,{data:{apiVersion:API_VERSION,syntheticOnly:true,bootId,processId:process.pid}});return; }
    if (url.pathname === CLIENT_ROUTES.tasks.path && request.method === CLIENT_ROUTES.tasks.method) {
      const query=TaskListQuery.parse({limit:url.searchParams.get('limit')??undefined,kind:url.searchParams.get('kind')??undefined,capabilityPackId:url.searchParams.get('capabilityPackId')??undefined,after:url.searchParams.get('after')??undefined});
      send(response,200,{data:await tasks.list(ctx,query.limit,query)});return;
    }
    if (url.pathname === '/v1/packs' && request.method === 'GET') {
      await auth.check(ctx,'methods.use'); send(response,200,{ data:packages.descriptors }); return;
    }
    if(url.pathname==='/v1/rules'&&request.method==='POST'){send(response,201,{data:await rules.create(ctx,RuleRequest.parse(await body(request)))});return;}
    const ruleRoute=/^\/v1\/rules\/([^/]+)$/.exec(url.pathname);if(ruleRoute&&request.method==='GET'){send(response,200,{data:await rules.get(ctx,ruleRoute[1])});return;}
    if (url.pathname === '/v1/sources' && request.method === 'POST') {
      let source;
      if (request.headers['content-type']?.split(';')[0] === 'application/octet-stream') {
        const scopeId = ScopeId.parse(request.headers['x-scope-id']); await auth.check(ctx,'sources.write',scopeId);
        let fileName: string;
        try { fileName = decodeURIComponent(z.string().parse(request.headers['x-file-name'])); } catch { throw new ApiError('INVALID_PAYLOAD','A percent-encoded x-file-name header is required'); }
        source = await knowledge.upload(ctx,scopeId,fileName,await bytes(request,MAX_SOURCE_BYTES));
      } else {
        const input = SourceUpload.parse(await body(request,Math.ceil(MAX_SOURCE_BYTES*4/3)+4096));
        source = await knowledge.upload(ctx,input.scopeId,input.fileName,base64(input.contentBase64));
      }
      send(response,201,{ data:source }); return;
    }
    const content = /^\/v1\/(sources|artifacts|evidence)\/([^/]+)\/content$/.exec(url.pathname);
    if (content && request.method === 'GET') {
      if (content[1] === 'sources') download(response,await knowledge.sourceBytes(ctx,content[2]));
      else download(response,await knowledge.content(ctx,content[1] === 'artifacts' ? 'artifact' : 'evidence',content[2]));
      return;
    }
    if (url.pathname === '/v1/tasks/submit' && request.method === 'POST') {
      const submission = SubmitRequest.parse(await body(request));
      const accepted = await store.transaction(async tx => {
        const owner=await packages.prepare(ctx,submission,tx);
        const task=await tasks.submit(ctx,submission,tx);
        if(owner&&!task.deduplicated)await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({delegatedOwnerId:owner})]);return task;
      });
      send(response,202,{ data:accepted }); return;
    }
    const professionalRoute=/^\/v1\/tasks\/([^/]+)\/(conclusions|checklist|delivery)(?:\/([^/]+))?$/.exec(url.pathname);
    if(professionalRoute&&request.method==='GET'&&professionalRoute[2]==='conclusions'){
      const id=TaskId.parse(professionalRoute[1]);await tasks.load(ctx,id);
      const records=await store.transaction(async tx=>{const ids=(await tx.query('SELECT conclusion_id FROM conclusions WHERE task_id=$1 ORDER BY created_at,conclusion_id',[id])).rows;
        return Promise.all(ids.map(row=>knowledge.conclusion(ctx,id,row.conclusion_id,tx)));});send(response,200,{data:records});return;
    }
    if(professionalRoute&&request.method==='POST'){
      const id=TaskId.parse(professionalRoute[1]),action=professionalRoute[2],input=await body(request);
      if(action==='conclusions')send(response,200,{data:await assessments.assess(ctx,id,ConclusionRequest.parse(input))});
      else if(action==='checklist')send(response,200,{data:professionalRoute[3]?await checklists.satisfy(ctx,id,professionalRoute[3],ChecklistResponse.parse(input)):await checklists.set(ctx,id,ChecklistRequest.parse(input))});
      else send(response,200,{data:await checklists.deliver(ctx,id,z.object({inputRevisionId:InputRevisionId}).parse(input).inputRevisionId)});return;
    }
    const approvalRoute=/^\/v1\/tasks\/([^/]+)\/approvals(?:\/([^/]+))?$/.exec(url.pathname);
    if(approvalRoute&&request.method===CLIENT_ROUTES.approvals.method&&!approvalRoute[2]){
      send(response,200,{data:await approvals.list(ctx,TaskId.parse(approvalRoute[1]))});return;
    }
    if(approvalRoute&&request.method==='POST'){
      const taskId=TaskId.parse(approvalRoute[1]);
      send(response,200,{data:approvalRoute[2]?await approvals.respond(ctx,taskId,approvalRoute[2],ApprovalRequest.parse(await body(request))):await approvals.propose(ctx,taskId,ApprovalProposal.parse(await body(request)))});return;
    }
    const operationRoute=/^\/v1\/tasks\/([^/]+)\/operations$/.exec(url.pathname);
    if(operationRoute){const id=TaskId.parse(operationRoute[1]);
      if(request.method==='GET'){send(response,200,{data:await execution.list(ctx,id)});return;}
      if(request.method==='POST'){send(response,202,{data:await execution.submit(ctx,id,OperationRequest.parse(await body(request)))});return;}
    }
    const match = /^\/v1\/tasks\/([^/]+)\/(status|result|input|cancel|reconcile|events)$/.exec(url.pathname);
    if (match) {
      const taskId = TaskId.parse(match[1]); const action = match[2];
      if ((action === 'status' || action === 'result') && request.method === 'GET') {
        send(response, 200, { data: action === 'result' ? await tasks.result(ctx,taskId) : await tasks.status(ctx, taskId) }); return;
      }
      if (action === 'input' && request.method === 'POST') {
        const input = InputRequest.parse(await body(request)); const task = await tasks.load(ctx,taskId,'tasks.input');
        requireCondition(task.capabilityPackId!=='asset-tool','DECISION_CONFLICT','Tool arguments are pinned; submit a new tool call');
        await packages.replacement(ctx,task,input);
        send(response,200,{ data:await tasks.input(ctx,taskId,input) }); return;
      }
      if (action === 'cancel' && request.method === 'POST') { await body(request); send(response, 202, { data: await tasks.cancel(ctx, taskId) }); return; }
      if (action === 'reconcile' && request.method === 'POST') {
        const input=z.object({operationId:z.string().optional()}).parse(await body(request));await tasks.load(ctx,taskId,'tasks.input');
        if(input.operationId){send(response,202,{data:await execution.requestReconcile(ctx,taskId,input.operationId)});return;}
        send(response,200,{ data:{ ...await tasks.result(ctx,taskId),reconciliation:'No independently observed receipt is available for an unknown execution' } }); return;
      }
      if (action === 'events' && request.method === 'GET') {
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0);
        const waitMs = z.coerce.number().int().min(0).max(30_000).parse(url.searchParams.get('waitMs') ?? 0);
        const deadline = Date.now() + waitMs; let events;
        do {
          await auth.authenticate(request.headers.authorization);
          events = await tasks.events(ctx, taskId, after);
          if (events.length || Date.now() >= deadline || response.destroyed || closing) break;
          await waitForEvents();
        } while (true);
        if (!response.destroyed) send(response, 200, { data: { events, after: events.at(-1)?.seq ?? after } }); return;
      }
    }
    if (url.pathname === '/v1/workers/register' && request.method === 'POST') {
      await body(request); send(response,200,{ data:await execution.register(ctx) }); return;
    }
    if (url.pathname === '/v1/workers/claim' && request.method === 'POST') {
      const input=z.object({exclude:z.array(StandardOperation).max(10).default([])}).parse(await body(request));send(response,200,{ data:await execution.claim(ctx,input.exclude) }); return;
    }
    const workerRoute = /^\/v1\/workers\/operations\/([^/]+)\/(preflight|heartbeat|source|report|events|local-stopped)$/.exec(url.pathname);
    if (workerRoute) {
      const id = workerRoute[1]; const action = workerRoute[2];
      if (action === 'source' && request.method === 'GET') {
        const fence = z.coerce.number().int().positive().parse(url.searchParams.get('fence'));
        const { task,source } = await execution.preflight(ctx,id,fence);
        download(response,await knowledge.sourceBytes({ principalId:task.principalId,tenantId:task.tenantId,kind:'user' },source.sourceRevisionId,task.scopeId)); return;
      }
      if (request.method === 'POST') {
        const input = await body(request,['report','events'].includes(action) ? MAX_WORKER_REPORT_BYTES : MAX_BODY_BYTES);
        if (action === 'report') {
          const row=(await store.pool.query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0];
          send(response,200,{data:await execution.report(ctx,id,input)});return;
        }
        if(action==='events'){const event=z.object({fencingToken:z.number().int().positive(),inputRevisionId:InputRevisionId,event:z.record(z.string(),z.unknown())}).parse(input),name=(await store.pool.query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0]?.name;send(response,200,{data:execution.customEvents.has(name)?await execution.event(ctx,id,event.fencingToken,event.inputRevisionId,event.event):await skills.event(ctx,id,event.fencingToken,event.inputRevisionId,event.event)});return;}
        if(action==='local-stopped'){const stopped=z.object({fencingToken:z.number().int().positive(),inputRevisionId:InputRevisionId,localExitObserved:z.literal(true)}).parse(input);send(response,200,{data:await skills.stopped(ctx,id,stopped)});return;}
        const fence = z.object({ fencingToken:z.number().int().positive() }).parse(input).fencingToken;
        if (action === 'heartbeat') send(response,200,{ data:await execution.heartbeat(ctx,id,fence) });
        else { const checked = await execution.preflight(ctx,id,fence); send(response,200,{ data:{ authorized:true,inputRevisionId:checked.task.inputRevisionId,source:checked.source,authorization:checked.authorization } }); }
        return;
      }
    }
    if (url.pathname.startsWith('/v1/admin/')) {
      const policy = await auth.check(ctx, 'admin.manage');
      if(url.pathname==='/v1/admin/object-types'&&request.method==='POST'){send(response,201,{data:await objectTypes.register(ctx,ObjectTypePackage.parse(await body(request)))});return;}
      if(url.pathname==='/v1/admin/objects/observe'&&request.method==='POST'){send(response,201,{data:await entities.observe(ctx,ObjectObservation.parse(await body(request,MAX_WORKER_REPORT_BYTES)))});return;}
      if(url.pathname==='/v1/admin/objects/relations'&&request.method==='POST'){send(response,201,{data:await entities.link(ctx,RelationObservation.parse(await body(request,MAX_WORKER_REPORT_BYTES)))});return;}
      const drain=/^\/v1\/admin\/workers\/([^/]+)\/drain$/.exec(url.pathname);
      if(drain&&request.method==='POST'){await body(request);send(response,200,{data:await execution.drain(ctx,decodeURIComponent(drain[1]))});return;}
      const connector=/^\/v1\/admin\/connectors\/([^/]+)$/.exec(url.pathname);
      if(connector&&request.method==='POST'){const input=z.object({scopeId:ScopeId,enabled:z.boolean()}).parse(await body(request));send(response,200,{data:await registry.enabled(ctx,input.scopeId,decodeURIComponent(connector[1]),input.enabled)});return;}
      if(url.pathname==='/v1/admin/approvals'&&request.method==='GET'){
        const rows=(await store.pool.query('SELECT a.* FROM approvals a JOIN tasks t USING(task_id) WHERE t.tenant_id=$1 AND t.scope_id=ANY($2::text[]) ORDER BY a.created_at',[policy.tenantId,policy.scopes])).rows;
        send(response,200,{data:rows.map(row=>approvals.view(row))});return;
      }
      if(url.pathname==='/v1/admin/audit'&&request.method==='GET'){
        const rows=(await store.pool.query('SELECT id,principal_id,scope_id,action,detail,created_at FROM audit WHERE tenant_id=$1 AND (scope_id IS NULL OR scope_id=ANY($2::text[])) ORDER BY id DESC LIMIT 500',[policy.tenantId,policy.scopes])).rows;
        send(response,200,{data:rows.map(row=>({id:Number(row.id),principalId:row.principal_id,scopeId:row.scope_id,action:row.action,detail:row.detail,createdAt:row.created_at.toISOString()}))});return;
      }
      if(url.pathname==='/v1/admin/events'&&request.method==='GET'){
        const after=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after')??0),wait=z.coerce.number().int().min(0).max(30_000).parse(url.searchParams.get('waitMs')??0),deadline=Date.now()+wait;let rows:any[];
        do{await auth.authenticate(request.headers.authorization);const current=await auth.check(ctx,'admin.manage');
          rows=(await store.pool.query("SELECT o.* FROM outbox o JOIN tasks t USING(task_id) WHERE t.tenant_id=$1 AND t.scope_id=ANY($2::text[]) AND o.seq>$3 AND (t.context->>'privateOwnerId' IS NULL OR t.context->>'privateOwnerId'=$4) ORDER BY o.seq LIMIT 500",[current.tenantId,current.scopes,after,current.principalId])).rows;
          if(rows.length||Date.now()>=deadline||closing||response.destroyed)break;await waitForEvents();
        }while(true);
        if(!response.destroyed)send(response,200,{data:{events:rows.map(row=>({seq:Number(row.seq),taskId:row.task_id,kind:row.kind,payload:row.payload,createdAt:row.created_at.toISOString()})),after:rows.length?Number(rows.at(-1).seq):after}});return;
      }
      if(url.pathname==='/v1/admin/restart'&&request.method==='POST'){
        await auth.check(ctx,'admin.restart');z.object({graceful:z.literal(true)}).parse(await body(request));requireCondition(process.connected,'INVALID_PAYLOAD','Start the server through its supervisor for graceful restart');
        await auth.audit(ctx,'server.restart',{bootId,graceful:true});send(response,202,{data:{restartAccepted:true,previousBootId:bootId}});
        restartRequested=true;process.send!({type:'graceful-restart'});return;
      }
      if (url.pathname === '/v1/admin/workers' && request.method === 'GET') {
        const rows = (await store.pool.query('SELECT worker_id,draining,last_seen FROM workers WHERE tenant_id=$1 ORDER BY worker_id',[policy.tenantId])).rows;
        send(response,200,{ data:rows.map(row => ({ workerId:row.worker_id,draining:row.draining,lastSeen:row.last_seen.toISOString() })) }); return;
      }
      if (url.pathname === '/v1/admin/tasks' && request.method === 'GET') {
        const rows = (await store.pool.query("SELECT task_id FROM tasks WHERE tenant_id=$1 AND scope_id=ANY($2::text[]) AND (context->>'privateOwnerId' IS NULL OR context->>'privateOwnerId'=$3)", [policy.tenantId, policy.scopes,policy.principalId])).rows;
        send(response, 200, { data: await Promise.all(rows.map(row => tasks.status(ctx, row.task_id))) }); return;
      }
    }
    throw new ApiError('TARGET_NOT_FOUND', 'API route not found');
  } catch (error) {
    const failure = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_PAYLOAD', 'Payload does not satisfy the contract',{issues:error.issues.slice(0,20).map(issue=>({path:issue.path,code:issue.code,message:issue.message}))})
      : new ApiError('INTERNAL_ERROR', 'The transaction or server operation failed');
    if (!response.destroyed && !response.headersSent) send(response, failure.httpStatus, { error: { code: failure.code, category: failure.category,
      message: failure.message, details: failure.details, retryable: false } });
  } finally {
    activeRequests.delete(completed.promise);completed.resolve();
  }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
let running: Promise<void> | undefined;
const timer = setInterval(() => {
  if (running || closing) return;
  running = tasks.runOnce().then(()=>packages.runOnce()).then(()=>automations.tick()).catch(error => { console.error(JSON.stringify({type:'runner-transaction-failed',code:error instanceof ApiError?error.code:(error as any).code??'INTERNAL_ERROR'})); }).finally(() => { running = undefined; });
}, Number(process.env.CIRCLE_SERVER_POLL_MS ?? 100));
let indexing:Promise<void>|undefined;
const indexTimer=setInterval(()=>{if(indexing||closing)return;indexing=ingestions.runOnce().catch(error=>{console.error(JSON.stringify({type:'source-index-transaction-failed',code:error instanceof ApiError?error.code:'INTERNAL_ERROR'}));}).finally(()=>{indexing=undefined;});},Number(process.env.CIRCLE_SERVER_INDEX_POLL_MS??100));
await new Promise<void>(resolve => server.listen(Number(process.env.CIRCLE_SERVER_PORT ?? 8080), '127.0.0.1', resolve));
const address = server.address() as { port: number };
console.log(JSON.stringify({ type: 'ready', url: `${tls?'https':'http'}://127.0.0.1:${address.port}`, apiVersion: API_VERSION, syntheticOnly: true }));
async function shutdown(): Promise<void> {
  if (closing) return; closing = true; clearInterval(timer);clearInterval(indexTimer);
  shutdownSignal.abort();
  await closeHttpServer(server);
  await privateIPC.close();
  // Closing a socket is not completion of the transaction it was waiting for.
  await Promise.all(activeRequests);
  await running;await indexing; await store.pool.end();
  if (process.connected) process.disconnect();
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
process.once('disconnect', () => { void shutdown(); });
