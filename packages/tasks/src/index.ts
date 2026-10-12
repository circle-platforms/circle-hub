import { ApiError, FLOW_VERSION, PACK_FLOWS, IDEMPOTENCY_WINDOW_MS, MINDMAP_PACK_VERSION, canonicalHash, newId, requireCondition, terminalTask,
  type AuthContext, type Event, type SubmitRequest, type Task, type TaskView } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import type { Auth } from './auth.ts';

export function taskFromRow(row: Record<string, any>): Task {
  return { taskId: row.task_id, tenantId: row.tenant_id, scopeId: row.scope_id, principalId: row.principal_id,
    title: row.title, phase: row.phase, inputRevisionId: row.input_revision_id, input: row.input,
    revision: row.revision, flowVersion: row.flow_version,
    ...(row.capability_pack_id ? { capabilityPackId: row.capability_pack_id, packVersion: row.pack_version } : {}) };
}
export class Tasks {
  store: Store; auth: Auth; inputTtlMs: number;
  constructor(store: Store, auth: Auth, inputTtlMs = 300_000) { this.store = store; this.auth = auth; this.inputTtlMs = inputTtlMs; }
  async internal(tx:Transaction,taskId:string):Promise<Task> {
    const row=(await tx.query('SELECT * FROM tasks WHERE task_id=$1',[taskId])).rows[0];
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
    return taskFromRow(row);
  }
  async emit(tx: Transaction, taskId: string, kind: string, payload: unknown): Promise<void> {
    // Serialize allocation through commit so after=seq cannot skip an uncommitted lower sequence.
    const seq = (await tx.query('UPDATE event_clock SET value=value+1 WHERE singleton RETURNING value')).rows[0].value;
    await tx.query('INSERT INTO outbox(seq,task_id,kind,payload) VALUES($1,$2,$3,$4)', [seq, taskId, kind, JSON.stringify(payload)]);
  }
  async wake(tx: Transaction, taskId: string, reason: string): Promise<void> {
    await tx.query('INSERT INTO wakeups(task_id,reason) VALUES($1,$2)', [taskId, reason]);
  }
  async submit(ctx: AuthContext, request: SubmitRequest, tx?: Transaction): Promise<Task & { deduplicated: boolean }> {
    const execute = async (client: Transaction) => {
      const policy = await this.auth.check(ctx, 'tasks.submit', request.scopeId, client);
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
        request.title, inputRevisionId, JSON.stringify(request.input), request.capabilityPackId ? PACK_FLOWS[request.capabilityPackId] : FLOW_VERSION, request.capabilityPackId ?? null,
        request.capabilityPackId ? MINDMAP_PACK_VERSION : null]);
      await client.query('INSERT INTO input_revisions(input_revision_id,task_id,input,principal_id) VALUES($1,$2,$3,$4)',
        [inputRevisionId, taskId, JSON.stringify(request.input), policy.principalId]);
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
  async list(ctx:AuthContext,limit:number):Promise<TaskView[]> {
    const policy=await this.auth.check(ctx,'tasks.read');
    const rows=(await this.store.pool.query(`SELECT task_id FROM tasks WHERE tenant_id=$1 AND scope_id=ANY($2::text[])
      AND (context->>'privateOwnerId' IS NULL OR context->>'privateOwnerId'=$3)
      ORDER BY created_at DESC,task_id DESC LIMIT $4`,[policy.tenantId,policy.scopes,policy.principalId,limit])).rows;
    return Promise.all(rows.map(row=>this.status(ctx,row.task_id)));
  }
  async status(ctx: AuthContext, taskId: string): Promise<TaskView> {
    const task = await this.load(ctx, taskId);
    const pending = (await this.store.pool.query('SELECT * FROM pending_inputs WHERE task_id=$1 ORDER BY created_at,request_id', [taskId])).rows;
    return { ...task, pendingInputs: pending.map(row => ({ requestId: row.request_id, inputRevisionId: row.input_revision_id,
      kind: row.kind, question: row.question, binding: row.binding, expiresAt: row.expires_at.toISOString(), status: row.status })) };
  }
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
  async deliver(tx: Transaction, task: Task, result: any): Promise<void> {
    requireCondition(result.verification && result.artifacts.length === 1 && result.evidence.some((item: any) => item.kind === 'script-conclusion'),
      'EVIDENCE_INSUFFICIENT', 'Delivery requires independent fact verification');
    requireCondition(result.verification.artifactSha256 === result.artifacts[0].sha256 && result.verification.sourceSha256 === task.input.sourceSha256,
      'EVIDENCE_INSUFFICIENT', 'Delivery is not bound to the pinned input and artifact bytes');
    await tx.query(`INSERT INTO checklist_items(task_id,input_revision_id,item_id,requires_fact,satisfied,conclusion_id)
      VALUES($1,$2,'independent-workbook-readback',true,true,$3) ON CONFLICT DO NOTHING`,
      [task.taskId, task.inputRevisionId, result.evidence.find((item: any) => item.kind === 'script-conclusion').evidenceId]);
    await tx.query('UPDATE tasks SET result=$2,result_status=$3 WHERE task_id=$1', [task.taskId, JSON.stringify(result), result.status]);
    await this.stage(tx, task, 'under-review', 'review', 'task.verifying');
    await this.stage(tx, task, 'delivered', 'done', 'task.delivered', { status: result.status, artifacts: result.artifacts, unmapped: result.unmapped });
  }
  async fail(tx: Transaction, task: Task, error: unknown, evidence: unknown[] = []): Promise<void> {
    await tx.query(`UPDATE tasks SET result_status='failed',result=$2 WHERE task_id=$1`,
      [task.taskId, JSON.stringify({ error, artifacts: [], evidence, unmapped: [] })]);
    await this.stage(tx, task, 'failed', 'done', 'task.failed', { error });
  }
  async events(ctx: AuthContext, taskId: string, after: number): Promise<Event[]> {
    await this.load(ctx, taskId);
    const rows = (await this.store.pool.query('SELECT * FROM outbox WHERE task_id=$1 AND seq>$2 ORDER BY seq LIMIT 500', [taskId, after])).rows;
    return rows.map(row => ({ seq: Number(row.seq), taskId: row.task_id, kind: row.kind, payload: row.payload, createdAt: row.created_at.toISOString() }));
  }
  async revise(tx: Transaction, task: Task, ctx: AuthContext, input: Record<string, unknown>): Promise<Task> {
    requireCondition(!terminalTask(task.phase) && task.phase !== 'unknown', 'DECISION_CONFLICT', 'Task revision is frozen in this phase');
    const revision = newId('inrev');
    await tx.query(`UPDATE tasks SET input_revision_id=$2,input=$3,phase='admitted',stage='admit',result=NULL,result_status=NULL,
      context=jsonb_build_object('delegatedOwnerId',context->'delegatedOwnerId'),revision=revision+1,updated_at=clock_timestamp()
      WHERE task_id=$1`, [task.taskId, revision, JSON.stringify(input)]);
    await tx.query('INSERT INTO input_revisions(input_revision_id,task_id,input,principal_id) VALUES($1,$2,$3,$4)',
      [revision, task.taskId, JSON.stringify(input), ctx.principalId]);
    await tx.query("UPDATE pending_inputs SET status='superseded' WHERE task_id=$1 AND status='open'", [task.taskId]);
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
      requireCondition([FLOW_VERSION,...Object.values(PACK_FLOWS)].includes(row.flow_version), 'UNSUPPORTED_VERSION', 'No runner for the pinned flow version');
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
