import {HEARTBEAT_MS,LEASE_TTL_MS,newId,requireCondition,type AuthContext,type Task} from "../../../packages/contracts/src/index.ts";
import {MINDMAP_PACK_VERSION} from "../contracts.ts";
import type {Transaction} from "../../../packages/storage/src/index.ts";
import {Execution} from "../../../packages/execution/src/index.ts";
export class CompilerExecution extends Execution {
  requiredWorkerCapabilities=new Set(['mindmaps.compile']);
  async enqueue(tx: Transaction, task: Task): Promise<string> {
    requireCondition(task.packVersion === MINDMAP_PACK_VERSION, 'UNSUPPORTED_VERSION', 'No worker for the pinned capability version');
    const ctx = { principalId: task.principalId, tenantId: task.tenantId, kind: 'user' } as const;
    await this.auth.check(ctx, 'methods.use', task.scopeId, tx);
    await this.knowledge.source(ctx, String(task.input.sourceRevisionId), task.scopeId, tx);
    const operationId = newId('op'); const resourceId = `compile:${task.taskId}:${task.inputRevisionId}`;
    await tx.query('INSERT INTO resources(tenant_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [task.tenantId,resourceId]);
    const row = (await tx.query(`INSERT INTO operations(operation_id,tenant_id,scope_id,task_id,input_revision_id,principal_id,name,resource_id,source_revision_id,status,deadline_at,required_worker_capability)
      VALUES($1,$2,$3,$4,$5,$6,'mindmaps.compile',$7,$8,'accepted',clock_timestamp()+interval '15 minutes','mindmaps.compile')
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
      if (worker.draining||!Array.isArray(worker.capabilities)||!worker.capabilities.includes('mindmaps.compile')) return null;
      const row = (await tx.query(`SELECT * FROM operations WHERE name='mindmaps.compile' AND status='accepted' AND tenant_id=$1 AND scope_id=ANY($2::text[])
        AND deadline_at>clock_timestamp() AND task_id IN (SELECT task_id FROM tasks WHERE capability_pack_id='mindmap-compile' AND pack_version=$3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [policy.tenantId,policy.scopes,MINDMAP_PACK_VERSION])).rows[0];
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
  async preflight(ctx: AuthContext, operationId: string, fence: number, tx?: Transaction): Promise<any> {
    const check = async (client: Transaction) => {
      const row = await this.lease(ctx,operationId,fence,client);
      await this.workerCapability(ctx,row,client);
      const actor = { principalId: row.principal_id, tenantId: row.tenant_id, kind: 'user' } as const;
      const task = await this.tasks.load(actor,row.task_id,'methods.use',client);
      requireCondition(task.packVersion===MINDMAP_PACK_VERSION,'UNSUPPORTED_VERSION','No compiler for the pinned capability version');
      requireCondition(task.inputRevisionId === row.input_revision_id, 'INPUT_REVISION_STALE', 'Input changed after dispatch');
      const cancel = (await client.query('SELECT cancel_requested FROM tasks WHERE task_id=$1', [row.task_id])).rows[0].cancel_requested;
      requireCondition(!cancel,'DECISION_CONFLICT','Task cancellation is pending; no new compilation effect is authorized');
      const source = await this.knowledge.source(actor,row.source_revision_id,row.scope_id,client);
      requireCondition(source.sha256 === task.input.sourceSha256,'SOURCE_HASH_MISMATCH','Pinned source binding changed');
      return { row,task,source };
    };
    return tx ? check(tx) : this.store.transaction(check);
  }
}
