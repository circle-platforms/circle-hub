import { HEARTBEAT_MS,LEASE_TTL_MS, requireCondition, type AuthContext } from '../../contracts/src/index.ts';
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
  customClaimers=new Map<string,(ctx:AuthContext)=>Promise<any>>();
  customPreflights=new Map<string,(ctx:AuthContext,id:string,fence:number,tx:Transaction)=>Promise<any>>();
  async claim(ctx:AuthContext,exclude:string[]=[]):Promise<any>{for(const [name,claim] of this.customClaimers)if(!exclude.includes(name)){const accepted=await claim(ctx);if(accepted)return accepted;}return null;}
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
  async preflight(ctx:AuthContext,id:string,fence:number,tx?:Transaction):Promise<any>{const check=async(client:Transaction)=>{const row=await this.lease(ctx,id,fence,client),handler=this.customPreflights.get(row.name);requireCondition(handler,"FORBIDDEN_ACTION","Execution preflight is not registered");return handler(ctx,id,fence,client);};return tx?check(tx):this.store.transaction(check);}
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
    await this.tasks.emit(tx,row.task_id,`operation.${status}`,{operationId:row.operation_id,
      ...(row.worker_id?{workerId:row.worker_id,fencingToken:Number(row.fencing_token)}:{executionStarted:false})});
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
