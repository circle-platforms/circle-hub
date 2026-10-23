import { VariableError, WHOLE_HUB, canonicalBytes, canonicalize, newId, scanForCredentials, sha256Hex, type Principal, type RecordsKit, type VariableSnapshot, type AuthorizationRecord, type ActionBody, type RecordStore, type Transaction, type SecretWrite } from '../records/api.ts';
import { VariableInputError, secretNameOf, referencesIn, resolve as maskReferences } from '../../contracts/src/variables.ts';
import { Journal, isDone, isFrozen } from './journal.ts';
import { ExecutorDefinition } from './definition.ts';
import { ExecutorSource, resolveExecutor, checkedReferences } from './source.ts';
export { ExecutorSource } from './source.ts';
export type RegisteredExecutor = {
    id: string;
    digest: string;
    source: ExecutorSource;
    definition: ExecutorDefinition;
    resolved_digest: string;
    variables: import('../../contracts/src/variables.ts').VariableUse[];
};
export class ExecutorAccessError extends Error {
    readonly next_action: string;
    constructor(message: string, next: string) { super(message); this.next_action = next; }
}
export class ExecutorCredentialError extends ExecutorAccessError {
    constructor(id: string, name?: string, fact?:string) { super(fact??(name ? `密钥 ${name} 没有可用的当前设置；未发请求` : `执行器 ${id} 还没有 credential 引用；未发请求`), name ? `circle-hub secret set --name ${name}，然后重做原操作` : `在定义里加 credential 引用后 circle-hub executor update ${id} <定义文件>；原来的钥匙会迁移过去`); }
}
export function executorConsumer(d: ExecutorDefinition | ExecutorSource) { return { definition: d.id!, item: 'credential', sends_to: sha256Hex(canonicalBytes({ endpoint: d.endpoint, ca: d.ca })) }; }
interface UpdateGuard {
    digest: string;
    source: ExecutorSource;
    target: string;
    rebind: boolean;
}
/** One order for configuration, reservation and intent locks; no network I/O while holding them. */
export async function lockExecutorConfiguration(store: RecordStore, tx: Transaction, id: string, resources: readonly string[], targets: readonly string[], origins: readonly string[]) {
    const keys = ['dispatch-config:executor:' + id, ...resources.map(v => 'dispatch-config:resource:' + sha256Hex(v)), ...targets.map(v => 'dispatch-config:target:' + sha256Hex(v)), ...origins.map(v => 'dispatch-config:origin:' + sha256Hex(v))];
    for (const key of [...new Set(keys)].sort())
        await store.lock(key, tx);
}
async function assertUnused(store: RecordStore, tx: Transaction, id: string, guard: UpdateGuard) {
    const rows = new Map<string, import('./journal.ts').Event>();
    const queries = [{ key: 'dispatch.executor', values: [id] }, { key: 'dispatch.resource', values: guard.source.resources.map(v => sha256Hex(v)) }, { key: 'dispatch.scope.target', values: [sha256Hex(guard.target)] }, { key: 'dispatch.scope.origin', values: [sha256Hex(new URL(guard.source.endpoint).origin)] }];
    for (const query of queries)
        for (const row of await store.findMany<ActionBody>({ ...query, kind: 'action' }, tx))
            rows.set(row.digest, row);
    const jobs = new Map<string, import('./journal.ts').Event[]>();
    for (const row of rows.values()) {
        const id = String(row.body.detail.job);
        const list = jobs.get(id) ?? [];
        list.push(row);
        jobs.set(id, list);
    }
    const blocked = [];
    for (const [job, history] of jobs) {
        const reservation = history.find(e => e.body.detail.phase === 'reservation');
        if (reservation && reservation.body.detail.read_only !== true && (!isDone(history) || isFrozen(history)))
            blocked.push(job);
    }
    if (blocked.length)
        throw new Error(`执行器身份或资源仍被作业 ${blocked.join('、')} 占用；先 circle-hub job dispose ${blocked[0]} … 完成具名处置`);
}
export class ExecutorRegistry {
    readonly records: RecordsKit;
    constructor(records: RecordsKit) { this.records = records; }
    async admin(by: Principal) { const user = await this.records.principals.get(by.id); if (!user || user.disabled || user.role !== 'admin')
        throw new Error('只有启用中的管理员能操作执行器和作业'); }
    async add(by: Principal, input: unknown): Promise<RegisteredExecutor> { await this.admin(by); return this.configure(by, this.validate({ ...input as object, id: newId('exe') })); }
    async update(by: Principal, id: string, input: unknown): Promise<RegisteredExecutor> {
        await this.admin(by);
        const current = await this.readSource(id);
        if (!current)
            throw new Error('执行器对你不可用');
        const source = this.validate({ ...input as object, id });
        const rebind = current.source.target !== source.target || current.source.endpoint !== source.endpoint || current.source.ca !== source.ca || canonicalize([...current.source.resources].sort()) !== canonicalize([...source.resources].sort());
        let previousTarget = current.source.target;
        if (rebind) {
            const old = await resolveExecutor(this.records, current.source).catch(() => null);
            previousTarget = old?.definition.target ?? current.source.target;
            const blocked = await new Journal(this.records, () => new Date()).blockers(id, previousTarget, new URL(current.source.endpoint).origin, current.source.resources);
            if (blocked.length)
                throw new Error(`执行器身份或资源仍被作业 ${blocked.join('、')} 占用；先 circle-hub job dispose ${blocked[0]} … 完成具名处置`);
        }
        let migration: SecretWrite | undefined;
        const name = source.credential ? secretNameOf(source.credential) : null;
        if (!current.source.credential && name) {
            if (current.source.endpoint !== source.endpoint || current.source.ca !== source.ca)
                throw new Error('迁移密钥与修改 endpoint、ca 须分开做；改地址后要重新输入密钥');
            const value = await this.records.vault.getText(`executor.${id}.bearer`);
            if (value !== null) {
                const previous = (await this.records.variables.list(by)).find(v => v.kind === 'secret' && v.name === name && v.definition);
                let consumers = [executorConsumer(source)];
                if (previous?.definition?.schema === 'secret@1') {
                    const old = await this.records.vault.getText(previous.definition.entry);
                    if (previous.definition.digest_rule !== 'plain' || old !== value)
                        throw new Error('旧执行器密钥与已有名字的值或规则不同：请换一个名字');
                    consumers = [...previous.definition.consumers.filter(c => c.definition !== id || c.item !== 'credential'), executorConsumer(source)];
                }
                migration = { name, value, short: true, consumers };
            }
        }
        const result = await this.configure(by, source, migration, { digest: current.digest, source: current.source, target: previousTarget, rebind });
        try {
            if (source.credential) {
                await this.records.vault.remove(`executor.${id}.bearer`);
                const name = secretNameOf(source.credential)!;
                await this.records.variables.cleanupSecret(name);
            }
        }
        catch {
            throw new Error(`执行器新定义${migration?'与迁移密钥决定':''}已提交，旧条目清理未完成；修复密钥库权限后重跑同一 executor update 清理，不重新输入值`);
        }
        return result;
    }
    async disable(by: Principal, id: string) { await this.admin(by); const current = await this.readSource(id); if (!current)
        throw new Error('执行器对你不可用'); return this.configure(by, { ...current.source, enabled: false }, undefined, { digest: current.digest, source: current.source, target: current.source.target, rebind: false }); }
    async readSource(id: string): Promise<{
        id: string;
        digest: string;
        source: ExecutorSource;
    } | null> {
        if (!/^exe_[0-9a-hjkmnp-tv-z]{26}$/.test(id))
            return null;
        const auth = await this.records.authorizations.resourceConfig(`executor.${id}`);
        if (!auth?.body.bound)
            return null;
        const bytes = await this.records.objects.get(auth.body.bound);
        if (!bytes)
            throw new Error('执行器源定义字节缺失');
        const source = this.validate(JSON.parse(Buffer.from(bytes).toString()));
        if (source.id !== id)
            throw new Error('执行器源定义身份不符');
        return { id, digest: auth.body.bound, source };
    }
    async get(id: string, snapshot?: VariableSnapshot): Promise<RegisteredExecutor | null> { const current = await this.readSource(id); if (!current)
        return null; const resolved = await resolveExecutor(this.records, current.source, snapshot); return { ...current, ...resolved, resolved_digest: sha256Hex(canonicalBytes(resolved.definition)) }; }
    async sources(by: Principal) {await this.admin(by);return this.internalSources();}
    private async internalSources() { const ids = new Set<string>(); let cursor: string | null = null; do {
        const page = await this.records.authorizations.history({ permission: 'resource_config', limit: 500, cursor });
        for (const r of page.items)
            if (r.body.object.startsWith('executor.'))
                ids.add(r.body.object.slice(9));
        cursor = page.next;
    } while (cursor); const entries = await Promise.all([...ids].sort().map(id => this.readSource(id))); return entries.filter((e): e is NonNullable<typeof e> => e !== null); }
    /** Internal start_run snapshot; no secret value is loaded and no caller privileges are borrowed. */
    async snapshot(variables:VariableSnapshot):Promise<string> {
      const entries:Record<string,string>={};
      for(const source of await this.internalSources()) {
        const resolved=await this.get(source.id,variables);
        if(!resolved)throw new Error('执行器登记在取快照时改变；请管理员核对配置后重开运行');
        const object=await this.records.objects.put(canonicalBytes(resolved.definition),'application/json');
        if(object.sha256!==resolved.resolved_digest)throw new Error('执行器规范摘要不一致；请管理员检查对象库后重开运行');
        entries[resolved.id]=object.sha256;
      }
      return (await this.records.objects.put(canonicalBytes(entries),'application/json')).sha256;
    }
    async list(by: Principal): Promise<RegisteredExecutor[]> { const sources = await this.sources(by); const entries = await Promise.all(sources.map(e => this.get(e.id))); return entries.filter((e): e is RegisteredExecutor => e !== null); }
    async material(id: string, definition: ExecutorDefinition) { const current = await this.readSource(id); if (!current?.source.enabled)
        throw new ExecutorAccessError('执行器已禁用或不可用；未发请求', '管理员核对源定义并用 executor update 启用后重做原操作'); const name = definition.credential ? secretNameOf(definition.credential) : null; if (!name)
        throw new ExecutorCredentialError(id); try {
        const [m] = await this.records.variables.readSecrets([{ name, consumer: executorConsumer({ ...definition, id }) }]);
        if (m.metadata.digest_rule !== 'plain')
            throw new ExecutorCredentialError(id,name,`密钥 ${name} 当前登记只存摘要；执行器需要原值，未发请求`);
        return m;
    }
    catch (error) {
        if (error instanceof VariableError)
            throw new ExecutorCredentialError(id,name,error.message);
        throw error;
    } }
    private validate(input: unknown): ExecutorSource { let parsed; try {
        checkedReferences(input);
        parsed = ExecutorSource.safeParse(input);
    }
    catch(error) {
        if(error instanceof VariableInputError)throw new Error(error.message);
        throw new Error('执行器源定义无效；核对结构和引用的位置');
    } if (!parsed.success)
        throw new Error('执行器源定义无效：核对端点、固定 CA、引用位置、调用和必需字段'); let bytes: Uint8Array; try {
        bytes = canonicalBytes(maskReferences(parsed.data, () => null));
    }
    catch {
        throw new Error('执行器源定义不是可规范化的 JSON；核对结构和取值');
    } if (scanForCredentials(bytes).findings.length)
        throw new Error('执行器定义不能含凭据原文；请使用 credential 密钥引用'); return structuredClone(parsed.data); }
    private async configure(by: Principal, source: ExecutorSource, migration?: SecretWrite, guard?: UpdateGuard): Promise<RegisteredExecutor> {
        for (const m of await this.records.variables.recentSecrets())
            if (containsSecret(source, m.value))
                throw new Error('执行器定义不能含任何当前或上一版密钥的原文');
        const snapshot = await this.records.variables.snapshot(), resolved = await resolveExecutor(this.records, source, snapshot);
        for (const m of await this.records.variables.recentSecrets())
            if (containsSecret(resolved.definition, m.value))
                throw new Error('解析后的执行器定义不能包含任何当前或上一版密钥的原文');
        const stored = await this.records.objects.put(canonicalBytes(source), 'application/json');
        const pinned = await this.records.objects.put(canonicalBytes(resolved.definition), 'application/json');
        const expected = migration ? (await this.records.authorizations.resourceConfig('secret:' + migration.name))?.digest ?? null : null;
        const prepared = migration ? await this.records.variables.prepareSecrets(by, [migration], `从执行器 ${source.id} 迁移来`) : undefined;
        await this.records.store.withTransaction(async (tx) => {
            await lockExecutorConfiguration(this.records.store, tx, source.id!, [...source.resources, ...(guard?.source.resources ?? [])], [resolved.definition.target, ...(guard ? [guard.target] : [])], [new URL(source.endpoint).origin, ...(guard ? [new URL(guard.source.endpoint).origin] : [])]);
            if (guard) {
                const current = await this.records.store.find<AuthorizationRecord['body']>({ key: 'authz.key', value: `resource_config|${WHOLE_HUB}|executor.${source.id}`, kind: 'authorization', newestFirst: true, limit: 1 }, tx);
                if (current.items[0]?.body.revoked || current.items[0]?.body.bound !== guard.digest)
                    throw new Error('执行器定义在更新期间已变；请按当前源定义重做 update');
                if (guard.rebind)
                    await assertUnused(this.records.store, tx, source.id!, guard);
            }
            const refs = referencesIn(source);
            await this.records.variables.lockNames(refs.map(r => r.name), tx);
            for (const ref of refs.filter(r => r.kind === 'var')) {
                const rows = await this.records.store.find<AuthorizationRecord['body']>({ key: 'authz.key', value: `resource_config|${WHOLE_HUB}|var:${ref.name}`, kind: 'authorization', newestFirst: true, limit: 1 }, tx);
                if (rows.items[0]?.body.revoked || rows.items[0]?.digest !== snapshot.get(ref.name))
                    throw new Error('引用的变量在配置时已变；请先 var set 后重做 executor update');
            }
            if (migration) {
                const rows = await this.records.store.find<AuthorizationRecord['body']>({ key: 'authz.key', value: `resource_config|${WHOLE_HUB}|secret:${migration.name}`, kind: 'authorization', newestFirst: true, limit: 1 }, tx);
                if ((rows.items[0] && !rows.items[0].body.revoked ? rows.items[0].digest : null) !== expected)
                    throw new Error('迁移期间密钥已变；核对后重新 update');
            }
            if (prepared)
                await this.records.variables.commitSecrets(by, prepared, tx);
            await this.records.authorizations.configureResourceInTransaction(by, 'executor.' + source.id, stored.sha256, '执行器定义配置', tx);
        });
        return { id: source.id!, digest: stored.sha256, source, ...resolved, resolved_digest: pinned.sha256 };
    }
}
export function containsSecret(value: unknown, secret: string): boolean { if (typeof value === 'string')
    return secret.length >= 8 ? value.includes(secret) : value === secret; if (Array.isArray(value))
    return value.some(v => containsSecret(v, secret)); if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => (secret.length >= 8 ? k.includes(secret) : k === secret) || containsSecret(v, secret)); return false; }
