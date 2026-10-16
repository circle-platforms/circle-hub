import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError, requireCondition, sha256, type AuthContext, type Policy,type RunConstraint } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import {passwordDigest} from './password.ts';
import {ScopeRoles,ScopeRole,rolePresets,type ScopeRole as RoleName} from './roles.ts';

const DevelopmentIdentity = z.object({ username: z.string().min(1), password: z.string().min(8),
  principalId: z.string().regex(/^prn_/), tenantId: z.string().regex(/^tnt_/),
  kind: z.enum(['user','service','worker']), workerId: z.string().optional(), scopes: z.array(z.string().regex(/^scp_/)),
  grants: z.array(z.string()).default([]), targets: z.array(z.string()).default([]), defects: z.array(z.string()).default([]),roles:z.array(z.object({scopeId:z.string().regex(/^scp_/),role:ScopeRole}).strict()).optional() }).refine(value=>value.kind==='user'||!value.roles?.length,'Machine identities use scopes without roles');
interface Credential { principalId: string; salt: Buffer; digest: Buffer }
export const DEFAULT_DEV_TOKEN_TTL_MS=8*60*60*1000;
export const MAX_DEV_TOKEN_TTL_MS=24*60*60*1000;
export class Auth {
  store: Store;
  credentials = new Map<string, Credential>();
  developmentTtlMs:number;runTokenTtlMs:number;
  attempts=new Map<string,{count:number;start:number;lockedUntil:number}>();activeHashes=0;
  roles:ScopeRoles;
  constructor(store: Store,options:{developmentTtlMs?:number;runTokenTtlMs?:number}={}) { this.store = store;this.developmentTtlMs=options.developmentTtlMs??DEFAULT_DEV_TOKEN_TTL_MS;this.runTokenTtlMs=options.runTokenTtlMs??300_000;
    this.roles=new ScopeRoles(store);requireCondition(Number.isInteger(this.developmentTtlMs)&&this.developmentTtlMs>=1000&&this.developmentTtlMs<=MAX_DEV_TOKEN_TTL_MS&&Number.isInteger(this.runTokenTtlMs)&&this.runTokenTtlMs>=1000&&this.runTokenTtlMs<=300_000,'INVALID_PAYLOAD','Development token lifetime configuration is invalid');
  }
  async initializeDevelopment(path: string): Promise<void> {
    const input = z.object({ identities: z.array(DevelopmentIdentity) }).parse(JSON.parse(await readFile(path, 'utf8')));
    await this.store.transaction(async tx => {
      await this.roles.bootstrap(tx);
      for (const identity of input.identities) {
        requireCondition(!this.credentials.has(identity.username), 'INVALID_PAYLOAD', 'Duplicate development username');
        const salt = randomBytes(16);
        this.credentials.set(identity.username, { principalId: identity.principalId, salt, digest: await passwordDigest(identity.password, salt) });
        const row=(await tx.query(`INSERT INTO policies(principal_id,tenant_id,kind,worker_id,scopes,grants,targets,defects,username)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(principal_id) DO UPDATE SET username=EXCLUDED.username,disabled=false,targets=EXCLUDED.targets,defects=EXCLUDED.defects,scopes=CASE WHEN policies.kind='user' THEN policies.scopes ELSE EXCLUDED.scopes END,grants=CASE WHEN policies.kind='user' THEN policies.grants ELSE EXCLUDED.grants END RETURNING *`,
          [identity.principalId, identity.tenantId, identity.kind, identity.workerId ?? null,
            JSON.stringify(identity.scopes), JSON.stringify(identity.grants), JSON.stringify(identity.targets), JSON.stringify(identity.defects),identity.username])).rows[0];
        requireCondition(row.tenant_id===identity.tenantId&&row.kind===identity.kind,'INVALID_PAYLOAD','Development identity cannot change its tenant or kind');await this.roles.seed(tx,row,identity.roles);await tx.query("UPDATE policies SET identity_source='development' WHERE principal_id=$1",[identity.principalId]);
      }
      await tx.query("UPDATE policies SET disabled=true WHERE identity_source='development' AND principal_id<>ALL($1::text[])",[input.identities.map(identity=>identity.principalId)]);
    });
  }
  async issue(username: string, password: string, ttlMs = this.developmentTtlMs): Promise<{ token: string; expiresAt: string }> {
    const credential = this.credentials.get(username);
    for(const [key,attempt]of this.attempts)if(Date.now()-attempt.start>60000&&attempt.lockedUntil<=Date.now())this.attempts.delete(key);requireCondition(this.attempts.has(username)||this.attempts.size<1000,'RATE_LIMITED','Authentication account capacity is exhausted');
    const entry=this.attempts.get(username)??{count:0,start:Date.now(),lockedUntil:0};if(Date.now()-entry.start>60000&&entry.lockedUntil<=Date.now()){entry.count=0;entry.start=Date.now();}this.attempts.set(username,entry);requireCondition(entry.lockedUntil<=Date.now()&&this.activeHashes<8,'RATE_LIMITED','Development authentication is temporarily rate limited');this.activeHashes++;let actual:Buffer;try{actual=await passwordDigest(password,credential?.salt??Buffer.alloc(16));}finally{this.activeHashes--;}if(!credential||!timingSafeEqual(actual,credential.digest)){entry.count++;if(entry.count>=5)entry.lockedUntil=Date.now()+60000;}else entry.count=0;const salt=credential?.salt;
    requireCondition(credential && timingSafeEqual(actual, credential.digest), 'UNAUTHENTICATED', 'Invalid development credentials');
    const policy = await this.policy({ principalId: credential.principalId } as AuthContext);
    const token = randomBytes(32).toString('base64url');
    const result = await this.store.pool.query(`INSERT INTO auth_tokens(digest,principal_id,expires_at,family_id,absolute_expires_at)
      VALUES($1,$2,clock_timestamp()+($3::double precision*interval '1 millisecond'),$1,clock_timestamp()+interval '24 hours') RETURNING expires_at`,
      [sha256(token), policy.principalId, Math.min(ttlMs, MAX_DEV_TOKEN_TTL_MS)]);
    return { token, expiresAt: result.rows[0].expires_at.toISOString() };
  }
  async issueForPrincipal(principalId:string,ttlMs=this.developmentTtlMs):Promise<{token:string;expiresAt:string}>{
    const policy=await this.policy({principalId} as AuthContext);requireCondition(policy.kind==='user','UNAUTHENTICATED','OIDC subject is not provisioned');
    const token=randomBytes(32).toString('base64url');
    const result=await this.store.pool.query(`INSERT INTO auth_tokens(digest,principal_id,expires_at,family_id,absolute_expires_at)
      VALUES($1,$2,clock_timestamp()+($3::double precision*interval '1 millisecond'),$1,clock_timestamp()+interval '24 hours') RETURNING expires_at`,
      [sha256(token),policy.principalId,Math.min(ttlMs,MAX_DEV_TOKEN_TTL_MS)]);
    return {token,expiresAt:result.rows[0].expires_at.toISOString()};
  }
  async refresh(header:string):Promise<{token:string;expiresAt:string}>{
    const ctx=await this.authenticate(header);requireCondition(!ctx.run,'FORBIDDEN_ACTION','Run delegation cannot refresh a development session');
    const token=randomBytes(32).toString('base64url');return this.store.transaction(async tx=>{const prior=(await tx.query('SELECT * FROM auth_tokens WHERE digest=$1 AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp() FOR UPDATE',[sha256(header.slice(7))])).rows[0];requireCondition(prior,'UNAUTHENTICATED','Development session reached its absolute lifetime');const row=(await tx.query("INSERT INTO auth_tokens(digest,principal_id,expires_at,family_id,absolute_expires_at) VALUES($1,$2,LEAST(clock_timestamp()+($3::double precision*interval '1 millisecond'),$4),$5,$4) RETURNING expires_at",[sha256(token),prior.principal_id,this.developmentTtlMs,prior.absolute_expires_at,prior.family_id])).rows[0];await tx.query("UPDATE auth_tokens SET expires_at=LEAST(expires_at,clock_timestamp()+interval '5 seconds') WHERE digest=$1",[prior.digest]);return {token,expiresAt:row.expires_at.toISOString()};});
  }
  async logout(header:string){const ctx=await this.authenticate(header);requireCondition(!ctx.run,'FORBIDDEN_ACTION','Run tokens cannot change platform sessions');await this.store.pool.query('DELETE FROM auth_tokens WHERE family_id=(SELECT family_id FROM auth_tokens WHERE digest=$1)',[sha256(header.slice(7))]);return {signedOut:true};}
  async authenticate(header?: string): Promise<AuthContext> {
    requireCondition(typeof header === 'string' && header.startsWith('Bearer '), 'UNAUTHENTICATED', 'Bearer token required');
    const result = await this.store.pool.query(`SELECT p.*,a.constraints,a.digest FROM auth_tokens a JOIN policies p USING(principal_id)
      WHERE a.digest=$1 AND a.expires_at>clock_timestamp() AND (a.constraints IS NOT NULL OR a.absolute_expires_at>clock_timestamp()) AND NOT p.disabled`, [sha256(header.slice(7))]);
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
    const assignments=row.kind==='user'?await this.roles.assignments(row.principal_id,row.tenant_id,tx):[],scopeGrants:Record<string,string[]>={};
    const ranks={viewer:0,member:1,admin:2};for(const assignment of assignments){const grants=[...new Set<string>(assignment.grants)];scopeGrants[assignment.scope_id]=ctx.run?grants.filter(grant=>ctx.run!.grants.includes(grant)):grants;}
    if(row.kind!=='user')for(const scope of row.scopes)scopeGrants[scope]=ctx.run?row.grants.filter((grant:string)=>ctx.run!.grants.includes(grant)):row.grants;
    const scopes=Object.keys(scopeGrants).filter(scope=>!ctx.run||ctx.run.scopes.includes(scope));
    return { principalId: row.principal_id, tenantId: row.tenant_id, kind: row.kind, workerId: row.worker_id ?? undefined,
      scopes,grants:[...new Set(scopes.flatMap(scope=>scopeGrants[scope]))],scopeGrants,roles:assignments.filter(assignment=>scopes.includes(assignment.scope_id)).map(assignment=>({scopeId:assignment.scope_id,role:assignment.role})),targets: row.targets, defects: row.defects,...(ctx.run?{run:ctx.run}:{}),...(ctx.tokenDigest?{tokenDigest:ctx.tokenDigest}:{}) };
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
    const scopes=policy.scopes.filter(scope=>policy.scopeGrants?.[scope]?.includes(grant));requireCondition(scopes.length&&(!scopeId||scopes.includes(scopeId)), 'FORBIDDEN_ACTION', `Permission ${grant} is required`);
    return {...policy,scopes};
  }
  async target(ctx: AuthContext, grant: string, scopeId: string, target: string, tx?: Transaction): Promise<Policy> {
    const policy = await this.check(ctx, grant, scopeId, tx);
    requireCondition(policy.targets.includes(target), 'FORBIDDEN_TARGET', 'Target is outside the authenticated policy'); return policy;
  }
  async intersectService(serviceId: string, ownerId: string, tx?: Transaction): Promise<Policy> {
    const service = await this.policy({ principalId: serviceId } as AuthContext, tx);
    const owner = await this.policy({ principalId: ownerId } as AuthContext, tx);
    requireCondition(service.kind === 'service' && service.tenantId === owner.tenantId, 'FORBIDDEN_ACTION', 'Rule requires a same-tenant service identity');
    const scopes=service.scopes.filter(value=>owner.scopes.includes(value)),scopeGrants=Object.fromEntries(scopes.map(scope=>[scope,(service.scopeGrants?.[scope]??[]).filter(grant=>owner.scopeGrants?.[scope]?.includes(grant))]));return { ...service, scopes,scopeGrants,
      targets: service.targets.filter(value => owner.targets.includes(value)), defects: service.defects.filter(value => owner.defects.includes(value)),
      grants: [...new Set(scopes.flatMap(scope=>scopeGrants[scope]))] };
  }
  async audit(ctx: AuthContext, action: string, detail: unknown, scopeId?: string, tx?: Transaction): Promise<void> {
    await (tx ?? this.store.pool).query('INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail) VALUES($1,$2,$3,$4,$5)',
      [ctx.tenantId, scopeId ?? null, ctx.principalId, action, JSON.stringify(detail)]);
  }
}
