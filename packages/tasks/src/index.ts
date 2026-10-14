import { ApiError, FLOW_VERSION, PACK_FLOWS, IDEMPOTENCY_WINDOW_MS, canonicalHash,canonicalJson,sha256, newId, requireCondition, terminalTask,
  type AuthContext, type Event, type SubmitRequest, type Task, type TaskView } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import type { Auth } from './auth.ts';
import {facetedPage} from '../../storage/src/faceted-query.ts';
import {TaskAssignment, type TaskPageQuery} from '../../contracts/src/index.ts';import type {z} from 'zod';
import {taskQueryPlan} from './task-query.ts';
import {outboxWritten,replayWindow} from './outbox-retention.ts';
import {notificationPayload} from './notification-payload.ts';

export function taskFromRow(row: Record<string, any>): Task {
  return { taskId: row.task_id, tenantId: row.tenant_id, scopeId: row.scope_id, principalId: row.principal_id,
    title: row.title, phase: row.phase, inputRevisionId: row.input_revision_id, input: row.input,
    revision: row.revision, flowVersion: row.flow_version,waitingReason:row.waiting_reason??null,assignee:row.assignee_principal_id??null,dueAt:row.due_at?.toISOString()??null,
    ...(row.capability_pack_id ? { capabilityPackId: row.capability_pack_id, packVersion: row.pack_version } : {}) };
}
export class Tasks {
  store: Store; auth: Auth; inputTtlMs: number;
  capabilities=new Map<string,{version:string;flowVersion:string;privateByDefault?:boolean}>(Object.entries(PACK_FLOWS).map(([id,flowVersion])=>[id,{version:'1.0.0',flowVersion,privateByDefault:!['asset-registration','change-set'].includes(id)}]));
  deliveryValidators=new Map<string,(tx:Transaction,task:Task,result:any)=>Promise<{itemId:string;conclusionId:string}[]>>();
  baseFlows=new Set<string>([FLOW_VERSION]);
  constructor(store: Store, auth: Auth, inputTtlMs = 300_000) { this.store = store; this.auth = auth; this.inputTtlMs = inputTtlMs; }
  async internal(tx:Transaction,taskId:string,lock=false):Promise<Task> {
    const row=(await tx.query(`SELECT * FROM tasks WHERE task_id=$1${lock?' FOR UPDATE':''}`,[taskId])).rows[0];
    requireCondition(row,'TARGET_NOT_FOUND','Task not found for durable bookkeeping');return taskFromRow(row);
  }
  async context(ctx:AuthContext,id:string,inputRevisionId:string,patch?:Record<string,unknown>):Promise<any>{return this.store.transaction(async tx=>{
    const task=await this.load(ctx,id,'tasks.read',tx,true);requireCondition(task.inputRevisionId===inputRevisionId,'INPUT_REVISION_STALE','Runtime context revision changed');
    const old=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[id])).rows[0].context;
    if(patch)await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[id,JSON.stringify({...old,...patch})]);return {...old,...patch};
  });}
  async load(ctx: AuthContext, taskId: string, grant = 'tasks.read', tx?: Transaction, lock = false): Promise<Task> {
    const row = (await (tx ?? this.store.pool).query(`SELECT * FROM tasks WHERE task_id=$1${lock ? ' FOR UPDATE' : ''}`, [taskId])).rows[0];
    requireCondition(row, 'TARGET_NOT_FOUND', 'Task not found');
    const policy = await this.auth.check(ctx, grant, row.scope_id, tx);
    requireCondition(policy.tenantId === row.tenant_id, 'FORBIDDEN_SCOPE', 'Task belongs to a different tenant');
    requireCondition(!row.context?.privateOwnerId||row.context.privateOwnerId===policy.principalId,'FORBIDDEN_SCOPE','Task is outside the readable partition');
    requireCondition(!ctx.run||row.task_id===ctx.run.taskId||row.context?.parentRunTaskId===ctx.run.taskId,'FORBIDDEN_SCOPE','Task is outside the delegated run');
    return taskFromRow(row);
  }
  async emit(tx: Transaction, taskId: string, kind: string, payload: unknown): Promise<void> {
    // Serialize allocation through commit so after=seq cannot skip an uncommitted lower sequence.
    const seq = (await tx.query('UPDATE event_clock SET value=value+1 WHERE singleton RETURNING value')).rows[0].value;
    await tx.query('INSERT INTO outbox(seq,task_id,kind,payload) VALUES($1,$2,$3,$4)', [seq, taskId, kind, JSON.stringify(payload)]);
    await outboxWritten(tx);
  }
  async wake(tx: Transaction, taskId: string, reason: string): Promise<void> {
    await tx.query('INSERT INTO wakeups(task_id,reason) VALUES($1,$2)', [taskId, reason]);
  }
  async submit(ctx: AuthContext, request: SubmitRequest, tx?: Transaction,admissionGrant='tasks.submit'): Promise<Task & { deduplicated: boolean }> {
    const execute = async (client: Transaction) => {
      requireCondition(admissionGrant==='tasks.submit'||admissionGrant==='tools.read'&&request.capabilityPackId==='asset-tool','FORBIDDEN_ACTION','Internal read admission applies only to tool tasks');const policy = await this.auth.check(ctx, admissionGrant, request.scopeId, client);
      const capability=request.capabilityPackId?this.capabilities.get(request.capabilityPackId):undefined;
      requireCondition(!request.capabilityPackId||capability,'UNSUPPORTED_VERSION','Capability package is not installed');
      requireCondition(policy.kind !== 'worker', 'FORBIDDEN_ACTION', 'Workers cannot submit tasks');
      const keys = [policy.tenantId, request.scopeId, policy.principalId, 'submit', request.idempotencyKey];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(keys)]);
      const hash = canonicalHash({ title: request.title, input: request.input, capabilityPackId: request.capabilityPackId });
      const old = (await client.query(`SELECT * FROM idempotency WHERE tenant_id=$1 AND scope_id=$2 AND principal_id=$3 AND action=$4 AND idem_key=$5
        AND created_at>clock_timestamp()-($6::double precision*interval '1 millisecond')`, [...keys, IDEMPOTENCY_WINDOW_MS])).rows[0];
      if (old) {
        requireCondition(old.request_hash === hash, 'IDEMPOTENCY_MISMATCH', 'The same key was used with different canonical content');
        return { ...await this.load(ctx, old.task_id, 'tasks.read', client), deduplicated: true };
      }
      const taskId = newId('task'); const inputRevisionId = newId('inrev');
      await client.query(`INSERT INTO tasks(task_id,tenant_id,scope_id,principal_id,title,phase,input_revision_id,input,flow_version,capability_pack_id,pack_version)
        VALUES($1,$2,$3,$4,$5,'admitted',$6,$7,$8,$9,$10)`, [taskId, policy.tenantId, request.scopeId, policy.principalId,
        request.title, inputRevisionId, JSON.stringify(request.input), capability?.flowVersion??FLOW_VERSION, request.capabilityPackId ?? null,
        capability?.version??null]);
      await client.query('INSERT INTO input_revisions(input_revision_id,task_id,input,principal_id) VALUES($1,$2,$3,$4)',
        [inputRevisionId, taskId, JSON.stringify(request.input), policy.principalId]);
      if(ctx.run)await client.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[taskId,JSON.stringify({privateOwnerId:ctx.principalId,parentRunTaskId:ctx.run.taskId})]);
      else if(capability?.privateByDefault)await client.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[taskId,JSON.stringify({privateOwnerId:ctx.principalId})]);
      await client.query(`INSERT INTO idempotency(tenant_id,scope_id,principal_id,action,idem_key,request_hash,task_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,scope_id,principal_id,action,idem_key)
        DO UPDATE SET request_hash=EXCLUDED.request_hash,task_id=EXCLUDED.task_id,created_at=clock_timestamp()`, [...keys, hash, taskId]);
      await this.emit(client, taskId, 'task.accepted', { taskId, inputRevisionId, title: request.title });
      await this.wake(client, taskId, 'admission');
      await this.auth.audit(ctx, 'tasks.submit', { taskId, inputRevisionId }, request.scopeId, client);
      return { ...await this.load(ctx, taskId, 'tasks.read', client), deduplicated: false };
    };
    return tx ? execute(tx) : this.store.transaction(execute);
  }
  async list(ctx:AuthContext,limit:number,query:{kind?:string;capabilityPackId?:string;after?:string}={}):Promise<TaskView[]> {
    const policy=await this.auth.check(ctx,'tasks.read');
    if(query.after)await this.load(ctx,query.after);
    const rows=(await this.store.pool.query(`SELECT task_id FROM tasks WHERE tenant_id=$1 AND scope_id=ANY($2::text[])
      AND (context->>'privateOwnerId' IS NULL OR context->>'privateOwnerId'=$3)
      AND ($4::text IS NULL OR task_id=$4 OR context->>'parentRunTaskId'=$4)
      AND ($6::text IS NULL OR CASE capability_pack_id WHEN 'asset-tool' THEN 'tool' WHEN 'asset-index' THEN 'index' ELSE 'work' END=$6)
      AND ($7::text IS NULL OR capability_pack_id=$7)
      AND ($8::text IS NULL OR (created_at,task_id)<(SELECT created_at,task_id FROM tasks WHERE task_id=$8))
      ORDER BY created_at DESC,task_id DESC LIMIT $5`,[policy.tenantId,policy.scopes,policy.principalId,ctx.run?.taskId??null,limit,query.kind??null,query.capabilityPackId??null,query.after??null])).rows;
    return Promise.all(rows.map(row=>this.status(ctx,row.task_id)));
  }
  async status(ctx: AuthContext, taskId: string): Promise<TaskView> {
    const task = await this.load(ctx, taskId);
    const pending = (await this.store.pool.query('SELECT * FROM pending_inputs WHERE task_id=$1 ORDER BY created_at,request_id', [taskId])).rows;
    return { ...task, pendingInputs: pending.map(row => ({ requestId: row.request_id, inputRevisionId: row.input_revision_id,
      kind: row.kind, question: row.question, binding: row.binding, expiresAt: row.expires_at.toISOString(), status: row.status })) };
  }
  async page(ctx:AuthContext,query:z.infer<typeof TaskPageQuery>){return this.store.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const plan=await taskQueryPlan(this.auth,ctx,query,tx);
    const page=await facetedPage(tx,ctx,'tasks',query,plan.from,plan.visible,plan.params,plan.columns,'t.*',taskFromRow);
    for(const task of page.items){const pending=(await tx.query('SELECT * FROM pending_inputs WHERE task_id=$1 ORDER BY created_at,request_id',[task.taskId])).rows;task.pendingInputs=pending.map(row=>({requestId:row.request_id,inputRevisionId:row.input_revision_id,kind:row.kind,question:row.question,binding:row.binding,expiresAt:row.expires_at.toISOString(),status:row.status}));}return page;});}
  async assign(ctx:AuthContext,id:string,value:unknown){const input=TaskAssignment.parse(value);await this.store.transaction(async tx=>{
    const task=await this.load(ctx,id,'tasks.input',tx,true);requireCondition(task.inputRevisionId===input.inputRevisionId,'INPUT_REVISION_STALE','Task assignment revision differs');requireCondition(!ctx.run&&(task.principalId===ctx.principalId||await this.auth.roles.role(ctx,task.scopeId,tx)==='admin'),'FORBIDDEN_ACTION','Only the owner or a scope administrator assigns readable tasks');
    if(input.assignee){const target=(await tx.query("SELECT 1 FROM policies p JOIN principal_scope_roles r USING(principal_id) WHERE p.principal_id=$1 AND p.tenant_id=$2 AND NOT p.disabled AND p.kind='user' AND r.scope_id=$3 AND r.role IN ('member','admin')",[input.assignee,task.tenantId,task.scopeId])).rowCount;requireCondition(target,'FORBIDDEN_SCOPE','Assignee must be an active member of the task scope');const row=(await tx.query('SELECT context FROM tasks WHERE task_id=$1',[id])).rows[0];requireCondition(!row.context.privateOwnerId||row.context.privateOwnerId===input.assignee,'FORBIDDEN_SCOPE','Assignment does not grant access to a private task');}
    await tx.query('UPDATE tasks SET assignee_principal_id=CASE WHEN $2 THEN $3 ELSE assignee_principal_id END,assigned_at=CASE WHEN $2 AND assignee_principal_id IS DISTINCT FROM $3 THEN clock_timestamp() ELSE assigned_at END,due_at=CASE WHEN $4 THEN $5::timestamptz ELSE due_at END,updated_at=clock_timestamp(),revision=revision+1 WHERE task_id=$1',[id,input.assignee!==undefined,input.assignee??null,input.dueAt!==undefined,input.dueAt??null]);await this.auth.audit(ctx,'task.assignment',{taskId:id,...input},task.scopeId,tx);await this.emit(tx,id,'task.assignment-changed',{inputRevisionId:task.inputRevisionId,assigneeId:input.assignee??null});
   });return this.status(ctx,id);}
  async result(ctx: AuthContext, taskId: string): Promise<any> {
    return this.store.transaction(async tx => {
      const task = await this.load(ctx,taskId,'tasks.read',tx,true);
      const row = (await tx.query('SELECT result,result_status,cancel_requested FROM tasks WHERE task_id=$1',[taskId])).rows[0];
      return { taskId,inputRevisionId:task.inputRevisionId,phase:task.phase,capabilityPackId:task.capabilityPackId,
        status:row.result_status ?? (task.phase === 'cancelled' ? 'cancelled' : task.phase === 'unknown' ? 'unknown' : row.cancel_requested ? 'cancel-requested' : task.phase === 'admitted' ? 'accepted' : 'running'),
        artifacts:[],evidence:[],unmapped:[],...row.result };
    });
  }
  async stage(tx: Transaction, task: Task, phase: Task['phase'], stage: string, kind: string, payload: unknown = {}): Promise<void> {
    await tx.query('UPDATE tasks SET phase=$2,stage=$3,revision=revision+1,updated_at=clock_timestamp() WHERE task_id=$1', [task.taskId, phase, stage]);
    await this.emit(tx, task.taskId, kind, { inputRevisionId: task.inputRevisionId, ...payload as object });
  }
  async waitForInput(tx:Transaction,task:Task,reason:string,error:any,evidence:any[]=[]){const requestId=newId('pin');await tx.query("UPDATE pending_inputs SET status='superseded' WHERE task_id=$1 AND status='open'",[task.taskId]);await tx.query("INSERT INTO pending_inputs(request_id,task_id,input_revision_id,kind,question,binding,expires_at) VALUES($1,$2,$3,'repair',$4,$5,clock_timestamp()+($6::double precision*interval '1 millisecond'))",[requestId,task.taskId,task.inputRevisionId,`Repair ${reason} and replace the bound input`,JSON.stringify({waitingReason:reason}),this.inputTtlMs]);await tx.query("UPDATE tasks SET waiting_reason=$2,result_status='running',result=$3 WHERE task_id=$1",[task.taskId,reason,JSON.stringify({error,evidence,artifacts:[],unmapped:[],waitingReason:reason})]);await this.stage(tx,task,'waiting-input','enforcement-wait','task.waiting-input',{requestId,waitingReason:reason,error});}
  async deliver(tx: Transaction, task: Task, result: any): Promise<void> {
    const validator=this.deliveryValidators.get(task.capabilityPackId??'');requireCondition(validator,'EVIDENCE_INSUFFICIENT','No registered delivery verifier');
    const checked=await validator(tx,task,result);
    for(const item of checked)await tx.query(`INSERT INTO checklist_items(task_id,input_revision_id,item_id,requires_fact,satisfied,conclusion_id) VALUES($1,$2,$3,true,true,$4) ON CONFLICT DO NOTHING`,[task.taskId,task.inputRevisionId,item.itemId,item.conclusionId]);
    await tx.query('UPDATE tasks SET result=$2,result_status=$3 WHERE task_id=$1', [task.taskId, JSON.stringify(result), result.status]);
    await this.stage(tx, task, 'under-review', 'review', 'task.verifying');
    await this.stage(tx, task, 'delivered', 'done', 'task.delivered', { status: result.status, artifacts: result.artifacts, unmapped: result.unmapped });
  }
  async fail(tx: Transaction, task: Task, error: unknown, evidence: unknown[] = []): Promise<void> {
    await tx.query(`UPDATE tasks SET result_status='failed',result=$2 WHERE task_id=$1`,
      [task.taskId, JSON.stringify({ error, artifacts: [], evidence, unmapped: [] })]);
    await this.stage(tx, task, 'failed', 'done', 'task.failed', { error });
  }
  async events(ctx: AuthContext, taskId: string, after: number): Promise<Event[]> {return this.store.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.load(ctx, taskId,'tasks.read',tx);
    await replayWindow(this.store,after,tx);
    const rows = (await tx.query('SELECT * FROM outbox WHERE task_id=$1 AND seq>$2 ORDER BY seq LIMIT 500', [taskId, after])).rows;
    return rows.map(row=>this.eventView(row));
  });}
  eventView(row:any):Event{const bytes=Buffer.from(canonicalJson(row.payload));return {seq:Number(row.seq),taskId:row.task_id,kind:row.kind,payload:notificationPayload(row.payload,true),createdAt:row.created_at.toISOString(),content:{sha256:sha256(bytes),size:bytes.length,downloadPath:`/v1/tasks/${row.task_id}/events/${row.seq}/content`}};}
  async eventContent(ctx:AuthContext,id:string,seq:number){return this.store.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.load(ctx,id,'tasks.read',tx);const window=await replayWindow(this.store,seq,tx);if(seq<=window.minCursor)throw new ApiError('CURSOR_EXPIRED','Event content was pruned; rebuild current state',{minCursor:window.minCursor});const row=(await tx.query('SELECT payload FROM outbox WHERE task_id=$1 AND seq=$2',[id,seq])).rows[0];requireCondition(row,'TARGET_NOT_FOUND','Event content is unavailable');const bytes=Buffer.from(canonicalJson(row.payload));return {bytes,reference:{sha256:sha256(bytes),mediaType:'application/json',fileName:`event-${seq}.json`}};});}
  async revise(tx: Transaction, task: Task, ctx: AuthContext, input: Record<string, unknown>): Promise<Task> {
    requireCondition(!terminalTask(task.phase) && task.phase !== 'unknown', 'DECISION_CONFLICT', 'Task revision is frozen in this phase');
    const revision = newId('inrev');
    await tx.query(`UPDATE tasks SET input_revision_id=$2,input=$3,phase='admitted',stage='admit',result=NULL,result_status=NULL,
      context=jsonb_strip_nulls(jsonb_build_object('delegatedOwnerId',context->'delegatedOwnerId','privateOwnerId',context->'privateOwnerId','parentRunTaskId',context->'parentRunTaskId')),waiting_reason=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE task_id=$1`, [task.taskId, revision, JSON.stringify(input)]);
    await tx.query('INSERT INTO input_revisions(input_revision_id,task_id,input,principal_id) VALUES($1,$2,$3,$4)',
      [revision, task.taskId, JSON.stringify(input), ctx.principalId]);
    await tx.query("UPDATE pending_inputs SET status='superseded' WHERE task_id=$1 AND status='open'", [task.taskId]);
    const superseded=(await tx.query("UPDATE approvals SET status='superseded',superseded_by=$2 WHERE task_id=$1 AND status='open' RETURNING approval_id",[task.taskId,revision])).rows;for(const row of superseded)await this.emit(tx,task.taskId,'approval.superseded',{approvalId:row.approval_id,inputRevisionId:task.inputRevisionId,supersededBy:revision});await tx.query("UPDATE change_sets SET status='superseded',updated_at=clock_timestamp() WHERE task_id=$1 AND status IN ('blocked','waiting-review')",[task.taskId]);
    await this.emit(tx, task.taskId, 'task.input-revised', { inputRevisionId: revision });
    await this.wake(tx, task.taskId, 'input');
    return { ...task, inputRevisionId: revision, input, phase: 'admitted', revision: task.revision + 1 };
  }
  async input(ctx: AuthContext, taskId: string, request: { inputRevisionId: string; requestId?: string;
    response?: Record<string, unknown>; replacement?: Record<string, unknown> }): Promise<Task> {
    const outcome = await this.store.transaction(async tx => {
      const task = await this.load(ctx, taskId, 'tasks.input', tx, true);
      if (request.replacement) {
        requireCondition(task.inputRevisionId === request.inputRevisionId, 'INPUT_REVISION_STALE', 'Current input revision differs');
        return { task: await this.revise(tx, task, ctx, request.replacement) };
      }
      const pending = (await tx.query('SELECT *, expires_at<=clock_timestamp() AS expired FROM pending_inputs WHERE request_id=$1 AND task_id=$2 FOR UPDATE',
        [request.requestId ?? '', taskId])).rows[0];
      let code: 'INPUT_REVISION_STALE' | 'INPUT_EXPIRED' | 'DECISION_CONFLICT' | undefined;
      let result = 'accepted';
      if (!pending || pending.kind !== 'clarification') { code = 'DECISION_CONFLICT'; result = 'missing-request'; }
      else if (task.inputRevisionId !== request.inputRevisionId || pending.input_revision_id !== task.inputRevisionId) { code = 'INPUT_REVISION_STALE'; result = 'stale-revision'; }
      else if (pending.expired) { code = 'INPUT_EXPIRED'; result = 'expired'; }
      else if (pending.status !== 'open') { code = 'DECISION_CONFLICT'; result = 'already-answered'; }
      await tx.query('INSERT INTO decisions(request_id,task_id,principal_id,input_revision_id,outcome,response) VALUES($1,$2,$3,$4,$5,$6)',
        [request.requestId ?? '', taskId, ctx.principalId, request.inputRevisionId, result, JSON.stringify(request.response)]);
      await this.emit(tx, taskId, 'task.input-response', { requestId: request.requestId, outcome: result });
      if (code) return { error: new ApiError(code, `Response rejected: ${result}`, { outcome: result }) };
      await tx.query("UPDATE pending_inputs SET status='answered' WHERE request_id=$1", [request.requestId]);
      return { task: await this.revise(tx, task, ctx, { ...task.input, ...request.response }) };
    });
    if (outcome.error) throw outcome.error; return outcome.task!;
  }
  async cancel(ctx: AuthContext, taskId: string): Promise<any> {
    return this.store.transaction(async tx => {
      const task = await this.load(ctx, taskId, 'tasks.cancel', tx, true);
      if (terminalTask(task.phase)) return { ...task, cancelRequested: false };
      await tx.query('UPDATE tasks SET cancel_requested=true,revision=revision+1 WHERE task_id=$1', [taskId]);
      await this.emit(tx, taskId, 'task.cancel-requested', { principalId: ctx.principalId }); await this.wake(tx, taskId, 'cancel');
      return { ...task, cancelRequested: true };
    });
  }
  async runOnce(): Promise<void> {
    const candidates = (await this.store.pool.query(`SELECT task_id FROM tasks WHERE stage='admit' AND phase='admitted'
      UNION SELECT task_id FROM wakeups WHERE processed_at IS NULL`)).rows;
    for (const candidate of candidates) await this.store.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM tasks WHERE task_id=$1 FOR UPDATE SKIP LOCKED', [candidate.task_id])).rows[0];
      if (!row) return;
      requireCondition(this.baseFlows.has(row.flow_version)||[...this.capabilities.values()].some(capability=>capability.flowVersion===row.flow_version), 'UNSUPPORTED_VERSION', 'No runner for the pinned flow version');
      const missing = Array.isArray(row.input.requiredFields) ? row.input.requiredFields.filter((key: string) => !row.input[key]) : [];
      if (row.stage === 'admit' && row.phase === 'admitted') {
        if (missing.length) {
          const requestId = newId('pin');
          await tx.query(`INSERT INTO pending_inputs(request_id,task_id,input_revision_id,kind,question,expires_at)
            VALUES($1,$2,$3,'clarification',$4,clock_timestamp()+($5::double precision*interval '1 millisecond'))`,
            [requestId, row.task_id, row.input_revision_id, `Provide ${missing.join(', ')}`, this.inputTtlMs]);
          await tx.query("UPDATE tasks SET phase='waiting-input',stage='wait-input',revision=revision+1 WHERE task_id=$1", [row.task_id]);
          await this.emit(tx, row.task_id, 'task.waiting-input', { requestId, inputRevisionId: row.input_revision_id });
        } else {
          await tx.query("UPDATE tasks SET phase='running',stage='inspect',revision=revision+1 WHERE task_id=$1", [row.task_id]);
          await this.emit(tx, row.task_id, 'task.running', { inputRevisionId: row.input_revision_id, flowVersion: row.flow_version });
        }
      }
      await tx.query('UPDATE wakeups SET processed_at=clock_timestamp() WHERE task_id=$1 AND processed_at IS NULL', [row.task_id]);
    });
  }
}
