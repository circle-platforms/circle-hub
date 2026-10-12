import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError, requireCondition, sha256, type AuthContext, type Policy,type RunConstraint } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';

const DevelopmentIdentity = z.object({ username: z.string().min(1), password: z.string().min(8),
  principalId: z.string().regex(/^prn_/), tenantId: z.string().regex(/^tnt_/),
  kind: z.enum(['user','service','worker']), workerId: z.string().optional(), scopes: z.array(z.string().regex(/^scp_/)),
  grants: z.array(z.string()), targets: z.array(z.string()), defects: z.array(z.string()) });
interface Credential { principalId: string; salt: Buffer; digest: Buffer }
export const DEFAULT_DEV_TOKEN_TTL_MS=8*60*60*1000;
export const MAX_DEV_TOKEN_TTL_MS=24*60*60*1000;
export class Auth {
  store: Store;
  credentials = new Map<string, Credential>();
  developmentTtlMs:number;runTokenTtlMs:number;
  constructor(store: Store,options:{developmentTtlMs?:number;runTokenTtlMs?:number}={}) { this.store = store;this.developmentTtlMs=options.developmentTtlMs??DEFAULT_DEV_TOKEN_TTL_MS;this.runTokenTtlMs=options.runTokenTtlMs??300_000;
    requireCondition(Number.isInteger(this.developmentTtlMs)&&this.developmentTtlMs>=1000&&this.developmentTtlMs<=MAX_DEV_TOKEN_TTL_MS&&Number.isInteger(this.runTokenTtlMs)&&this.runTokenTtlMs>=1000&&this.runTokenTtlMs<=300_000,'INVALID_PAYLOAD','Development token lifetime configuration is invalid');
  }
  async initializeDevelopment(path: string): Promise<void> {
    const input = z.object({ identities: z.array(DevelopmentIdentity) }).parse(JSON.parse(await readFile(path, 'utf8')));
    await this.store.transaction(async tx => {
      for (const identity of input.identities) {
        requireCondition(!this.credentials.has(identity.username), 'INVALID_PAYLOAD', 'Duplicate development username');
        const salt = randomBytes(16);
        this.credentials.set(identity.username, { principalId: identity.principalId, salt, digest: scryptSync(identity.password, salt, 32) });
        await tx.query(`INSERT INTO policies(principal_id,tenant_id,kind,worker_id,scopes,grants,targets,defects)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(principal_id) DO NOTHING`,
          [identity.principalId, identity.tenantId, identity.kind, identity.workerId ?? null,
            JSON.stringify(identity.scopes), JSON.stringify(identity.grants), JSON.stringify(identity.targets), JSON.stringify(identity.defects)]);
      }
    });
  }
  async issue(username: string, password: string, ttlMs = this.developmentTtlMs): Promise<{ token: string; expiresAt: string }> {
    const credential = this.credentials.get(username);
    const salt = credential?.salt ?? Buffer.alloc(16); const actual = scryptSync(password, salt, 32);
    requireCondition(credential && timingSafeEqual(actual, credential.digest), 'UNAUTHENTICATED', 'Invalid development credentials');
    const policy = await this.policy({ principalId: credential.principalId } as AuthContext);
    const token = randomBytes(32).toString('base64url');
    const result = await this.store.pool.query(`INSERT INTO auth_tokens(digest,principal_id,expires_at)
      VALUES($1,$2,clock_timestamp()+($3::double precision*interval '1 millisecond')) RETURNING expires_at`,
      [sha256(token), policy.principalId, Math.min(ttlMs, MAX_DEV_TOKEN_TTL_MS)]);
    return { token, expiresAt: result.rows[0].expires_at.toISOString() };
  }
  async refresh(header:string):Promise<{token:string;expiresAt:string}>{
    const ctx=await this.authenticate(header);requireCondition(!ctx.run,'FORBIDDEN_ACTION','Run delegation cannot refresh a development session');
    const row=(await this.store.pool.query(`UPDATE auth_tokens a SET expires_at=GREATEST(a.expires_at,clock_timestamp()+($2::double precision*interval '1 millisecond'))
      FROM policies p WHERE a.digest=$1 AND a.principal_id=p.principal_id AND a.constraints IS NULL AND a.expires_at>clock_timestamp() AND NOT p.disabled RETURNING a.expires_at`,[sha256(header.slice(7)),this.developmentTtlMs])).rows[0];
    requireCondition(row,'UNAUTHENTICATED','Token is invalid or expired');return {token:header.slice(7),expiresAt:row.expires_at.toISOString()};
  }
  async authenticate(header?: string): Promise<AuthContext> {
    requireCondition(typeof header === 'string' && header.startsWith('Bearer '), 'UNAUTHENTICATED', 'Bearer token required');
    const result = await this.store.pool.query(`SELECT p.*,a.constraints,a.digest FROM auth_tokens a JOIN policies p USING(principal_id)
      WHERE a.digest=$1 AND a.expires_at>clock_timestamp() AND NOT p.disabled`, [sha256(header.slice(7))]);
    const row = result.rows[0]; requireCondition(row, 'UNAUTHENTICATED', 'Token is invalid or expired');
    if(row.constraints){const task=(await this.store.pool.query('SELECT phase,cancel_requested FROM tasks WHERE task_id=$1',[row.constraints.taskId])).rows[0];requireCondition(task&&!task.cancel_requested&&!['failed','delivered','cancelled','unknown'].includes(task.phase),'UNAUTHENTICATED','Run token no longer authorizes new work');
      if(row.constraints.operationId){const live=(await this.store.pool.query(`SELECT 1 FROM operations o JOIN leases l USING(operation_id) JOIN tasks t USING(task_id)
        WHERE o.operation_id=$1 AND o.task_id=$2 AND o.fencing_token=$3 AND l.fencing_token=o.fencing_token AND l.worker_id=o.worker_id
        AND o.principal_id=$4 AND o.status='running' AND o.deadline_at>clock_timestamp() AND l.expires_at>clock_timestamp() AND o.input_revision_id=t.input_revision_id`,[row.constraints.operationId,row.constraints.taskId,row.constraints.fencingToken,row.principal_id])).rowCount;requireCondition(live,'UNAUTHENTICATED','Run execution lease no longer authorizes new work');}
    }
    return { principalId: row.principal_id, tenantId: row.tenant_id, kind: row.kind, ...(row.worker_id ? { workerId: row.worker_id } : {}),...(row.constraints?{run:row.constraints,tokenDigest:row.digest}:{}) };
  }
  async policy(ctx: AuthContext, tx?: Transaction): Promise<Policy> {
    const row = (await (tx ?? this.store.pool).query('SELECT * FROM policies WHERE principal_id=$1 AND NOT disabled', [ctx.principalId])).rows[0];
    requireCondition(row, 'UNAUTHENTICATED', 'Principal is disabled or absent');
    return { principalId: row.principal_id, tenantId: row.tenant_id, kind: row.kind, workerId: row.worker_id ?? undefined,
      scopes:ctx.run?row.scopes.filter((scope:string)=>ctx.run!.scopes.includes(scope)):row.scopes,
      grants:ctx.run?row.grants.filter((grant:string)=>ctx.run!.grants.includes(grant)):row.grants,targets: row.targets, defects: row.defects,...(ctx.run?{run:ctx.run}:{}),...(ctx.tokenDigest?{tokenDigest:ctx.tokenDigest}:{}) };
  }
  async issueRun(ctx:AuthContext,constraints:RunConstraint,deadline?:Date):Promise<{token:string;digest:string}>{
    const policy=await this.policy(ctx);requireCondition(constraints.scopes.every(scope=>policy.scopes.includes(scope))&&constraints.grants.every(grant=>policy.grants.includes(grant)),'FORBIDDEN_ACTION','Run delegation exceeds its owner');
    const token=randomBytes(32).toString('base64url'),digest=sha256(token);
    await this.store.pool.query("INSERT INTO auth_tokens(digest,principal_id,expires_at,constraints) VALUES($1,$2,LEAST(clock_timestamp()+($4::double precision*interval '1 millisecond'),COALESCE($5::timestamptz,'infinity'::timestamptz)),$3)",[digest,policy.principalId,JSON.stringify(constraints),this.runTokenTtlMs,deadline??null]);return {token,digest};
  }
  async renewRun(tx:Transaction,operation:any):Promise<void>{
    await tx.query(`UPDATE auth_tokens SET expires_at=LEAST(clock_timestamp()+($5::double precision*interval '1 millisecond'),$6)
      WHERE principal_id=$1 AND constraints->>'taskId'=$2 AND constraints->>'operationId'=$3 AND constraints->>'fencingToken'=$4 AND expires_at>clock_timestamp()`,[operation.principal_id,operation.task_id,operation.operation_id,String(operation.fencing_token),this.runTokenTtlMs,operation.deadline_at]);
  }
  async revokeRun(digest:string):Promise<void>{await this.store.pool.query('UPDATE auth_tokens SET expires_at=clock_timestamp() WHERE digest=$1 AND constraints IS NOT NULL',[digest]);}
  async check(ctx: AuthContext, grant: string, scopeId?: string, tx?: Transaction): Promise<Policy> {
    const policy = await this.policy(ctx, tx);
    requireCondition(!scopeId || policy.scopes.includes(scopeId), 'FORBIDDEN_SCOPE', 'Scope is outside the authenticated principal policy');
    requireCondition(policy.grants.includes(grant), 'FORBIDDEN_ACTION', `Permission ${grant} is required`);
    return policy;
  }
  async target(ctx: AuthContext, grant: string, scopeId: string, target: string, tx?: Transaction): Promise<Policy> {
    const policy = await this.check(ctx, grant, scopeId, tx);
    requireCondition(policy.targets.includes(target), 'FORBIDDEN_TARGET', 'Target is outside the authenticated policy'); return policy;
  }
  async intersectService(serviceId: string, ownerId: string, tx?: Transaction): Promise<Policy> {
    const service = await this.policy({ principalId: serviceId } as AuthContext, tx);
    const owner = await this.policy({ principalId: ownerId } as AuthContext, tx);
    requireCondition(service.kind === 'service' && service.tenantId === owner.tenantId, 'FORBIDDEN_ACTION', 'Rule requires a same-tenant service identity');
    return { ...service, scopes: service.scopes.filter(value => owner.scopes.includes(value)),
      targets: service.targets.filter(value => owner.targets.includes(value)), defects: service.defects.filter(value => owner.defects.includes(value)),
      grants: service.grants.filter(value => owner.grants.includes(value)) };
  }
  async audit(ctx: AuthContext, action: string, detail: unknown, scopeId?: string, tx?: Transaction): Promise<void> {
    await (tx ?? this.store.pool).query('INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail) VALUES($1,$2,$3,$4,$5)',
      [ctx.tenantId, scopeId ?? null, ctx.principalId, action, JSON.stringify(detail)]);
  }
}
