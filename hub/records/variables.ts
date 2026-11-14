import { lockEnvironmentPermission } from './environment-permission-lock.ts';
import { isAdmin } from './permissions.ts';
// Ordinary variables use record decisions; secret versions live in the vault and records provide audit only.
import { createHash } from 'node:crypto';
import { OrdinaryVariableName, VariableName, VariableRecord, VariableValue, validateSecret, referencesIn, resolve as resolveValue, type OrdinaryVariableUse } from '../../contracts/src/variables.ts';
import { PermissionRoleSchema, isDigestRule, type DigestRule, type VariableKind, type PermissionKind } from '../../contracts/generated/vocabulary.ts';
import type { Principal, Principals, RecordStore, ObjectStore, Vault, Authorizations, AuthorizationRecord, Transaction, Page, VaultSecretMetadata, VaultSecretMaterial, VaultSecretWriteResult } from './api.ts';
import { canonicalBytes, canonicalize } from './canonical.ts';
import { parseStrictJson } from './strict-json.ts';
import { scanForCredentials } from './scan.ts';
import { AccessError, IntegrityError, VaultError, VaultReadinessError, isVaultReadBoundaryError, unexpectedVaultReadError } from './errors.ts';
import { WHOLE_HUB } from './constants.ts';
import type { Database } from './db.ts';
import { verifiedRecord } from './store.ts';
const CONFIG: PermissionKind = 'resource_config';
export class VariableError extends Error {
    readonly nameOfVariable?: string;
    constructor(message: string, name?: string) { super(message); this.nameOfVariable = name; }
}
export interface NamedVersion {
    kind: VariableKind;
    name: string;
    version: number;
    decision: AuthorizationRecord;
    definition: VariableRecord | null;
}
export type VariableSnapshot = ReadonlyMap<string, string>;
export interface SecretWrite {
    name: string;
    value: string;
    digest_rule?: DigestRule;
    short?: boolean;
    alreadyStored?: boolean;
}
export interface PreparedSecrets {
    readonly items: ReadonlyArray<{ name: string }>;
    readonly reason: string;
}
export interface VariableWriteOptions {
    names?: readonly string[];
    notSecret?: boolean;
    validate?: (tx: Transaction) => Promise<void>;
}
export type SecretMaterial = VaultSecretMaterial;
export interface VariablePorts {
    database: Database;
    store: RecordStore;
    objects: ObjectStore;
    vault: Vault;
    principals: Pick<Principals, 'get'>;
    authorizations: Authorizations;
    now?: () => Date;
}
/** Reversible spellings are available separately for disclosure checks; reasons also exclude digest spellings. */
export function secretForms(value:string,options:{hashes?:boolean}={}):string[]{const forms=[value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value),Buffer.from(value).toString('base64')];if(options.hashes!==false)forms.push(createHash('sha256').update(value).digest('hex'),createHash('sha512').update(value).digest('hex'));return [...new Set(forms)];}
export function validateChangeReason(reason: unknown, values: readonly string[] = []): string {
    if (typeof reason !== 'string' || !reason.trim() || [...reason].length > 500 || scanForCredentials(Buffer.from(reason)).findings.length)
        throw new VariableError('理由必填、至多 500 个字符且不能含凭据；请重写理由');
    for (const value of values)
        for (const form of secretForms(value)) {
            if(form.length>0&&reason.includes(form))throw new VariableError('理由不能含密钥或其片段；请重写理由');
            if (form.length >= 8)
                for (let at = 0; at <= form.length - 8; at++)
                    if (reason.includes(form.slice(at, at + 8)))
                        throw new VariableError('理由不能含密钥或其片段；请重写理由');
        }
    return reason;
}
export class RecordVariables {
    readonly #p: VariablePorts;
    readonly #now: () => Date;
    readonly #prepared = new WeakMap<object, SecretWrite[]>();
    constructor(ports: VariablePorts) { this.#p = ports; this.#now = ports.now ?? (() => new Date()); }
    async assertAdmin(by: Principal, tx?: Transaction) {
        const row = tx ? (await this.#p.database.query('SELECT id,role,disabled,deleted_at FROM users WHERE id=$1 FOR SHARE', [by.id], tx)).rows[0] : null;
        const actual = tx ? row ? { role: PermissionRoleSchema.parse(row.role), disabled: row.disabled === true, deleted_at: row.deleted_at } : null : await this.#p.principals.get(by.id);
        if (!actual || actual.disabled || actual.deleted_at || !isAdmin(actual)) throw new AccessError('只有管理员可以设置或查看变量与密钥');
    }
    #name(name: unknown, kind: VariableKind): string { const parsed = (kind === 'var' ? OrdinaryVariableName : VariableName).safeParse(name); if (!parsed.success)
        throw new VariableError(parsed.error.issues[0]?.message ?? '名字不合规则；请核对参数'); return parsed.data; }
    async lockNames(names: readonly string[], tx: Transaction) { for (const name of [...new Set(names)].sort()) {
        this.#name(name, 'secret');
        await this.#p.store.lock('variable-name:' + name, tx);
    } }
    async #history(kind: VariableKind, name: string, tx?: Transaction): Promise<AuthorizationRecord[]> { const out: AuthorizationRecord[] = []; let cursor: string | null = null; do {
        const page: Page<AuthorizationRecord> = await this.#p.store.find<AuthorizationRecord['body']>({ key: 'authz.key', value: `${CONFIG}|${WHOLE_HUB}|${kind}:${name}`, kind: 'authorization', newestFirst: true, limit: 500, cursor }, tx);
        out.push(...page.items);
        cursor = page.next;
    } while (cursor); return out; }
    async #definition(decision: AuthorizationRecord, kind: VariableKind, name: string, tx?: Transaction) {
        if (decision.body.revoked)
            return null;
        if (!decision.body.bound)
            throw new IntegrityError('变量决定缺少绑定内容');
        const bytes = await this.#p.objects.get(decision.body.bound, tx);
        if (!bytes)
            throw new IntegrityError('变量决定绑定的对象不可读');
        const parsed = VariableRecord.safeParse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
        if (!parsed.success || parsed.data.name !== name)
            throw new IntegrityError('变量决定的绑定内容不合记录模式');
        return parsed.data;
    }
    async #version(kind: VariableKind, name: string, decision: AuthorizationRecord, history?: AuthorizationRecord[], known?: VariableRecord | null): Promise<NamedVersion> { const rows = history ?? await this.#history(kind, name); const at = rows.findIndex(row => row.digest === decision.digest); if (at < 0)
        throw new IntegrityError('变量决定不在它的历史链里'); return { kind, name, version: rows.slice(at).filter(row => !row.body.revoked).length, decision, definition: known === undefined ? await this.#definition(decision, kind, name) : known }; }
    async #kindFree(name: string, kind: VariableKind, tx: Transaction) {
        const occupied = kind === 'var' ? (await this.#p.vault.secretHistory(name)).length > 0 : (await this.#history('var', name, tx)).length > 0;
        if (occupied) throw new VariableError('名字已经属于另一种；撤回也不改变名字的种类，请换一个名字', name);
    }
    async setVariable(by: Principal, name: string, value: unknown, reason: string, options: VariableWriteOptions = {}): Promise<{
        value: NamedVersion;
        created: boolean;
    }> {
        await this.assertAdmin(by);
        name = this.#name(name, 'var');
        const parsed = VariableValue.safeParse(value);
        if (!parsed.success)
            throw new VariableError(parsed.error.issues[0].message);
        const text = canonicalize(value);
        const token = (v: unknown): boolean => typeof v === 'string' ? v.length >= 16 && !/\s/u.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) : Array.isArray(v) ? v.some(token) : v !== null && typeof v === 'object' ? Object.entries(v).some(([key,value])=>token(key)||token(value)) : false;
        if (!options.notSecret && (scanForCredentials(Buffer.from(text)).findings.length || token(value)))
            throw new VariableError('值像是凭据：用 circle-hub secret set；确实不是时显式给 --not-secret');
        const note = validateChangeReason(reason + (options.notSecret ? '；已确认不是密钥（--not-secret）' : ''));
        const definition = VariableRecord.parse({ schema: 'variable@1', name, value });
        return this.#p.store.withTransaction(async (tx) => {
            await lockEnvironmentPermission(this.#p.store, tx);
            await this.assertAdmin(by, tx);
            await this.lockNames([name, ...(options.names ?? [])], tx);
            await this.#kindFree(name, 'var', tx);
            await options.validate?.(tx);
            const object = await this.#p.objects.put(canonicalBytes(definition), 'application/json', tx);
            const history = await this.#history('var', name, tx), previous = history[0];
            if (previous && !previous.body.revoked && previous.body.bound === object.sha256)
                return { value: await this.#version('var', name, previous, history, definition), created: false };
            const decision = await this.#p.authorizations.configureResourceInTransaction(by, 'var:' + name, object.sha256, note, tx);
            return { value: await this.#version('var', name, decision, [decision, ...history], definition), created: true };
        });
    }
    async prepareSecrets(by: Principal, input: readonly SecretWrite[], reason: string): Promise<PreparedSecrets> {
        await this.assertAdmin(by);
        if (!input.length || new Set(input.map(v => v.name)).size !== input.length)
            throw new VariableError('密钥名字不能为空或重复；逐项核对 --name');
        const writes = input.map(v => {
            const name = this.#name(v.name, 'secret');
            let raw: string;
            try { raw = validateSecret(v.value, v.short); }
            catch { throw new VariableError('密钥文本不合一行长度规则；短值需显式声明'); }
            const rule = v.digest_rule ?? 'plain';
            if (!isDigestRule(rule)) throw new VariableError('摘要规则不合生成词表');
            return { name, value: rule === 'sha512_base64' && !v.alreadyStored ? createHash('sha512').update(raw).digest('base64') : raw, digest_rule: rule, short: true, alreadyStored: true };
        });
        const note = validateChangeReason(reason, [...input.map(v => v.value), ...writes.map(v => v.value)]);
        const prepared = { items: writes.map(v => ({ name: v.name })), reason: note };
        this.#prepared.set(prepared, writes);
        return prepared;
    }
    async #auditSecret(by: Principal, metadata: VaultSecretWriteResult, reason: string, tx: Transaction): Promise<void> {
        await lockEnvironmentPermission(this.#p.store, tx);
        await this.assertAdmin(by, tx);
        const audit = await this.#p.objects.put(canonicalBytes({ name: metadata.name, by: by.id, at: this.#now().toISOString(), ...(metadata.archive ? { operation: '归档后重新设置', archive: metadata.archive } : {}) }), 'application/json', tx);
        await this.#p.authorizations.configureResourceInTransaction(by, 'secret:' + metadata.name, audit.sha256, reason, tx, metadata.revoked);
    }
    async commitSecrets(by: Principal, prepared: PreparedSecrets, tx: Transaction, validate?: (tx: Transaction) => Promise<void>): Promise<VaultSecretWriteResult[]> {
        await lockEnvironmentPermission(this.#p.store, tx);
        await this.assertAdmin(by, tx);
        const writes = this.#prepared.get(prepared);
        if (!writes) throw new VariableError('密钥准备结果不是本次可信输入；请重新设置');
        this.#prepared.delete(prepared);
        await this.lockNames(writes.map(v => v.name), tx);
        for (const write of writes) await this.#kindFree(write.name, 'secret', tx);
        await validate?.(tx);
        const out: VaultSecretWriteResult[] = [];
        for (const write of writes) {
            let metadata: VaultSecretWriteResult;
            try { metadata = await this.#p.vault.putSecret({ name: write.name, value: write.value, digest_rule: write.digest_rule!, set_by: by.id, set_at: this.#now().toISOString(), reason: prepared.reason }); }
            catch (error) { throw new VariableError((out.length ? '部分密钥库已更新；' : '') + (error instanceof VaultError ? error.message : '密钥库写入未完成；请核对主密钥、封存文件及缺失元数据')); }
            try { await this.#auditSecret(by, metadata, prepared.reason, tx); }
            catch { throw new VariableError('密钥库已更新，审计记录未完成；请管理员核对密钥库元数据，不要重输值'); }
            out.push(metadata);
        }
        return out;
    }
    async setSecrets(by: Principal, input: readonly SecretWrite[], reason: string, validate?: (tx: Transaction) => Promise<void>): Promise<VaultSecretWriteResult[]> {
        const prepared = await this.prepareSecrets(by, input, reason);
        let vaultUpdated = false;
        try { return await this.#p.store.withTransaction(async tx => { const result = await this.commitSecrets(by, prepared, tx, validate); vaultUpdated = true; return result; }); }
        catch (error) { if (vaultUpdated) throw new VariableError('密钥库已更新，审计事务未完成；请管理员核对密钥库元数据，不要重输值'); throw error; }
    }
    async unsetSecret(by: Principal, name: string, reason: string): Promise<VaultSecretMetadata> {
        await this.assertAdmin(by);
        name = this.#name(name, 'secret');
        let vaultUpdated = false;
        try { return await this.#p.store.withTransaction(async tx => {
            await lockEnvironmentPermission(this.#p.store, tx);
            await this.assertAdmin(by, tx);
            await this.lockNames([name], tx);
            const note = validateChangeReason(reason, (await this.#p.vault.recentSecrets()).map(v => v.value));
            let metadata: VaultSecretWriteResult;
            try { metadata = await this.#p.vault.unsetSecret(name, by.id, this.#now().toISOString()); }
            catch { throw new VariableError('密钥名字不存在、主密钥无法解开或封存元数据缺失；撤回未完成'); }
            vaultUpdated = true;
            await this.#auditSecret(by, metadata, note, tx);
            return metadata;
        }); } catch (error) {
            if (vaultUpdated) throw new VariableError('密钥库已撤回，审计记录未完成；请管理员核对密钥库元数据');
            throw error;
        }
    }
    async listSecrets(by: Principal): Promise<VaultSecretMetadata[]> {
        await this.assertAdmin(by);
        const out: VaultSecretMetadata[] = [];
        for (const name of await this.#p.vault.secretNames()) {
            const metadata = await this.#p.vault.secretMetadata(name);
            if (metadata) out.push(metadata);
        }
        return out;
    }
    async secretHistory(by: Principal, name: string): Promise<VaultSecretMetadata[]> {
        await this.assertAdmin(by);
        return this.#p.vault.secretHistory(this.#name(name, 'secret'));
    }
    async unset(by: Principal, kind: 'var', name: string, reason: string, validate?: (tx: Transaction) => Promise<void>): Promise<NamedVersion> {
        await this.assertAdmin(by);
        name = this.#name(name, kind);
        const note = validateChangeReason(reason);
        return this.#p.store.withTransaction(async tx => {
            await lockEnvironmentPermission(this.#p.store, tx);
            await this.assertAdmin(by, tx);
            await this.lockNames([name], tx);
            await this.#kindFree(name, kind, tx);
            await validate?.(tx);
            const history = await this.#history(kind, name, tx);
            if (!history.length) throw new VariableError('名字没有设置决定；请核对名字');
            const decision = await this.#p.authorizations.configureResourceInTransaction(by, kind + ':' + name, null, note, tx, true);
            return this.#version(kind, name, decision, [decision, ...history]);
        });
    }
    async history(by: Principal, kind: 'var', name: string): Promise<NamedVersion[]> { await this.assertAdmin(by); name = this.#name(name, kind); const rows = await this.#history(kind, name); return Promise.all(rows.map(row => this.#version(kind, name, row, rows))); }
    async list(by: Principal): Promise<NamedVersion[]> {
        await this.assertAdmin(by);
        const latest = new Map<string, AuthorizationRecord>();
        let cursor: string | null = null;
        do {
            const page: Page<AuthorizationRecord> = await this.#p.authorizations.history({ permission: CONFIG, subject: WHOLE_HUB, limit: 500, cursor, newestFirst: true });
            for (const row of page.items)
                if (row.body.object.startsWith('var:') && !latest.has(row.body.object))
                    latest.set(row.body.object, row);
            cursor = page.next;
        } while (cursor);
        return Promise.all([...latest].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => this.#version('var', key.slice(key.indexOf(':') + 1), row)));
    }
    async snapshot(tx?: Transaction): Promise<VariableSnapshot> {
        const prefix = CONFIG + '|' + WHOLE_HUB + '|var:';
        const rows = await this.#p.database.query(`SELECT DISTINCT ON (i.value) r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body FROM record_index i JOIN records r ON r.digest=i.digest WHERE i.key='authz.key' AND left(i.value,length($1))=$1 AND r.kind='authorization' ORDER BY i.value,i.record_seq DESC`, [prefix], tx);
        const out = new Map<string, string>();
        for (const raw of rows.rows) {
            const row = verifiedRecord<AuthorizationRecord['body']>(raw, tx);
            if (row.body.permission === CONFIG && row.body.subject === WHOLE_HUB && row.body.object.startsWith('var:') && !row.body.revoked)
                out.set(row.body.object.slice(4), row.digest);
        }
        return out;
    }
    async valueAt(name: string, decision: string, tx?: Transaction): Promise<unknown> { name = this.#name(name, 'var'); const row = await this.#p.store.get<AuthorizationRecord['body']>(decision, tx); if (!row || row.kind !== 'authorization' || row.body.permission !== CONFIG || row.body.subject !== WHOLE_HUB || row.body.object !== 'var:' + name || row.body.revoked)
        throw new VariableError('变量版本不可用；请先 circle-hub var set <名字>', name); return (await this.#definition(row, 'var', name, tx) as VariableRecord).value; }
    async resolveVariables(value: unknown, at: string, snapshot?: VariableSnapshot, tx?: Transaction): Promise<{
        value: unknown;
        uses: OrdinaryVariableUse[];
    }> { const refs = referencesIn(value); const frozen = snapshot ?? await this.snapshot(tx); const values = new Map<string, unknown>(), uses: OrdinaryVariableUse[] = []; for (const ref of refs) {
        if (ref.kind !== 'var')
            throw new VariableError('这里只能引用普通变量，密钥只许用于凭据项');
        const decision = frozen.get(ref.name);
        if (!decision)
            throw new VariableError(snapshot ? `本次变量快照缺少 ${ref.name} 的决定：先确认 circle-hub var set ${ref.name}，再重开运行或同步` : `变量 ${ref.name} 没有设置：先 circle-hub var set ${ref.name}`, ref.name);
        values.set(ref.name, await this.valueAt(ref.name, decision, tx));
        uses.push({ kind: 'var', at: at + '#' + ref.at, name: ref.name, decision });
    } return { value: resolveValue(value, (_kind, name) => values.get(name)), uses }; }
    async readSecrets(requests: readonly { name: string }[]): Promise<SecretMaterial[]> {
        const out: SecretMaterial[] = [];
        for (const request of requests) {
            const name = this.#name(request.name, 'secret');
            let material: SecretMaterial | null;
            try { material = await this.#p.vault.readSecret(name); }
            catch (error) { if (error instanceof VaultReadinessError) throw error; if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError(); throw new VariableError('密钥 ' + name + '：' + (error instanceof VaultError ? error.message : '主密钥、封存或认证元数据不可核对；没有取值'), name); }
            if (!material) throw new VariableError('密钥 ' + name + ' 名字不存在或已撤回；请 circle-hub secret set --name ' + name, name);
            out.push(material);
        }
        return out;
    }
    async recentSecrets(names?: readonly string[]): Promise<SecretMaterial[]> {
        try { return await this.#p.vault.recentSecrets(names); }
        catch (error) {
            if (error instanceof VaultReadinessError) throw error;
            if (!isVaultReadBoundaryError(error)) throw unexpectedVaultReadError();
            throw new VaultReadinessError([{ name: null, entry: 'vault/', missing: ['inventory'], reason: '密钥库脱敏材料读取失败；未返回部分材料', next_action: '请管理员查看运行状况中的密钥库条目诊断，核对主密钥、目录权限和认证元数据后重试；不会跳过脱敏' }]);
        }
    }
}
