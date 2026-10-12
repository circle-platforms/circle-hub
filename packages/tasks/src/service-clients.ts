import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError, ServiceClientRegistration, ServiceClientRotation, newId, sha256, requireCondition, type AuthContext } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import type { Assets } from '../../assets/src/index.ts';
import type { Auth } from './auth.ts';
const credential = (value: string) => { const salt = randomBytes(16); return { salt: salt.toString('hex'), digest: scryptSync(value, salt, 32).toString('hex') }; };
export class ServiceClients {
    store: Store;
    auth: Auth;
    assets: Assets;
    ttlSeconds: number;
    constructor(store: Store, auth: Auth, assets: Assets, ttlSeconds = 300) { this.store = store; this.auth = auth; this.assets = assets; this.ttlSeconds = ttlSeconds; requireCondition(Number.isInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= 300, 'INVALID_PAYLOAD', 'Resource token lifetime must be between one and 300 seconds'); }
    view(row: any) { return { clientId: row.client_id, principalId: row.principal_id, scopeId: row.scope_id, resourceAssetId: row.resource_asset_id, name: row.name, scopes: row.scopes, resourceScopes: row.resource_scopes, secretVersion: row.secret_version, revoked: row.revoked }; }
    async row(ctx: AuthContext, id: string, tx?: Transaction) { const p = await this.auth.check(ctx, 'service-clients.manage', undefined, tx), row = (await (tx ?? this.store.pool).query('SELECT * FROM service_clients WHERE client_id=$1 AND tenant_id=$2 AND scope_id=ANY($3::text[])', [id, p.tenantId, p.scopes])).rows[0]; requireCondition(row, 'SOURCE_FORBIDDEN', 'Service client is not available to this identity'); return row; }
    async list(ctx: AuthContext, limit: number, after?: string) { const p = await this.auth.check(ctx, 'service-clients.manage'), rows = (await this.store.pool.query('SELECT * FROM service_clients WHERE tenant_id=$1 AND scope_id=ANY($2::text[]) AND ($3::text IS NULL OR client_id>$3) ORDER BY client_id LIMIT $4', [p.tenantId, p.scopes, after ?? null, limit + 1])).rows; return { items: rows.slice(0, limit).map(row => this.view(row)), nextCursor: rows.length > limit ? rows[limit - 1].client_id : null }; }
    async register(ctx: AuthContext, value: unknown) {
        const input = ServiceClientRegistration.parse(value);
        return this.store.transaction(async (tx) => {
            const p = await this.auth.check(ctx, 'service-clients.manage', input.scopeId, tx), asset = await this.assets.row(ctx, input.resourceAssetId, tx);
            requireCondition(asset.scope_id === input.scopeId, 'FORBIDDEN_SCOPE', 'Resource crosses the client scope');
            requireCondition(['connector-instance', 'environment-resource'].includes(asset.kind), 'INVALID_PAYLOAD', 'Register a client for an execution resource');
            const id = newId('svc'), principalId = `prn_${id.slice(4)}`, key = credential(input.secret);
            await tx.query("INSERT INTO policies(principal_id,tenant_id,kind,scopes,grants,targets,defects) VALUES($1,$2,'service',$3,$4,'[]','[]')", [principalId, p.tenantId, JSON.stringify([input.scopeId]), JSON.stringify(['assets.read', 'sources.read', 'knowledge.read'])]);
            const row = (await tx.query('INSERT INTO service_clients(client_id,principal_id,tenant_id,scope_id,resource_asset_id,name,scopes,resource_scopes,secret_salt,secret_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [id, principalId, p.tenantId, input.scopeId, input.resourceAssetId, input.name, JSON.stringify([...new Set(input.scopes)]), JSON.stringify([...new Set(input.resourceScopes)]), key.salt, key.digest])).rows[0];
            await this.auth.audit(ctx, 'service-clients.register', { clientId: id, resourceAssetId: input.resourceAssetId }, input.scopeId, tx);
            return this.view(row);
        });
    }
    async rotate(ctx: AuthContext, id: string, value: unknown) { const input = ServiceClientRotation.parse(value); return this.store.transaction(async (tx) => { const row = await this.row(ctx, id, tx); requireCondition(!row.revoked, 'DECISION_CONFLICT', 'Revoked clients cannot rotate'); const key = credential(input.secret), updated = (await tx.query('UPDATE service_clients SET secret_salt=$2,secret_digest=$3,secret_version=secret_version+1 WHERE client_id=$1 AND NOT revoked RETURNING *', [id, key.salt, key.digest])).rows[0]; requireCondition(updated, 'DECISION_CONFLICT', 'Client was revoked'); await this.auth.audit(ctx, 'service-clients.rotate', { clientId: id, secretVersion: updated.secret_version }, row.scope_id, tx); return this.view(updated); }); }
    async revoke(ctx: AuthContext, id: string) { return this.store.transaction(async (tx) => { const row = await this.row(ctx, id, tx), updated = (await tx.query('UPDATE service_clients SET revoked=true WHERE client_id=$1 RETURNING *', [id])).rows[0]; await tx.query('UPDATE policies SET disabled=true WHERE principal_id=$1', [row.principal_id]); await this.auth.audit(ctx, 'service-clients.revoke', { clientId: id }, row.scope_id, tx); return this.view(updated); }); }
    async basic(header?: string) {
        let id = '', secret = '';
        try {
            if (!header?.startsWith('Basic '))
                throw new Error();
            const encoded = header.slice(6), decoded = Buffer.from(encoded, 'base64');
            if (decoded.toString('base64') !== encoded)
                throw new Error();
            const text = decoded.toString(), index = text.indexOf(':');
            if (index < 0)
                throw new Error();
            id = decodeURIComponent(text.slice(0, index));
            secret = decodeURIComponent(text.slice(index + 1));
            if (secret.length > 2048)
                throw new Error();
        }
        catch {
            throw new ApiError('UNAUTHENTICATED', 'Invalid service client credentials');
        }
        const row = (await this.store.pool.query('SELECT c.* FROM service_clients c JOIN policies p USING(principal_id) WHERE c.client_id=$1 AND NOT c.revoked AND NOT p.disabled', [id])).rows[0], digest = scryptSync(secret, Buffer.from(row?.secret_salt ?? '0'.repeat(32), 'hex'), 32);
        requireCondition(row && timingSafeEqual(digest, Buffer.from(row.secret_digest, 'hex')), 'UNAUTHENTICATED', 'Invalid service client credentials');
        return row;
    }
    async grant(client: any, scope: string) {
        const scopes = scope.split(' ').filter(Boolean);
        if (!scopes.length || !scopes.every(item => client.scopes.includes(item)))
            throw new ApiError('INVALID_PAYLOAD', 'Requested client scope is unavailable', { oauthError: 'invalid_scope' });
        return this.store.transaction(async (tx) => {
            const live = (await tx.query('SELECT c.* FROM service_clients c JOIN policies p USING(principal_id) WHERE client_id=$1 AND NOT revoked AND NOT p.disabled AND secret_version=$2 FOR SHARE OF c', [client.client_id, client.secret_version])).rows[0];
            requireCondition(live, 'UNAUTHENTICATED', 'Service client authorization changed');
            return this.mint(tx, live, live.principal_id, [...new Set(scopes)]);
        });
    }
    async mint(tx: Transaction, client: any, subjectId: string, scopes: string[], operation?: any, permission?: string) {
        const token = randomBytes(32).toString('base64url'), binding = operation ? JSON.stringify(['resource-access', client.client_id, subjectId, operation.operation_id, String(operation.fencing_token)]) : null, key = binding ? await this.assets.vault.put(token, binding) : null;
        const row = (await tx.query(`INSERT INTO resource_access_tokens(digest,client_id,secret_version,subject_id,tenant_id,scope_id,scopes,expires_at,operation_id,fencing_token,permission,secret_key,secret_binding)
      VALUES($1,$2,$3,$4,$5,$6,$7,LEAST(clock_timestamp()+($8::integer*interval '1 second'),COALESCE($9::timestamptz,'infinity')),$10,$11,$12,$13,$14) RETURNING expires_at`, [sha256(token), client.client_id, client.secret_version, subjectId, client.tenant_id, client.scope_id, JSON.stringify(scopes), this.ttlSeconds, operation?.deadline_at ?? null, operation?.operation_id ?? null, operation?.fencing_token ?? null, permission ?? null, key, binding])).rows[0];
        return { access_token: token, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((row.expires_at.getTime() - Date.now()) / 1000)), scope: scopes.join(' '), ...(key ? { injection: { key, binding, provider: 'server', expiresAt: row.expires_at.toISOString() } } : {}) };
    }
    async binding(ctx: AuthContext, id: string, resourceId: string, scopeId: string, scopes: string[], tx: Transaction) { const p = await this.auth.policy(ctx, tx), row = (await tx.query('SELECT c.* FROM service_clients c JOIN policies p USING(principal_id) WHERE client_id=$1 AND c.tenant_id=$2 AND scope_id=$3 AND resource_asset_id=$4 AND NOT revoked AND NOT p.disabled', [id, p.tenantId, scopeId, resourceId])).rows[0]; requireCondition(row && p.scopes.includes(scopeId) && scopes.every(scope => row.resource_scopes.includes(scope)), 'FORBIDDEN_ACTION', 'Service client does not authorize this resource binding'); return row; }
    async operationLive(tx: Transaction, row: any) { const active = (await tx.query(`SELECT 1 FROM operations o JOIN leases l USING(operation_id) JOIN tasks t USING(task_id) WHERE o.operation_id=$1 AND o.fencing_token=$2 AND o.principal_id=$3 AND o.tenant_id=$4 AND o.scope_id=$5 AND o.target=$6 AND o.status='running' AND l.fencing_token=o.fencing_token AND l.worker_id=o.worker_id AND l.expires_at>clock_timestamp() AND o.deadline_at>clock_timestamp() AND o.input_revision_id=t.input_revision_id AND (NOT t.cancel_requested OR o.kind='reconcile')`, [row.operation_id, row.fencing_token, row.subject_id, row.tenant_id, row.scope_id, row.resource_asset_id])).rowCount; return !!active; }
    async issueForOperation(tx: Transaction, ctx: AuthContext, operation: any, clientId: string, scopes: string[], permission: string) {
        // Match the execution preflight lock order, including callers that
        // request a narrower delegation through this generic C interface.
        await tx.query('SELECT 1 FROM operations WHERE operation_id=$1 FOR UPDATE',[operation.operation_id]);
        scopes = [...new Set(scopes)].sort();
        const client = await this.binding(ctx, clientId, operation.target, operation.scope_id, scopes, tx);
        await this.auth.check(ctx, permission, operation.scope_id, tx);
        requireCondition(await this.operationLive(tx, { ...operation, subject_id: ctx.principalId, resource_asset_id: operation.target }), 'FENCING_STALE', 'Resource token needs a current execution lease');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`resource-token:${operation.operation_id}:${operation.fencing_token}`]);
        const old = (await tx.query(`SELECT * FROM resource_access_tokens WHERE operation_id=$1 AND fencing_token=$2 AND client_id=$3 AND secret_version=$4 AND expires_at>clock_timestamp()+($5::integer*interval '1 second') AND permission=$6 AND scopes=$7::jsonb AND subject_id=$8 ORDER BY expires_at DESC LIMIT 1`, [operation.operation_id, operation.fencing_token, clientId, client.secret_version, Math.min(15, Math.max(1, Math.ceil(this.ttlSeconds / 5))),permission,JSON.stringify(scopes),ctx.principalId])).rows[0];
        if (old)
            return { key: old.secret_key, binding: old.secret_binding, provider: 'server', expiresAt: old.expires_at.toISOString() };
        const token = await this.mint(tx, client, ctx.principalId, scopes, operation, permission);
        await this.auth.audit(ctx, 'resource-token.issued', { clientId, operationId: operation.operation_id, fencingToken: Number(operation.fencing_token), expiresAt: token.injection!.expiresAt }, operation.scope_id, tx);
        return token.injection;
    }
    async active(token: string, clientId?: string) {
        return this.store.transaction(async (tx) => {
            const row = (await tx.query(`SELECT r.*,c.resource_asset_id,c.principal_id AS client_principal_id,c.scopes AS client_scopes,c.resource_scopes,p.username,p.kind,p.grants,p.scopes AS platform_scopes FROM resource_access_tokens r JOIN service_clients c USING(client_id) JOIN policies cp ON cp.principal_id=c.principal_id JOIN policies p ON p.principal_id=r.subject_id
      WHERE r.digest=$1 AND r.expires_at>clock_timestamp() AND NOT c.revoked AND NOT cp.disabled AND NOT p.disabled AND r.secret_version=c.secret_version AND ($2::text IS NULL OR r.client_id=$2)`, [sha256(token), clientId ?? null])).rows[0];
            if (!row || !row.platform_scopes.includes(row.scope_id))
                return null;
            if (row.operation_id) {
                if (!row.grants.includes(row.permission) || !row.scopes.every((scope: string) => row.resource_scopes.includes(scope)) || !await this.operationLive(tx, row))
                    return null;
                const asset = (await tx.query("SELECT v.lifecycle FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.asset_id=$1 AND a.tenant_id=$2 AND a.scope_id=$3", [row.resource_asset_id, row.tenant_id, row.scope_id])).rows[0];
                if (!asset || !['approved', 'running'].includes(asset.lifecycle))
                    return null;
            }
            else if (!row.scopes.every((scope: string) => row.client_scopes.includes(scope)))
                return null;
            return row;
        });
    }
    async introspect(client: any, token: string) { requireCondition(client.scopes.includes('introspect'), 'FORBIDDEN_ACTION', 'Client introspection permission is required'); const row = await this.active(token, client.client_id); return row ? { active: true, sub: row.subject_id, scope: row.scopes.join(' '), exp: Math.floor(row.expires_at.getTime() / 1000), ...(row.kind === 'user' && row.username ? { username: row.username } : {}) } : { active: false }; }
    async bundleIdentity(header?: string): Promise<AuthContext> { requireCondition(header?.startsWith('Bearer '), 'UNAUTHENTICATED', 'Bearer token required'); const row = await this.active(header!.slice(7)); requireCondition(row && !row.operation_id && row.scopes.includes('bundles:read'), 'UNAUTHENTICATED', 'Client bundle token is invalid or expired'); return { principalId: row.subject_id, tenantId: row.tenant_id, kind: 'service' }; }
}
