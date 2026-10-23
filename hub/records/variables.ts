// Named deployment versions use existing resource-configuration decisions and the vault, never a new table.
import { randomBytes, createHash } from 'node:crypto';
import { OrdinaryVariableName, VariableName, VariableRecord, SecretRecord, VariableValue, validateSecret, referencesIn, resolve as resolveValue, type SecretConsumer, type VariableUse } from '../../contracts/src/variables.ts';
import { isDigestRule, type DigestRule, type VariableKind, type PermissionKind } from '../../contracts/generated/vocabulary.ts';
import type { Principal, Principals, RecordStore, ObjectStore, Vault, Authorizations, AuthorizationRecord, Transaction, Page } from './api.ts';
import { canonicalBytes, canonicalize } from './canonical.ts';
import { parseStrictJson } from './strict-json.ts';
import { scanForCredentials } from './scan.ts';
import { AccessError, IntegrityError } from './errors.ts';
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
    definition: VariableRecord | SecretRecord | null;
}
export type VariableSnapshot = ReadonlyMap<string, string>;
export interface SecretWrite {
    name: string;
    value: string;
    digest_rule?: DigestRule;
    short?: boolean;
    consumers: SecretConsumer[];
    alreadyStored?: boolean;
}
export interface PreparedSecrets {
    readonly items: ReadonlyArray<{
        name: string;
        metadata: SecretRecord;
        bound: string;
    }>;
    readonly reason: string;
}
export interface VariableWriteOptions {
    names?: readonly string[];
    notSecret?: boolean;
    validate?: (tx: Transaction) => Promise<void>;
}
export interface SecretMaterial {
    name: string;
    version: number;
    decision: string;
    metadata: SecretRecord;
    value: string;
}
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
    readonly #prepared = new WeakSet<object>();
    constructor(ports: VariablePorts) { this.#p = ports; this.#now = ports.now ?? (() => new Date()); }
    async assertAdmin(by: Principal) { const actual = await this.#p.principals.get(by.id); if (!actual || actual.disabled || actual.role !== 'admin')
        throw new AccessError('只有管理员可以设置或查看变量与密钥'); }
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
    async #definition(decision: AuthorizationRecord, kind: VariableKind, name: string) {
        if (decision.body.revoked)
            return null;
        if (!decision.body.bound)
            throw new IntegrityError('变量决定缺少绑定内容');
        const bytes = await this.#p.objects.get(decision.body.bound);
        if (!bytes)
            throw new IntegrityError('变量决定绑定的对象不可读');
        const parsed = (kind === 'var' ? VariableRecord : SecretRecord).safeParse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
        if (!parsed.success || parsed.data.name !== name)
            throw new IntegrityError('变量决定的绑定内容不合记录模式');
        return parsed.data;
    }
    async #version(kind: VariableKind, name: string, decision: AuthorizationRecord, history?: AuthorizationRecord[], known?: VariableRecord | SecretRecord | null): Promise<NamedVersion> { const rows = history ?? await this.#history(kind, name); const at = rows.findIndex(row => row.digest === decision.digest); if (at < 0)
        throw new IntegrityError('变量决定不在它的历史链里'); return { kind, name, version: rows.slice(at).filter(row => !row.body.revoked).length, decision, definition: known === undefined ? await this.#definition(decision, kind, name) : known }; }
    async #kindFree(name: string, kind: VariableKind, tx: Transaction) { if ((await this.#history(kind === 'var' ? 'secret' : 'var', name, tx)).length)
        throw new VariableError('名字已经属于另一种；撤回也不改变名字的种类，请换一个名字并更新引用定义后重做', name); }
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
        const object = await this.#p.objects.put(canonicalBytes(definition), 'application/json');
        return this.#p.store.withTransaction(async (tx) => {
            await this.lockNames([name, ...(options.names ?? [])], tx);
            await this.#kindFree(name, 'var', tx);
            await options.validate?.(tx);
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

        const validated = input.map((v, index) => {
            const name = this.#name(v.name, 'secret');
            const raw = validateSecret(v.value, v.short);
            const rule = v.digest_rule ?? 'plain';
            if (!isDigestRule(rule))
                throw new VariableError(`第 ${index + 1} 个摘要规则不合生成词表`);
            const stored = rule === 'sha512_base64' && !v.alreadyStored ? createHash('sha512').update(raw).digest('base64') : raw;
            const metadata = SecretRecord.safeParse({ schema: 'secret@1', name, entry: `secret.${name.toLowerCase()}.${randomBytes(12).toString('hex')}`, digest_rule: rule, length: [...stored].length, consumers: v.consumers });
            if (!metadata.success)
                throw new VariableError(`第 ${index + 1} 个密钥缺少有效的使用者、地址绑定或说明`);
            return { name, stored, metadata: metadata.data };
        });
        const note = validateChangeReason(reason, [...input.map(v => v.value), ...validated.map(v => v.stored)]);
        const items = [];
        for (const v of validated) {
            await this.#p.vault.put(v.metadata.entry, v.stored);
            const object = await this.#p.objects.put(canonicalBytes(v.metadata), 'application/json');
            items.push({ name: v.name, metadata: v.metadata, bound: object.sha256 });
        }
        const result = { items, reason: note };
        this.#prepared.add(result);
        return result;
    }
    async commitSecrets(by: Principal, prepared: PreparedSecrets, tx: Transaction, validate?: (tx: Transaction) => Promise<void>): Promise<NamedVersion[]> {
        if (!this.#prepared.has(prepared))
            throw new VariableError('密钥准备结果不是本次可信输入；请重新设置');
        this.#prepared.delete(prepared);
        await this.lockNames(prepared.items.map(v => v.name), tx);
        for (const item of prepared.items)
            await this.#kindFree(item.name, 'secret', tx);
        await validate?.(tx);
        const out = [];
        for (const item of prepared.items) {
            const history = await this.#history('secret', item.name, tx);
            const decision = await this.#p.authorizations.configureResourceInTransaction(by, 'secret:' + item.name, item.bound, prepared.reason, tx);
            out.push(await this.#version('secret', item.name, decision, [decision, ...history], item.metadata));
        }
        return out;
    }
    async setSecrets(by: Principal, input: readonly SecretWrite[], reason: string, validate?: (tx: Transaction) => Promise<void>): Promise<NamedVersion[]> { const prepared = await this.prepareSecrets(by, input, reason); const out = await this.#p.store.withTransaction(tx => this.commitSecrets(by, prepared, tx, validate)); for (const item of input)
        await this.cleanupSecret(item.name); return out; }
    async unset(by: Principal, kind: VariableKind, name: string, reason: string, validate?: (tx: Transaction) => Promise<void>): Promise<NamedVersion> {
        await this.assertAdmin(by);
        name = this.#name(name, kind);
        const note = validateChangeReason(reason);
        let withdrawn:AuthorizationRecord[]=[];
        const result = await this.#p.store.withTransaction(async (tx) => { await this.lockNames([name], tx); await this.#kindFree(name, kind, tx); await validate?.(tx); const history = await this.#history(kind, name, tx); if (!history.length)
            throw new VariableError('名字没有设置决定；请核对名字'); withdrawn=history; const decision = await this.#p.authorizations.configureResourceInTransaction(by, kind + ':' + name, null, note, tx, true); return this.#version(kind, name, decision, [decision, ...history]); });
        if(kind==='secret')try {
            // Only decisions preceding this revocation authorize deletion. A later prepared or committed version survives.
            for(const row of withdrawn.filter(row=>!row.body.revoked)) {
                const metadata=await this.#definition(row,'secret',name);
                if(metadata?.schema!=='secret@1')throw new IntegrityError('密钥历史定义不可核对');
                await this.#p.vault.remove(metadata.entry);
            }
        }catch {throw new VariableError(`撤回决定 rec:${result.decision.digest} 已生效，历史原件或密钥条目清理未完成；管理员修复原件与密钥库后重跑 secret unset --name ${name}`,name);}
        return result;
    }
    async history(by: Principal, kind: VariableKind, name: string): Promise<NamedVersion[]> { await this.assertAdmin(by); name = this.#name(name, kind); const rows = await this.#history(kind, name); return Promise.all(rows.map(row => this.#version(kind, name, row, rows))); }
    async list(by: Principal): Promise<NamedVersion[]> {
        await this.assertAdmin(by);
        const latest = new Map<string, AuthorizationRecord>();
        let cursor: string | null = null;
        do {
            const page: Page<AuthorizationRecord> = await this.#p.authorizations.history({ permission: CONFIG, subject: WHOLE_HUB, limit: 500, cursor, newestFirst: true });
            for (const row of page.items)
                if ((row.body.object.startsWith('var:') || row.body.object.startsWith('secret:')) && !latest.has(row.body.object))
                    latest.set(row.body.object, row);
            cursor = page.next;
        } while (cursor);
        return Promise.all([...latest].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => this.#version(key.startsWith('var:') ? 'var' : 'secret', key.slice(key.indexOf(':') + 1), row)));
    }
    async snapshot(): Promise<VariableSnapshot> {
        const prefix = CONFIG + '|' + WHOLE_HUB + '|var:';
        const rows = await this.#p.database.query(`SELECT DISTINCT ON (i.value) r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body FROM record_index i JOIN records r ON r.digest=i.digest WHERE i.key='authz.key' AND left(i.value,length($1))=$1 AND r.kind='authorization' ORDER BY i.value,i.record_seq DESC`, [prefix]);
        const out = new Map<string, string>();
        for (const raw of rows.rows) {
            const row = verifiedRecord<AuthorizationRecord['body']>(raw);
            if (row.body.permission === CONFIG && row.body.subject === WHOLE_HUB && row.body.object.startsWith('var:') && !row.body.revoked)
                out.set(row.body.object.slice(4), row.digest);
        }
        return out;
    }
    async valueAt(name: string, decision: string): Promise<unknown> { name = this.#name(name, 'var'); const row = await this.#p.store.get<AuthorizationRecord['body']>(decision); if (!row || row.kind !== 'authorization' || row.body.permission !== CONFIG || row.body.subject !== WHOLE_HUB || row.body.object !== 'var:' + name || row.body.revoked)
        throw new VariableError('变量版本不可用；请先 circle-hub var set <名字>', name); return (await this.#definition(row, 'var', name) as VariableRecord).value; }
    async resolveVariables(value: unknown, at: string, snapshot?: VariableSnapshot): Promise<{
        value: unknown;
        uses: VariableUse[];
    }> { const refs = referencesIn(value); const frozen = snapshot ?? await this.snapshot(); const values = new Map<string, unknown>(), uses: VariableUse[] = []; for (const ref of refs) {
        if (ref.kind !== 'var')
            throw new VariableError('这里只能引用普通变量，密钥只许用于凭据项');
        const decision = frozen.get(ref.name);
        if (!decision)
            throw new VariableError(snapshot ? `本次变量快照缺少 ${ref.name} 的决定：先确认 circle-hub var set ${ref.name}，再重开运行或同步` : `变量 ${ref.name} 没有设置：先 circle-hub var set ${ref.name}`, ref.name);
        values.set(ref.name, await this.valueAt(ref.name, decision));
        uses.push({ at: at + '#' + ref.at, name: ref.name, decision });
    } return { value: resolveValue(value, (_kind, name) => values.get(name)), uses }; }
    async readSecrets(requests: readonly {
        name: string;
        consumer: SecretConsumer;
    }[]): Promise<SecretMaterial[]> {
        const names = [...new Set(requests.map(r => this.#name(r.name, 'secret')))];
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await this.#p.authorizations.resourceConfigs(names.map(name => 'secret:' + name));
            const out: SecretMaterial[] = [];
            let missing: string | undefined;
            for (const request of requests) {
                const decision = current.get('secret:' + request.name);
                if (!decision)
                    throw this.#secretUnavailable(request.name,'没有当前有效的密钥设置');
                const version = await this.#version('secret', request.name, decision);
                const metadata = version.definition as SecretRecord;
                if (!metadata.consumers.some(c => canonicalize(c) === canonicalize(request.consumer))) {
                    const sameItem=metadata.consumers.some(c=>c.definition===request.consumer.definition&&c.item===request.consumer.item);
                    throw this.#secretUnavailable(request.name,sameItem?`第 ${version.version} 版为 ${request.consumer.definition}/${request.consumer.item} 登记的发送地址与当前定义不等`:`第 ${version.version} 版未登记使用者 ${request.consumer.definition}/${request.consumer.item}`);
                }
                const value = await this.#p.vault.getText(metadata.entry);
                if (value === null) {
                    missing = request.name;
                    break;
                }
                if ([...value].length !== metadata.length)
                    throw this.#secretUnavailable(request.name,`条目长度与第 ${version.version} 版的登记不等`);
                out.push({ name: request.name, version: version.version, decision: decision.digest, metadata, value });
            }
            if (!missing)
                return out;
            if (attempt)
                throw this.#secretUnavailable(missing,'当前登记条目在密钥库中不存在');
        }
        throw new VariableError('密钥读取未完成；请重新设置后重读');
    }
    #secretUnavailable(name:string,fact:string){return new VariableError(`密钥 ${name} ${fact}；请 circle-hub secret set --name ${name}`,name);}
    async recentSecrets(): Promise<SecretMaterial[]> { const out: SecretMaterial[] = []; let cursor: string | null = null; const grouped = new Map<string, AuthorizationRecord[]>(); do {
        const page: Page<AuthorizationRecord> = await this.#p.store.find<AuthorizationRecord['body']>({ key: 'authz.permission', value: CONFIG, kind: 'authorization', limit: 500, cursor, newestFirst: true });
        for (const row of page.items)
            if (row.body.object.startsWith('secret:')) {
                const rows = grouped.get(row.body.object) ?? [];
                if (!row.body.revoked && rows.length < 2) {
                    rows.push(row);
                    grouped.set(row.body.object, rows);
                }
            }
        cursor = page.next;
    } while (cursor); for (const [key, rows] of grouped)
        for (const row of rows) {
            const version = await this.#version('secret', key.slice(7), row);
            const metadata = version.definition as SecretRecord;
            const value = await this.#p.vault.getText(metadata.entry);
            if (value !== null && [...value].length === metadata.length)
                out.push({ name: version.name, version: version.version, decision: row.digest, metadata, value });
        } return out; }
    async cleanupSecret(name: string): Promise<void> { this.#name(name, 'secret'); const history = await this.#history('secret', name), grants = history.filter(row => !row.body.revoked); const referenced = new Set<string>(), keep = new Set<string>(); for (const [index, row] of grants.entries()) {
        const metadata = await this.#definition(row, 'secret', name) as SecretRecord;
        referenced.add(metadata.entry);
        if (index < 2)
            keep.add(metadata.entry);
    } for (const entry of await this.#p.vault.list())
        if (entry.startsWith('secret.' + name.toLowerCase() + '.') && !keep.has(entry)) {
            const info = await this.#p.vault.stat(entry);
            if (referenced.has(entry) || info && this.#now().getTime() - Date.parse(info.written_at) > 3600000)
                await this.#p.vault.remove(entry);
        } }
}
