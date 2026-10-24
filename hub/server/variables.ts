import { productVariableProblems, variableUsesOfRoot } from '../knowledge/api.ts';
import type { PackRegistry } from '../runs/api.ts';
// Administrator-only named deployment commands. Arguments never carry values and diagnostics never quote them.
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { OrdinaryVariableName, VariableName, secretLikeName, referencesIn, resolve as substitute, type SecretConsumer, type ValueReference, type VariableUse } from '../../contracts/src/variables.ts';
import { ResourceId, ResourceRecord } from '../../contracts/src/resources.ts';
import { RunId } from '../../contracts/src/common.ts';
import { labelOf, isDigestRule, type DigestRule, type VariableKind, type PermissionKind } from '../../contracts/generated/vocabulary.ts';
import { readProfile } from '../connectors/api.ts';
import type { PacksPort } from '../ports.ts';
import { ExecutorDefinition, ExecutorSource } from '../dispatch/api.ts';
import { canonicalize, digestOf, validateChangeReason, secretForms, isSha256, parseStrictJson, scanForCredentials, VariableError, type RecordsKit, type Principal, type Transaction, type NamedVersion, type AuthorizationRecord, type SecretWrite, type VariableSnapshot, WHOLE_HUB } from '../records/api.ts';
import { requireVaultKey } from './assemble/vault.ts';
import { readNamedEnvironment } from './assemble/env-file.ts';
import { readSecret, readSecrets } from './assemble/secret-input.ts';
import { CliError, UsageError } from './errors.ts';
export interface VariableCommandSession {
    ctx: {
        io: {
            cwd: string;
        };
    };
    hub(requireVaultKey?: boolean): Promise<{
        packs: PacksPort;
        registry: Pick<PackRegistry,'variableDeclarations'>;
    }>;
    options: {
        readSecret?: (label: string) => Promise<string>;
    };
    admin(): Promise<Principal>;
    records(): Promise<RecordsKit>;
    out(line: string): void;
    err(line: string): void;
}
export const VAR_USAGE = 'var set <名字> [--file <文件>] [--text] [--not-secret] --reason <理由> | unset <名字> --reason <理由> | list [--run <运行> | --root <根摘要>] | show <名字> [--history] [--value]';
export const NAMED_SECRET_USAGE = 'secret set --name <名字>… [--digest <名字>=sha512_base64] [--short <名字>] --reason <理由> | unset --name <名字> --reason <理由> | list | show --name <名字> [--history] | import --env-file <文件> --key <键>=<名字>… [--basic <用户键>:<口令键>=<名字>] [--digest <名字>=sha512_base64] [--short <名字>] --reason <理由> [--dry-run]';
const CONFIG = 'resource_config' satisfies PermissionKind;
export interface DeploymentDefinition {
    key: string;
    id: string;
    decision: string;
    kind: 'resource' | 'executor';
    body: Record<string, any>;
    references: ValueReference[];
}
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const objectName = (key: string): DeploymentDefinition['kind'] | null => ResourceId.safeParse(key).success ? 'resource' : /^executor\.exe_[0-9a-z]{26}$/.test(key) ? 'executor' : null;
export async function configurationRows(kit: RecordsKit, tx?: Transaction): Promise<Map<string, AuthorizationRecord>> {
    const latest = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
        const page: import('../records/api.ts').Page<AuthorizationRecord> = await kit.store.find<AuthorizationRecord['body']>({ key: 'authz.permission', value: CONFIG, kind: 'authorization', newestFirst: true, limit: 500, cursor }, tx);
        for (const row of page.items)
            if (row.body.subject === WHOLE_HUB && objectName(row.body.object) && !latest.has(row.body.object))
                latest.set(row.body.object, row);
        cursor = page.next;
    } while (cursor);
    return new Map([...latest].filter(([, row]) => !row.body.revoked));
}
export async function deploymentDefinitions(kit: RecordsKit, tx?: Transaction): Promise<DeploymentDefinition[]> {
    const out = [];
    for (const [key, row] of await configurationRows(kit, tx)) {
        if (!row.body.bound)
            continue;
        const bytes = await kit.objects.get(row.body.bound);
        if (!bytes)
            throw new CliError('部署定义原件缺失；请管理员从可信备份恢复后重跑');
        const body = parseStrictJson(Buffer.from(bytes).toString('utf8'));
        if (!record(body))
            throw new CliError('部署定义形状不可读；请管理员重新登记');
        const kind = objectName(key)!;
        let refs: ValueReference[];
        try {
            refs = referencesIn(body);
        }
        catch {
            throw new CliError(`部署定义 ${kind === 'executor' ? key.slice(9) : key} 的引用写法无效；请先 update 改正定义`);
        }
        out.push({ key, id: kind === 'executor' ? key.slice(9) : key, kind, decision: row.digest, body, references: refs });
    }
    return out;
}
export function sendsTo(definition: DeploymentDefinition): string { return definition.kind === 'resource' ? digestOf({ origins: definition.body.origins, allow_plaintext: [...(definition.body.allow_plaintext ?? [])].sort() }) : digestOf({ endpoint: definition.body.endpoint, ca: definition.body.ca }); }
export function consumersOf(definitions: readonly DeploymentDefinition[], name: string): Array<SecretConsumer & {
    required: DigestRule;
    basic: boolean;
}> {
    const out: Array<SecretConsumer & {
        required: DigestRule;
        basic: boolean;
    }> = [];
    for (const definition of definitions.filter(v => v.body.enabled !== false))
        for (const ref of definition.references)
            if (ref.kind === 'secret' && ref.name === name) {
                if (definition.kind === 'executor' && ref.at === '/credential')
                    out.push({ definition: definition.id, item: 'credential', sends_to: sendsTo(definition), required: 'plain', basic: false });
                else if (definition.kind === 'resource' && ref.at.startsWith('/credentials/')) {
                    const item = ref.at.slice(13).replaceAll('~1', '/').replaceAll('~0', '~');
                    const rule = definition.body.credential_digests?.[item];
                    if (!isDigestRule(rule))
                        throw new CliError('资源凭据项缺少生成的摘要规则；请管理员 update 改正');
                    out.push({ definition: definition.id, item, sends_to: sendsTo(definition), required: rule, basic: false });
                }
            }
    return out;
}
const publicConsumer = ({ definition, item, sends_to }: SecretConsumer) => ({ definition, item, sends_to });
export async function unchangedDefinitions(kit: RecordsKit, definitions: readonly DeploymentDefinition[], tx: Transaction): Promise<void> {
    const current = await configurationRows(kit, tx);
    if (current.size !== definitions.length || definitions.some(def => current.get(def.key)?.digest !== def.decision))
        throw new CliError('部署定义在核对期间已改变；请按当前定义重跑命令，没有写入决定');
}
function nameInput(input: unknown, index: number, kind: VariableKind): string {
    const parsed = VariableName.safeParse(input);
    if (!parsed.success)
        throw new UsageError(`第 ${index + 1} 个名字：${parsed.error.issues[0].message}`);
    if (scanForCredentials(Buffer.from(parsed.data)).findings.length)
        throw new UsageError(`第 ${index + 1} 个名字像凭据值；不要把值写成名字，密钥只从标准输入读`);
    if (kind === 'var' && secretLikeName(parsed.data))
        throw new UsageError(`第 ${index + 1} 个名字像密钥；请用 circle-hub secret set --name <名字>`);
    return parsed.data;
}
function parse(argv: readonly string[], options: Record<string, any>): {
    values: Record<string, any>;
    positionals: string[];
} {
    try {
        return parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    }
    catch {
        throw new UsageError('参数写法无效；请核对旗标和值，敏感值只从标准输入读');
    }
}
function reasonInput(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || [...value].length > 500 || scanForCredentials(Buffer.from(value)).findings.length)
        throw new UsageError('理由必填、至多 500 字符且不能含凭据；请重写 --reason');
    return value;
}
/** An exact JSON grammar supplies error positions without inspecting native human error strings. */
export function parseVariableJson(text: string): unknown {
    let at = 0;
    const fail = (position = at): never => { position = Math.min(position, text.length); const before = text.slice(0, position), line = before.split('\n').length, column = position - (before.lastIndexOf('\n') + 1) + 1; throw new UsageError(`第 ${line} 行第 ${column} 列 JSON 不合式；请修正后重跑`); };
    const space = () => {
        while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length)
            at++;
    };
    const string = (): string => {
        const start = at;
        if (text[at] !== '"')
            return fail();
        at++;
        while (at < text.length) {
            const ch = text[at++];
            if (ch === '"')
                return JSON.parse(text.slice(start, at));
            if (ch === '\\') {
                const esc = text[at++];
                if (esc === 'u') {
                    if (!/^[a-f0-9]{4}$/i.test(text.slice(at, at + 4)))
                        return fail();
                    at += 4;
                }
                else if (!esc || !'"\\/bfnrt'.includes(esc))
                    return fail();
            }
            else if (ch.charCodeAt(0) < 32)
                return fail();
        }
        return fail();
    };
    const value = (depth: number): void => {
        if (depth > 1024)
            return fail();
        space();
        const ch = text[at];
        if (ch === '"') {
            string();
            return;
        }
        if (ch === '{' || ch === '[') {
            at++;
            space();
            const close = ch === '{' ? '}' : ']';
            if (text[at] === close) {
                at++;
                return;
            }
            const keys = new Set<string>();
            for (;;) {
                if (ch === '{') {
                    space();
                    const key = string();
                    if (keys.has(key))
                        return fail();
                    keys.add(key);
                    space();
                    if (text[at] !== ':')
                        return fail();
                    at++;
                }
                value(depth + 1);
                space();
                if (text[at] === close) {
                    at++;
                    return;
                }
                if (text[at] !== ',')
                    return fail();
                at++;
                space();
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
        if (!token)
            return fail();
        at += token[0].length;
    };
    value(0);
    space();
    if (at !== text.length)
        fail();
    return parseStrictJson(text);
}
async function variableText(s: VariableCommandSession, file: unknown): Promise<string> {
    if (file !== undefined) {
        let bytes: Buffer;
        try {
            bytes = await readFile(resolvePath(s.ctx.io.cwd, String(file)));
        }
        catch {
            throw new CliError('变量值文件不可读；请核对指定文件与权限后重跑');
        }
        if (bytes.length > 65536)
            throw new UsageError('变量输入超过 64 KiB；请缩小值后重跑');
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw new UsageError('变量输入不是 UTF-8；请重新保存文件后重跑');
        }
    }
    return (s.options.readSecret ?? readSecret)('普通变量的 JSON 值');
}
function versionsLine(v: NamedVersion): string { return `${v.name}；${labelOf('variable_kind', v.kind)}；第 ${v.version} 版；${v.decision.body.revoked ? '已撤回' : '已设置'}；长度 ${v.definition?.schema === 'secret@1' ? v.definition.length : v.definition ? Buffer.byteLength(canonicalize(v.definition.value)) : 0}；决定人 ${v.decision.body.decided_by}；时刻 ${v.decision.body.decided_at}；理由 ${v.decision.body.note ?? ''}`; }
function hiddenPointer(pointer: string, value: string): string { return pointer.split('/').map(part => value.length >= 8 && part.includes(value) ? '<字段>' : part).join('/'); }
function findPlain(value: unknown, secret: string, path = ''): string | null {
    if (typeof value === 'string')
        return value.includes(secret) ? path : null;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const found = findPlain(value[i], secret, path + '/' + i);
            if (found !== null)
                return found;
        }
    }
    else if (record(value))
        for (const [key, child] of Object.entries(value)) {
            const at = path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
            if (key.includes(secret))
                return hiddenPointer(at, secret);
            const found = findPlain(child, secret, at);
            if (found !== null)
                return found;
        }
    return null;
}
async function checkPlainExposure(kit: RecordsKit, by: Principal, _definitions: readonly DeploymentDefinition[], input: readonly {
    value: string;
    derived?: boolean;
}[]) {
    const candidates = input.filter(v => [...v.value].length >= 8);
    if (!candidates.length)
        return;
    const ordinary = [];
    for (const version of (await kit.variables.list(by)).filter(v => v.kind === 'var'))
        for (const row of await kit.variables.history(by, 'var', version.name))
            if (row.definition?.schema === 'variable@1')
                ordinary.push({ name: version.name, value: row.definition.value });
    const definitions: Array<{
        id: string;
        decision: string;
        body: unknown;
    }> = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
        const page = await kit.authorizations.history({ permission: CONFIG, subject: WHOLE_HUB, limit: 500, cursor });
        for (const row of page.items) {
            const kind = objectName(row.body.object);
            if (!kind || row.body.revoked || !row.body.bound || seen.has(row.body.bound))
                continue;
            seen.add(row.body.bound);
            const bytes = await kit.objects.get(row.body.bound);
            if (!bytes)
                throw new CliError('部署定义 ' + row.body.object + ' 的历史原件缺失；请管理员从可信备份恢复后重跑');
            let body: unknown;
            try {
                body = parseStrictJson(Buffer.from(bytes).toString());
            }
            catch {
                throw new CliError('部署定义历史原件不可核对；请管理员从可信备份恢复后重跑');
            }
            definitions.push({ id: kind === 'executor' ? row.body.object.slice(9) : row.body.object, decision: row.digest, body });
        }
        cursor = page.next;
    } while (cursor);
    for (const candidate of candidates)
        for (const form of secretForms(candidate.value, { hashes: false })) {
            const what = candidate.derived ? '按凭据规则计算的发送值' : '这个值';
            const how = form === candidate.value ? '已经明文存在' : '的可还原写法已经存在';
            for (const variable of ordinary)
                if (findPlain(variable.value, form) !== null)
                    throw new CliError(`${what}${how}变量 ${variable.name}：先在签发方换掉它`);
            for (const definition of definitions) {
                const at = findPlain(definition.body, form);
                if (at !== null)
                    throw new CliError(`${what}${how}部署定义 ${definition.id}（历史决定 rec:${definition.decision}）#${hiddenPointer(at, form)}：先在签发方换掉它`);
            }
        }
}
export async function variableCommand(s: VariableCommandSession, args: readonly string[]): Promise<number> {
    const [sub, ...rest] = args;
    const parsed = parse(rest, { file: { type: 'string' }, text: { type: 'boolean' }, 'not-secret': { type: 'boolean' }, reason: { type: 'string' }, history: { type: 'boolean' }, value: { type: 'boolean' }, run: { type: 'string' }, root: { type: 'string' } });
    const v = parsed.values, p = parsed.positionals;
    if (sub === 'set' && p.length !== 1)
        throw new UsageError('值只从 --file 或标准输入读；var set 只接收一个名字');
    if (!['set', 'unset', 'list', 'show'].includes(sub ?? ''))
        throw new UsageError(VAR_USAGE);
    if (sub !== 'list' && p.length !== 1 || sub === 'list' && p.length !== 0 || v.run && v.root)
        throw new UsageError('变量子命令的参数数量或选项不合式');
    const name = sub === 'list' ? null : nameInput(p[0], 0, 'var');
    const by = await s.admin(), kit = await s.records();
    await kit.variables.assertAdmin(by);
    try {
        if (sub === 'set') {
            const reason = reasonInput(v.reason);
            let text = await variableText(s, v.file);
            if (v.text) {
                if (text.endsWith('\r\n'))
                    text = text.slice(0, -2);
                else if (text.endsWith('\n'))
                    text = text.slice(0, -1);
            }
            const value = v.text ? text : parseVariableJson(text);
            const registry=(await s.hub(false)).registry;
            const declarations=await registry.variableDeclarations();
            const productUsers=declarations.filter(p=>p.product.variables?.some(v=>v.name===name));
            const definitions = await deploymentDefinitions(kit), snapshot = await kit.variables.snapshot();
            const affected = definitions.filter(d => d.body.enabled !== false && d.references.some(r => r.kind === 'var' && r.name === name));
            const names = [...new Set([...affected.flatMap(d => d.references.filter(r => r.kind === 'var').map(r => r.name)),...productUsers.flatMap(p=>(p.product.variables??[]).map(v=>v.name))])];
            const values = new Map<string, unknown>();
            for (const refName of names)
                if (refName !== name) {
                    const decision = snapshot.get(refName);
                    if (!decision){
                        if(affected.some(d=>d.references.some(r=>r.name===refName)))throw new CliError(`变量 ${refName} 未设置：先 circle-hub var set ${refName}`);
                        continue;
                    }
                    values.set(refName, await kit.variables.valueAt(refName, decision));
                }
            values.set(name!, value);
            for(const user of productUsers){
              // Other unset declarations use their synthetic defaults only for this size check, never for a real sync.
              const candidate=new Map((user.product.variables??[]).map(v=>[v.name,values.has(v.name)?values.get(v.name):v.default]));
              const problems=productVariableProblems(user.product,candidate,undefined,name!);
              if(problems.length)throw new CliError(`包 ${user.pack}@${user.version}：${problems.join('；')}`);
            }
            for (const definition of affected) {
                if(definition.kind==='executor'&&!ExecutorSource.safeParse(definition.body).success)throw new CliError(`部署定义 ${definition.id} 的引用位置或调用绑定不合规则；期望值只能是字面值或整值变量，请先 executor update 修正后重做 var set`);
                const resolved = substitute(definition.body, (kind, n) => kind === 'secret' ? '${secret:' + n + '}' : values.get(n));
                const checked = definition.kind === 'resource' ? ResourceRecord.safeParse(resolved) : ExecutorDefinition.safeParse(resolved);
                if (!checked.success)
                    throw new CliError(`变量新值不合部署定义 ${definition.id} ${definition.references.filter(ref => ref.kind === 'var' && ref.name === name).map(ref => ref.at).join('、')} 的模式或大小上限；请按该定义期望改正后重跑`);
            }
            const result = await kit.variables.setVariable(by, name!, value, reason, { notSecret: v['not-secret'] === true, names, validate: async (tx) => {
                    await unchangedDefinitions(kit, definitions, tx);
                    const current=await registry.variableDeclarations(tx);
                    if(canonicalize(current.filter(p=>p.product.variables?.some(v=>v.name===name)))!==canonicalize(productUsers))throw new CliError('产品声明在核对期间改变；请重跑 var set，没有写入决定');
                    for (const n of names.filter(n => n !== name)) {
                        const page = await kit.store.find({ key: 'authz.key', value: `resource_config|${WHOLE_HUB}|var:${n}`, kind: 'authorization', newestFirst: true, limit: 1 }, tx);
                        if ((page.items[0]?.body as any)?.revoked ? snapshot.has(n) : page.items[0]?.digest !== snapshot.get(n))
                            throw new CliError('另一引用变量在核对期间改变；请重跑，没有写入决定');
                    }
                } });
            s.out(result.created ? `已设置变量 ${name}；第 ${result.value.version} 版` : `${name} 和第 ${result.value.version} 版相同`);
            return 0;
        }
        if (sub === 'unset') {
            const definitions = await deploymentDefinitions(kit);
            await kit.variables.unset(by, 'var', name!, reasonInput(v.reason), async (tx) => {
                await unchangedDefinitions(kit, definitions, tx);
                const used = definitions.filter(d => d.body.enabled !== false && d.references.some(r => r.kind === 'var' && r.name === name));
                if (used.length)
                    throw new CliError('变量仍被启用定义引用：' + used.map(v => v.id).join('、') + '；请先 update 移除引用');
            });
            s.out(`已撤回变量 ${name}`);
            return 0;
        }
        if (sub === 'show') {
            if (v.value)
                s.out('下面是变量的值，会留在终端记录里');
            const rows = await kit.variables.history(by, 'var', name!);
            for (const row of v.history ? rows : rows.slice(0, 1)) {
                s.out(versionsLine(row));
                if (v.value && row.definition?.schema === 'variable@1')
                    s.out(canonicalize(row.definition.value));
            }
            return 0;
        }
        if (v.run || v.root) {
            const uses: Array<VariableUse & {composition?:string}> = [];
            if (v.run) {
                if (!RunId.safeParse(v.run).success)
                    throw new UsageError('运行号不合式');
                for (const index of ['read.run', 'action.run']) {
                    let cursor: string | null = null;
                    do {
                        const page: import('../records/api.ts').Page<import('../records/api.ts').StoredRecord<any>> = await kit.store.find({ key: index, value: v.run as string, kind: 'action', limit: 500, cursor });
                        for (const row of page.items)
                            uses.push(...(Array.isArray(row.body.variables) ? row.body.variables : []), ...(Array.isArray(row.body.detail?.variables) ? row.body.detail.variables : []), ...(Array.isArray(row.body.detail?.binding?.variables) ? row.body.detail.binding.variables : []));
                        cursor = page.next;
                    } while (cursor);
                }
            }
            else {
                if (!isSha256(v.root))
                    throw new UsageError('根摘要不合式');
                const roots=await variableUsesOfRoot(kit.store,v.root);
                if(!roots.length)throw new CliError('找不到该根或组成记录；请核对同步回执里的摘要');
                uses.push(...roots.flatMap(root=>root.variables.map(use=>({...use,composition:root.composition}))));
            }
            for (const use of new Map(uses.map(use => [(use.composition??'')+'|'+use.at + '|' + use.decision, use])).values()) {
                const decision = await kit.store.get<any>(use.decision);
                const kind: VariableKind = decision?.body.object.startsWith('secret:') ? 'secret' : 'var';
                const version = (await kit.variables.history(by, kind, use.name)).find(v => v.decision.digest === use.decision);
                if (version)
                    s.out(`${use.at}；${use.name}；第 ${version.version} 版${use.composition?`；组成 ${use.composition}`:''}`);
            }
            if (!uses.length)
                s.out('这份记录没有变量版本记录；需要带变量记录的新运行或新组成后再查');
            return 0;
        }
        const definitions = await deploymentDefinitions(kit);
        const declarations=await (await s.hub(false)).registry.variableDeclarations();
        const items=(await kit.variables.list(by)).filter(v=>v.kind==='var');
        const byName=new Map(items.map(v=>[v.name,v]));
        const declaredNames=declarations.flatMap(p=>(p.product.variables??[]).map(v=>v.name));
        for(const name of [...new Set([...byName.keys(),...declaredNames])].sort()){
          const item=byName.get(name);
          const owners=declarations.filter(p=>p.product.variables?.some(v=>v.name===name));
          const used=definitions.flatMap(d=>d.references.filter(r=>r.name===name).map(r=>d.id+'#'+r.at));
          const notes=owners.map(p=>`包 ${p.pack}@${p.version}`);
          if(owners.length && (!item || item.decision.body.revoked || item.definition?.schema!=='variable@1')){
            s.out(`${name}；没设置：${notes.join('、')} 的真实同步会拒绝；下一步 circle-hub var set ${name} --file <JSON文件> --reason <理由>`);continue;
          }
          if(!item)continue;
          if(item.definition?.schema==='variable@1')for(const owner of owners){
            const candidate=new Map((owner.product.variables??[]).map(v=>{
              const current=byName.get(v.name);
              return [v.name,current?.definition?.schema==='variable@1'&&!current.decision.body.revoked?current.definition.value:v.default];
            }));
            const problems=productVariableProblems(owner.product,candidate,undefined,name);
            if(problems.length)notes.push(...problems.map(p=>`值不合包 ${owner.pack}：${p}；真实同步会拒绝`));
          }
          s.out(versionsLine(item)+'；'+(used.length||owners.length?'使用者 '+[...used,...notes].join('、'):'设置了，没有使用者'));
        }
        return 0;
    }
    catch (error) {
        if (error instanceof VariableError)
            throw new CliError(error.message);
        throw error;
    }
}
export async function namedSecretCommand(s: VariableCommandSession, args: readonly string[]): Promise<number> {
    const [sub, ...rest] = args;
    const parsed = parse(rest, { name: { type: 'string', multiple: true }, digest: { type: 'string', multiple: true }, short: { type: 'string', multiple: true }, reason: { type: 'string' }, history: { type: 'boolean' }, 'env-file': { type: 'string' }, key: { type: 'string', multiple: true }, basic: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } });
    const v = parsed.values;
    const allowed: Record<string, readonly string[]> = { set: ['name', 'digest', 'short', 'reason'], unset: ['name', 'reason'], show: ['name', 'history'], list: [], import: ['env-file', 'key', 'basic', 'digest', 'short', 'reason', 'dry-run'] };
    if (allowed[sub ?? ''] && Object.keys(v).some(key => !allowed[sub!].includes(key)))
        throw new UsageError('旗标不能用于这个密钥子命令；请核对用法');
    if (parsed.positionals.length)
        throw new UsageError('密钥只从标准输入读；旧写法先 resource update <资源> --credential <凭据项>=<密钥名> 迁移，再用 secret set --name <名字>');
    if (!['set', 'unset', 'list', 'show', 'import'].includes(sub ?? ''))
        throw new UsageError(NAMED_SECRET_USAGE);
    const by = await s.admin(), kit = await s.records();
    await kit.variables.assertAdmin(by);
    try {
        if (sub === 'list' || sub === 'show') {
            const rows = await kit.variables.list(by);
            const names = sub === 'show' ? (v.name ?? []).map((n: string, i: number) => nameInput(n, i, 'secret')) : null;
            if (names && names.length !== 1)
                throw new UsageError('secret show 须有一个 --name');
            const known = new Set<string>();
            for (const row of rows.filter(r => r.kind === 'secret' && (!names || names.includes(r.name)))) {
                const history = await kit.variables.history(by, 'secret', row.name);
                for (const item of history) {
                    if (item.definition?.schema === 'secret@1')
                        known.add(item.definition.entry);
                }
                for (const item of v.history ? history : [row]) {
                    s.out(versionsLine(item));
                    if (item.definition?.schema === 'secret@1') {
                        const exists = await kit.vault.has(item.definition.entry);
                        s.out(`摘要规则 ${labelOf('digest_rule', item.definition.digest_rule)}；使用者 ${item.definition.consumers.map(c => c.definition + '/' + c.item).join('、')}`);
                        if (!exists && !item.decision.body.revoked) {
                            const index = history.findIndex(row => row.decision.digest === item.decision.digest);
                            const revokedSince = history.slice(0, index).some(row => row.decision.body.revoked);
                            const retained = history.filter(row => !row.decision.body.revoked).slice(0, 2).some(row => row.decision.digest === item.decision.digest);
                            if (revokedSince)
                                s.out(`第 ${item.version} 版之后已有撤回决定；条目不在库中，历史登记保留`);
                            else if (!retained)
                                s.out(`第 ${item.version} 版已超出当前和上一版的保留范围；条目不在库中，历史登记保留`);
                            else
                                s.out(`登记了第 ${item.version} 版，密钥库里没有它的条目；下一步 circle-hub secret set --name ${item.name}`);
                        }
                    }
                }
            }
            if (sub === 'list') {
                const entries = await kit.vault.list();
                for (const entry of entries.filter(n => n.startsWith('connector.') && !n.endsWith('.session')))
                    s.out(`旧写法条目 ${entry}；用 resource update <资源> --credential <凭据项>=<密钥名> 迁移`);
                for (const entry of entries.filter(n => n.startsWith('executor.') && n.endsWith('.bearer')))
                    s.out(`旧写法条目 ${entry}；定义加 credential 后 executor update 迁移`);
                for (const entry of entries.filter(n => n.endsWith('.session') || n.startsWith('login-stop.')))
                    s.out('登录状态条目 ' + entry);
                for (const entry of entries.filter(n => n.startsWith('secret.') && !known.has(n)))
                    s.out('没有决定指向的条目 ' + entry);
            }
            return 0;
        }
        const mappings: Array<{
            name: string;
            keys: string[];
            basic: boolean;
        }> = [];
        if (sub === 'import') {
            let index = 0;
            for (const [basic, inputs] of [[false, v.key ?? []], [true, v.basic ?? []]] as const)
                for (const input of inputs as string[]) {
                    const at = input.indexOf('=');
                    const keys = input.slice(0, at).split(':');
                    if (at <= 0 || keys.length !== (basic ? 2 : 1) || keys.some(k => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || scanForCredentials(Buffer.from(k)).findings.length > 0))
                        throw new UsageError(`第 ${++index} 个映射格式无效；写成 键=名字 或 用户键:口令键=名字`);
                    mappings.push({ name: nameInput(input.slice(at + 1), index++, 'secret'), keys, basic });
                }
            if (!v['env-file'] || !mappings.length)
                throw new UsageError('secret import 须有 --env-file 和明确的 --key 或 --basic');
        }
        else
            for (const [index, name] of (v.name ?? []).entries())
                mappings.push({ name: nameInput(name, index, 'secret'), keys: [], basic: false });
        if (!mappings.length || new Set(mappings.map(v => v.name)).size !== mappings.length || sub === 'unset' && mappings.length !== 1)
            throw new UsageError('密钥名字缺少、重复或数量不合子命令；请逐项核对 --name');
        const reason = reasonInput(v.reason), definitions = await deploymentDefinitions(kit);
        if (sub === 'unset') {
            await kit.variables.unset(by, 'secret', mappings[0].name, reason);
            s.out(`已撤回密钥 ${mappings[0].name}；受影响使用者 ${consumersOf(definitions, mappings[0].name).map(v => v.definition).join('、')}`);
            s.out('下一步：在签发方吊销或换掉旧值；Hub 删掉条目只是自己不再用它，备份里还有');
            return 0;
        }
        const registry=(await s.hub(false)).registry;
        const checkProductNames=async(tx?:Transaction)=>{
          const declarations=await registry.variableDeclarations(tx);
          if(declarations.some(p=>p.product.variables?.some(v=>mappings.some(m=>m.name===v.name))))throw new CliError('名字不可用；换一个密钥名字并 update 使用者定义后重跑');
        };
        await checkProductNames();
        const digests = new Map<string, DigestRule>(), short = new Set<string>();
        for (const [index, input] of (v.digest ?? []).entries()) {
            const at = input.indexOf('='), name = nameInput(input.slice(0, at), index, 'secret'), rule = input.slice(at + 1);
            if (at <= 0 || !isDigestRule(rule) || rule !== 'sha512_base64' || digests.has(name) || !mappings.some(v => v.name === name))
                throw new UsageError(`第 ${index + 1} 个 --digest 不合规则；用 名字=sha512_base64 且不能重复`);
            digests.set(name, rule);
        }
        for (const [index, input] of (v.short ?? []).entries()) {
            const name = nameInput(input, index, 'secret');
            if (short.has(name) || !mappings.some(v => v.name === name))
                throw new UsageError('第 ' + (index + 1) + ' 个 --short 没有对应名字或重复');
            short.add(name);
        }
        const profileCache = new Map<string, boolean>();
        for (const mapping of mappings.filter(v => v.basic))
            for (const used of consumersOf(definitions, mapping.name)) {
                if (used.item === 'credential')
                    throw new CliError('Basic 只用于原样存整个 Authorization 头的凭据项');
                const definition = definitions.find(d => d.id === used.definition)!;
                const pack = await (await s.hub(false)).packs.pack(definition.body.system_pack);
                if (!pack || pack.kind !== 'system' || pack.digest !== definition.body.system_pack_digest)
                    throw new CliError('凭据使用者的系统包不可核对；请先 update 绑定可用系统包');
                const profile = await readProfile(pack);
                const auth = profile.auth;
                profileCache.set(used.definition + '/' + used.item, auth.kind === 'static_header' && auth.header.name.toLowerCase() === 'authorization' && auth.header.scheme === 'raw' && auth.credential === used.item && used.required === 'plain');
            }
        const consumers = mappings.map(mapping => {
            const used = consumersOf(definitions, mapping.name);
            if (!used.length)
                throw new CliError(`还没有部署定义引用这个名字：先在资源或执行器定义里写 \${secret:${mapping.name}}，再设置`);
            if (digests.get(mapping.name) === 'sha512_base64' && used.some(c => c.required === 'plain'))
                throw new CliError('有使用者需要原值，不能只存摘要；请给那一项换一个名字');
            if (mapping.basic) {
                const bad = used.find(c => profileCache.get(c.definition + '/' + c.item) !== true);
                if (bad) {
                    const definition = definitions.find(d => d.id === bad.definition)!;
                    throw new CliError(`Basic 只用于原样存整个 Authorization 头；资源 ${bad.definition} 的凭据项 ${bad.item}（系统包 ${String(definition.body.system_pack ?? '无')}）不合：按真实声明改用 --key，或给正确的原样 Authorization 凭据项换一个名字`);
                }
            }
            s.out(`密钥 ${mapping.name} 的本版使用者：${used.map(c => c.definition + '/' + c.item).join('、')}`);
            return used.map(publicConsumer);
        });
        if (!v['dry-run'])
            await requireVaultKey(kit, { command: true });
        let values: string[];
        let sourceSecrets: string[] = [];
        const basicPasswords: string[] = [];
        if (sub === 'import') {
            const keys = [...new Set(mappings.flatMap(v => v.keys))];
            const env = await readNamedEnvironment(resolvePath(s.ctx.io.cwd, v['env-file'] as string), keys);
            let bad = false;
            for (const key of keys) {
                const value = env.get(key);
                s.out(`${key}：${value === undefined ? '没有' : value === '' ? '是空的' : '找到，长度 ' + [...value].length}`);
                bad ||= value === undefined || value === '';
            }
            if (bad)
                throw new CliError('未写入任何密钥；请补齐点名键后先 --dry-run 核对');
            sourceSecrets = [...env.values()];
            values = mappings.map(mapping => {
                if (!mapping.basic)
                    return env.get(mapping.keys[0])!;
                const user = env.get(mapping.keys[0])!;
                if (user.includes(':'))
                    throw new CliError('Basic 用户名含冒号；请改用可用的账号');
                basicPasswords.push(env.get(mapping.keys[1])!);
                return 'Basic ' + Buffer.from(user + ':' + env.get(mapping.keys[1])!).toString('base64');
            });
        }
        else {
            values = [];
            if (s.options.readSecret) {
                for (const mapping of mappings)
                    values.push(await s.options.readSecret(mapping.name));
            }
            else
                values = await readSecrets(mappings.map(v => v.name));
        }
        const inputs: SecretWrite[] = mappings.map((mapping, index) => ({ name: mapping.name, value: values[index], consumers: consumers[index], digest_rule: digests.get(mapping.name), short: short.has(mapping.name) }));
        for (const input of inputs)
            validateSecretInput(input);
        const derivedValues = mappings.flatMap((mapping, i) => digests.get(mapping.name) === 'sha512_base64' || consumersOf(definitions, mapping.name).some(c => c.required === 'sha512_base64') ? [createHash('sha512').update(values[i]).digest('base64')] : []);
        validateChangeReason(reason, [...sourceSecrets, ...values, ...derivedValues]);
        await checkPlainExposure(kit, by, definitions, [...values.map(value => ({ value })), ...basicPasswords.map(value => ({ value })), ...derivedValues.map(value => ({ value, derived: true }))]);
        if (v['dry-run']) {
            for (const input of inputs) {
                s.out(`${input.name}：核对完成，未写入`);
            }
            return 0;
        }
        const result = await kit.variables.setSecrets(by, inputs, reason, async tx => {await unchangedDefinitions(kit, definitions, tx);await checkProductNames(tx);});
        for (const row of result) {
            s.out(versionsLine(row));
            if (row.definition?.schema === 'secret@1')
                s.out(`摘要规则 ${labelOf('digest_rule', row.definition.digest_rule)}；使用者 ${row.definition.consumers.map(c => c.definition + '/' + c.item).join('、')}`);
            if (short.has(row.name))
                s.out(`${row.name} 使用短值；这样的值脱敏器遮不住、也找不出回显`);
        }
        s.out('下一步：在签发方吊销或换掉旧值；Hub 删掉条目只是自己不再用它，备份里还有');
        return 0;
    }
    catch (error) {
        if (error instanceof VariableError)
            throw new CliError(error.message);
        throw error;
    }
}
function validateSecretInput(input: SecretWrite) {
    try {
        validateSecret(input.value, input.short);
    }
    catch {
        throw new CliError(`密钥 ${input.name} 的文本不合一行长度规则；短值需 --short <名字>`);
    }
}
import { validateSecret } from '../../contracts/src/variables.ts';

/** Never reveals whether a collision is a secret or a deployment consumer. Called with the name locked. */
export async function productVariableNameAvailable(kit: RecordsKit, name: string, tx: Transaction): Promise<boolean> {
 const secret=await kit.store.find({kind:'authorization',key:'authz.key',value:`resource_config|${WHOLE_HUB}|secret:${name}`,limit:1},tx);
 if(secret.items.length)return false;
 return !(await deploymentDefinitions(kit,tx)).some(d=>d.references.some(r=>r.name===name));
}
