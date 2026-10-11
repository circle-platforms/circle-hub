import { HEARTBEAT_MS, LEASE_TTL_MS, MINDMAP_PACK_VERSION, newId, requireCondition, type AuthContext, type Task } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import type { Auth } from '../../tasks/src/auth.ts';
import type { Tasks } from '../../tasks/src/index.ts';
import type { Knowledge } from '../../knowledge/src/index.ts';

export class Execution {
  store: Store; auth: Auth; tasks: Tasks; knowledge: Knowledge;
  constructor(store: Store, auth: Auth, tasks: Tasks, knowledge: Knowledge) { this.store = store; this.auth = auth; this.tasks = tasks; this.knowledge = knowledge; }
  async register(ctx: AuthContext): Promise<any> {
    const policy = await this.auth.check(ctx, 'workers.execute');
    requireCondition(policy.kind === 'worker' && policy.workerId, 'FORBIDDEN_ACTION', 'Authenticated worker identity required');
    await this.store.pool.query(`INSERT INTO workers(worker_id,principal_id,tenant_id) VALUES($1,$2,$3)
      ON CONFLICT(worker_id) DO UPDATE SET last_seen=clock_timestamp()`, [policy.workerId, policy.principalId, policy.tenantId]);
    return { workerId: policy.workerId, leaseTtlMs: LEASE_TTL_MS, heartbeatMs: HEARTBEAT_MS };
  }
  async enqueue(tx: Transaction, task: Task): Promise<string> {
    requireCondition(task.packVersion === MINDMAP_PACK_VERSION, 'UNSUPPORTED_VERSION', 'No worker for the pinned capability version');
    const ctx = { principalId: task.principalId, tenantId: task.tenantId, kind: 'user' } as const;
    await this.auth.check(ctx, 'methods.use', task.scopeId, tx);
    await this.knowledge.source(ctx, String(task.input.sourceRevisionId), task.scopeId, tx);
    const operationId = newId('op'); const resourceId = `compile:${task.taskId}:${task.inputRevisionId}`;
    await tx.query('INSERT INTO resources(tenant_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [task.tenantId,resourceId]);
    const row = (await tx.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,source_revision_id,status,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,'mindmaps.compile',$7,$8,'accepted',clock_timestamp()+interval '15 minutes')
      ON CONFLICT(task_id,input_revision_id,name) WHERE name='mindmaps.compile' DO UPDATE SET name=EXCLUDED.name RETURNING operation_id`,
      [operationId,task.tenantId,task.scopeId,task.taskId,task.inputRevisionId,task.principalId,resourceId,task.input.sourceRevisionId])).rows[0];
    await this.tasks.emit(tx, task.taskId, 'operation.accepted', { operationId: row.operation_id, name: 'mindmaps.compile', inputRevisionId: task.inputRevisionId });
    return row.operation_id;
  }
  async claim(ctx: AuthContext): Promise<any> {
    return this.store.transaction(async tx => {
      const policy = await this.auth.check(ctx, 'workers.execute', undefined, tx);
      requireCondition(policy.kind === 'worker' && policy.workerId, 'FORBIDDEN_ACTION', 'Authenticated worker required');
      const worker = (await tx.query('UPDATE workers SET last_seen=clock_timestamp() WHERE worker_id=$1 AND principal_id=$2 RETURNING *', [policy.workerId,policy.principalId])).rows[0];
      requireCondition(worker, 'FORBIDDEN_ACTION', 'Register the worker first');
      if (worker.draining) return null;
      const row = (await tx.query(`SELECT * FROM operations WHERE name='mindmaps.compile' AND status='accepted' AND tenant_id=$1 AND scope_id=ANY($2::text[])
        AND deadline_at>clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [policy.tenantId,policy.scopes])).rows[0];
      if (!row) return null;
      const task = await this.tasks.load({ principalId: row.principal_id, tenantId: row.tenant_id, kind: 'user' }, row.task_id, 'methods.use', tx);
      requireCondition(task.inputRevisionId === row.input_revision_id, 'INPUT_REVISION_STALE', 'Operation input was superseded');
      const resource = (await tx.query('SELECT * FROM resources WHERE tenant_id=$1 AND resource_id=$2 FOR UPDATE', [row.tenant_id,row.resource_id])).rows[0];
      requireCondition(!resource.frozen, 'RESOURCE_BUSY', 'Resource has an unknown unreconciled operation');
      const active = (await tx.query('SELECT 1 FROM leases WHERE tenant_id=$1 AND resource_id=$2 AND expires_at>clock_timestamp()', [row.tenant_id,row.resource_id])).rowCount;
      requireCondition(!active, 'RESOURCE_BUSY', 'Resource lease is held');
      const token = Number((await tx.query('UPDATE resources SET next_fencing=next_fencing+1 WHERE tenant_id=$1 AND resource_id=$2 RETURNING next_fencing', [row.tenant_id,row.resource_id])).rows[0].next_fencing);
      await tx.query(`INSERT INTO leases(tenant_id,resource_id,operation_id,worker_id,fencing_token,expires_at)
        VALUES($1,$2,$3,$4,$5,LEAST(clock_timestamp()+interval '60 seconds',$6)) ON CONFLICT(tenant_id,resource_id)
        DO UPDATE SET operation_id=EXCLUDED.operation_id,worker_id=EXCLUDED.worker_id,fencing_token=EXCLUDED.fencing_token,expires_at=EXCLUDED.expires_at`,
        [row.tenant_id,row.resource_id,row.operation_id,policy.workerId,token,row.deadline_at]);
      await tx.query("UPDATE operations SET status='running',worker_id=$2,fencing_token=$3,updated_at=clock_timestamp() WHERE operation_id=$1", [row.operation_id,policy.workerId,token]);
      await this.tasks.emit(tx,row.task_id,'operation.running',{ operationId: row.operation_id,workerId: policy.workerId,fencingToken: token });
      const source = await this.knowledge.source({ principalId: row.principal_id, tenantId: row.tenant_id, kind: 'user' }, row.source_revision_id, row.scope_id, tx);
      return { operationId: row.operation_id,taskId: row.task_id,inputRevisionId: row.input_revision_id,name: row.name,
        fencingToken: token, source, leaseTtlMs: LEASE_TTL_MS,heartbeatMs: HEARTBEAT_MS };
    });
  }
  async lease(ctx: AuthContext, operationId: string, fencingToken: number, tx: Transaction, allowCompleted = false): Promise<any> {
    const policy = await this.auth.check(ctx,'workers.execute',undefined,tx);
    requireCondition(policy.kind === 'worker', 'FORBIDDEN_ACTION', 'Worker identity required');
    const row = (await tx.query('SELECT * FROM operations WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
    requireCondition(row, 'TARGET_NOT_FOUND', 'Operation not found');
    requireCondition(row.tenant_id === policy.tenantId && policy.scopes.includes(row.scope_id), 'FORBIDDEN_SCOPE', 'Operation is outside worker scope');
    requireCondition(row.worker_id === policy.workerId && Number(row.fencing_token) === fencingToken, 'FENCING_STALE', 'Worker or fence is stale');
    if (allowCompleted && ['succeeded','failed'].includes(row.status)) return row;
    requireCondition(row.status === 'running', 'FENCING_STALE', 'Operation is no longer held by this worker');
    const lease = (await tx.query(`SELECT * FROM leases WHERE tenant_id=$1 AND resource_id=$2 AND operation_id=$3
      AND worker_id=$4 AND fencing_token=$5 AND expires_at>clock_timestamp()`, [row.tenant_id,row.resource_id,operationId,policy.workerId,fencingToken])).rows[0];
    requireCondition(lease, 'LEASE_EXPIRED', 'Execution lease has expired');
    return row;
  }
  async preflight(ctx: AuthContext, operationId: string, fence: number, tx?: Transaction): Promise<any> {
    const check = async (client: Transaction) => {
      const row = await this.lease(ctx,operationId,fence,client);
      const actor = { principalId: row.principal_id, tenantId: row.tenant_id, kind: 'user' } as const;
      const task = await this.tasks.load(actor,row.task_id,'methods.use',client);
      requireCondition(task.inputRevisionId === row.input_revision_id, 'INPUT_REVISION_STALE', 'Input changed after dispatch');
      const cancel = (await client.query('SELECT cancel_requested FROM tasks WHERE task_id=$1', [row.task_id])).rows[0].cancel_requested;
      requireCondition(!cancel,'DECISION_CONFLICT','Task cancellation is pending; no new compilation effect is authorized');
      const source = await this.knowledge.source(actor,row.source_revision_id,row.scope_id,client);
      requireCondition(source.sha256 === task.input.sourceSha256,'SOURCE_HASH_MISMATCH','Pinned source binding changed');
      return { row,task,source };
    };
    return tx ? check(tx) : this.store.transaction(check);
  }
  async heartbeat(ctx: AuthContext, id: string, fence: number): Promise<any> {
    return this.store.transaction(async tx => {
      const { row } = await this.preflight(ctx,id,fence,tx);
      await tx.query(`UPDATE leases SET expires_at=LEAST(clock_timestamp()+interval '60 seconds',$3)
        WHERE tenant_id=$1 AND resource_id=$2`, [row.tenant_id,row.resource_id,row.deadline_at]);
      await tx.query('UPDATE workers SET last_seen=clock_timestamp() WHERE worker_id=$1', [ctx.workerId]);
      return { leaseTtlMs: LEASE_TTL_MS };
    });
  }
  async complete(tx: Transaction, row: any, status: 'succeeded' | 'failed', receipt: unknown): Promise<void> {
    await tx.query('UPDATE operations SET status=$2,result=$3,updated_at=clock_timestamp() WHERE operation_id=$1', [row.operation_id,status,JSON.stringify(receipt)]);
    await tx.query('DELETE FROM leases WHERE operation_id=$1', [row.operation_id]);
    await this.tasks.emit(tx,row.task_id,`operation.${status}`,{ operationId: row.operation_id,workerId: row.worker_id,fencingToken: Number(row.fencing_token) });
    await this.tasks.wake(tx,row.task_id,'worker-receipt');
  }
  async expire(): Promise<void> {
    const expired = (await this.store.pool.query(`SELECT o.operation_id FROM operations o LEFT JOIN leases l USING(operation_id)
      WHERE o.status='running' AND (l.expires_at<=clock_timestamp() OR l.operation_id IS NULL)`)).rows;
    for (const item of expired) await this.store.transaction(async tx => {
      const row = (await tx.query(`SELECT o.* FROM operations o LEFT JOIN leases l USING(operation_id) WHERE o.operation_id=$1
        AND o.status='running' AND (l.expires_at<=clock_timestamp() OR l.operation_id IS NULL) FOR UPDATE OF o`, [item.operation_id])).rows[0];
      if (!row) return;
      await tx.query("UPDATE operations SET status='unknown',updated_at=clock_timestamp() WHERE operation_id=$1", [row.operation_id]);
      await tx.query('UPDATE resources SET frozen=true WHERE tenant_id=$1 AND resource_id=$2', [row.tenant_id,row.resource_id]);
      // Lost authority prevents new execution, but must not prevent expiry bookkeeping.
      const task = await this.tasks.internal(tx,row.task_id);
      const payload = { operationId:row.operation_id,inputRevisionId:row.input_revision_id,reason:'lease-expired',remoteStoppingVerified:false };
      if (task.inputRevisionId === row.input_revision_id && !['delivered','failed','cancelled'].includes(task.phase)) {
        await this.tasks.stage(tx,task,'unknown','reconcile','operation.unknown',payload);
      } else { await this.tasks.emit(tx,row.task_id,'operation.unknown',payload); }
    });
  }
}
