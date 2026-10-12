import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { z } from 'zod';
import { API_VERSION, MAX_BODY_BYTES, MAX_SOURCE_BYTES, MAX_WORKER_REPORT_BYTES, CLIENT_ROUTES, TaskListQuery, ApiError, SubmitRequest,
  InputRequest, OperationRequest, ApprovalProposal, ApprovalRequest, ConclusionRequest, ChecklistRequest, ChecklistResponse, RuleRequest, DefectReviewPack, LbxPack, InputRevisionId, TaskId, ScopeId, SourceUpload, Base64Content, MindmapCompileInput, MindmapPack, DevLoginRequest, requireCondition,
  EntityId,RelationId,ObjectListQuery,ObjectTypePackage,ObjectObservation,RelationObservation } from '../../../packages/contracts/src/index.ts';
import { Store } from '../../../packages/storage/src/index.ts';
import { taskMigration } from '../../../packages/tasks/src/migration.ts';
import { Auth } from '../../../packages/tasks/src/auth.ts';
import { Tasks } from '../../../packages/tasks/src/index.ts';
import { mindmapTaskMigration } from '../../../packages/tasks/src/mindmap-migration.ts';
import { knowledgeMigration } from '../../../packages/knowledge/src/migration.ts';
import { Knowledge } from '../../../packages/knowledge/src/index.ts';
import { LocalObjects } from '../../../packages/knowledge/src/objects.ts';
import { executionMigration } from '../../../packages/execution/src/migration.ts';
import { Operations } from '../../../packages/execution/src/operations.ts';
import { resourceMigration } from '../../../packages/execution/src/resource-migration.ts';
import { approvalMigration } from '../../../packages/tasks/src/approval-migration.ts';
import { Approvals } from '../../../packages/tasks/src/approvals.ts';
import { conclusionMigration } from '../../../packages/knowledge/src/conclusion-migration.ts';
import { Records } from '../../../packages/knowledge/src/records.ts';
import { Assessments } from '../../../packages/methods/src/assessments.ts';
import { Checklists } from '../../../packages/tasks/src/checklists.ts';
import { checklistMigration } from '../../../packages/tasks/src/checklist-migration.ts';
import { connectorMigration } from '../../../packages/tasks/src/connector-migration.ts';
import { ConnectorRegistry } from '../../../packages/tasks/src/connector-registry.ts';
import { Rules } from '../../../packages/tasks/src/rules.ts';
import { ProfessionalRunner } from './professional-runner.ts';
import { MindmapRunner } from './mindmap-runner.ts';
import { closeHttpServer } from './shutdown.ts';
import {entityMigration} from '../../../packages/knowledge/src/entity-migration.ts';
import {TypeCatalog} from '../../../packages/knowledge/src/type-catalog.ts';
import {Entities} from '../../../packages/knowledge/src/entities.ts';

function environment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const store = new Store(JSON.parse(environment('CIRCLE_SERVER_DATABASE_CONFIG')));
await store.migrate([taskMigration,mindmapTaskMigration,knowledgeMigration,executionMigration,resourceMigration,approvalMigration,conclusionMigration,checklistMigration,connectorMigration,entityMigration]);
const auth = new Auth(store);
requireCondition(process.env.CIRCLE_SERVER_DEV_AUTH === '1', 'INVALID_PAYLOAD', 'Phase one requires explicitly enabled development authentication');
await auth.initializeDevelopment(environment('CIRCLE_SERVER_DEV_IDENTITIES'));
await mkdir(environment('CIRCLE_SERVER_DATA_DIR'), { recursive: true, mode: 0o700 });
const tasks = new Tasks(store, auth, Number(process.env.CIRCLE_SERVER_INPUT_TTL_MS ?? 300_000));
const knowledge = new Records(store,auth,new LocalObjects(environment('CIRCLE_SERVER_DATA_DIR')));
const objectTypes=new TypeCatalog(store,auth),entities=new Entities(store,auth,knowledge,objectTypes);
knowledge.sourceAccess=(ctx,id,tx)=>entities.checkSourceAccess(ctx,id,tx);
const execution = new Operations(store,auth,tasks,knowledge);
const approvals=new Approvals(store,auth,tasks);execution.approvalCheck=(tx,task,spec)=>approvals.check(tx,task,spec);
const assessments=new Assessments(store,tasks,knowledge),checklists=new Checklists(store,tasks,knowledge);
const registry=new ConnectorRegistry(store,auth);await registry.initialize();execution.connectorCheck=(tx,actor,scope,spec)=>registry.check(tx,actor,scope,spec);
const rules=new Rules(store,auth,tasks,execution,registry),professional=new ProfessionalRunner(store,tasks,execution,knowledge,checklists,approvals,assessments);
const mindmaps = new MindmapRunner(store,tasks,knowledge,execution);
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
function base64(value: string): Buffer {
  Base64Content.parse(value);
  return Buffer.from(value,'base64');
}
const server = createServer(async (request, response) => {
  const completed=Promise.withResolvers<void>();activeRequests.add(completed.promise);
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (['/v1/auth/token','/v1/auth/dev-login'].includes(url.pathname) && request.method === 'POST') {
      const input = DevLoginRequest.parse(await body(request));
      const issued = await auth.issue(input.username,input.password,input.expiresInMs);
      const identity = await auth.authenticate(`Bearer ${issued.token}`); const policy = await auth.policy(identity);
      send(response,200,{ data:{ ...issued,tokenType:'Bearer',principalId:policy.principalId,tenantId:policy.tenantId,scopes:policy.scopes } }); return;
    }
    const ctx = await auth.authenticate(request.headers.authorization);
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
      const {limit}=TaskListQuery.parse({limit:url.searchParams.get('limit')??undefined});
      send(response,200,{data:await tasks.list(ctx,limit)});return;
    }
    if (url.pathname === '/v1/packs' && request.method === 'GET') {
      await auth.check(ctx,'methods.use'); send(response,200,{ data:[MindmapPack,DefectReviewPack,LbxPack] }); return;
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
        if (submission.capabilityPackId === 'mindmap-compile') {
          await auth.check(ctx,'methods.use',submission.scopeId,tx);
          const input = MindmapCompileInput.parse(submission.input);
          const source = await knowledge.source(ctx,input.sourceRevisionId,submission.scopeId,tx);
          requireCondition(!input.sourceSha256 || input.sourceSha256 === source.sha256,'SOURCE_HASH_MISMATCH','Submitted source hash differs');
          submission.input = { ...input,sourceSha256:source.sha256 };
        }
        let owner:string|undefined;
        if(submission.capabilityPackId==='defect-review')owner=await rules.authorizeSubmission(ctx,submission.input,submission.scopeId,tx);
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
        if (task.capabilityPackId === 'mindmap-compile') {
          requireCondition(!!input.replacement,'INVALID_PAYLOAD','Compilation input replacement must supply a source reference');
          const replacement = MindmapCompileInput.parse(input.replacement);
          const source = await knowledge.source(ctx,replacement.sourceRevisionId,task.scopeId);
          requireCondition(!replacement.sourceSha256 || replacement.sourceSha256 === source.sha256,'SOURCE_HASH_MISMATCH','Replacement source hash differs');
          input.replacement = { ...replacement,sourceSha256:source.sha256 };
        }
        send(response,200,{ data:await tasks.input(ctx,taskId,input) }); return;
      }
      if (action === 'cancel' && request.method === 'POST') { await body(request); send(response, 202, { data: await tasks.cancel(ctx, taskId) }); return; }
      if (action === 'reconcile' && request.method === 'POST') {
        const input=z.object({operationId:z.string().optional()}).parse(await body(request));await tasks.load(ctx,taskId,'tasks.input');
        if(input.operationId){send(response,202,{data:await execution.requestReconcile(ctx,taskId,input.operationId)});return;}
        send(response,200,{ data:{ ...await tasks.result(ctx,taskId),reconciliation:'No independently observed receipt is available for an unknown compilation' } }); return;
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
      await body(request); send(response,200,{ data:await execution.claim(ctx) }); return;
    }
    const workerRoute = /^\/v1\/workers\/operations\/([^/]+)\/(preflight|heartbeat|source|report)$/.exec(url.pathname);
    if (workerRoute) {
      const id = workerRoute[1]; const action = workerRoute[2];
      if (action === 'source' && request.method === 'GET') {
        const fence = z.coerce.number().int().positive().parse(url.searchParams.get('fence'));
        const { task,source } = await execution.preflight(ctx,id,fence);
        download(response,await knowledge.sourceBytes({ principalId:task.principalId,tenantId:task.tenantId,kind:'user' },source.sourceRevisionId,task.scopeId)); return;
      }
      if (request.method === 'POST') {
        const input = await body(request,action === 'report' ? MAX_WORKER_REPORT_BYTES : MAX_BODY_BYTES);
        if (action === 'report') {
          const row=(await store.pool.query('SELECT name FROM operations WHERE operation_id=$1',[id])).rows[0];
          send(response,200,{data:row?.name==='mindmaps.compile'?await mindmaps.report(ctx,id,input):await execution.report(ctx,id,input)});return;
        }
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
          rows=(await store.pool.query('SELECT o.* FROM outbox o JOIN tasks t USING(task_id) WHERE t.tenant_id=$1 AND t.scope_id=ANY($2::text[]) AND o.seq>$3 ORDER BY o.seq LIMIT 500',[current.tenantId,current.scopes,after])).rows;
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
        const rows = (await store.pool.query('SELECT task_id FROM tasks WHERE tenant_id=$1 AND scope_id=ANY($2::text[])', [policy.tenantId, policy.scopes])).rows;
        send(response, 200, { data: await Promise.all(rows.map(row => tasks.status(ctx, row.task_id))) }); return;
      }
    }
    throw new ApiError('TARGET_NOT_FOUND', 'API route not found');
  } catch (error) {
    const failure = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_PAYLOAD', 'Payload does not satisfy the contract')
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
  running = tasks.runOnce().then(() => mindmaps.runOnce()).then(()=>rules.tick()).then(()=>professional.runOnce()).catch(error => { console.error(JSON.stringify({type:'runner-transaction-failed',code:error instanceof ApiError?error.code:(error as any).code??'INTERNAL_ERROR'})); }).finally(() => { running = undefined; });
}, Number(process.env.CIRCLE_SERVER_POLL_MS ?? 100));
await new Promise<void>(resolve => server.listen(Number(process.env.CIRCLE_SERVER_PORT ?? 8080), '127.0.0.1', resolve));
const address = server.address() as { port: number };
console.log(JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${address.port}`, apiVersion: API_VERSION, syntheticOnly: true }));
async function shutdown(): Promise<void> {
  if (closing) return; closing = true; clearInterval(timer);
  shutdownSignal.abort();
  await closeHttpServer(server);
  // Closing a socket is not completion of the transaction it was waiting for.
  await Promise.all(activeRequests);
  await running; await store.pool.end();
  if (process.connected) process.disconnect();
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
process.once('disconnect', () => { void shutdown(); });
