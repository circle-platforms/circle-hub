import { ExecutorNameBinding, ExecutorStableName, EXECUTOR_NAME_PREFIX, idOf } from '../../contracts/api.ts';
import { withEnvironmentPermissionLock, canonicalBytes, isAdmin, parseStrictJson, sha256Hex, WHOLE_HUB, type AuthorizationRecord, type Principal, type RecordsKit, type Transaction } from '../records/api.ts';

/** Names are separate immutable identity declarations, never an edit of a frozen executor source. */
export class ExecutorNames {
  readonly records: RecordsKit;
  constructor(records: RecordsKit) { this.records=records; }

  private async bindings(tx?: Transaction): Promise<{reserved:ExecutorNameBinding[];active:ExecutorNameBinding[]}> {
    const rows = await this.records.store.findMany<AuthorizationRecord['body']>({ kind:'authorization', key:'authz.subject', values:[`resource_config|${WHOLE_HUB}`] }, tx);
    const namedRows=rows.filter(row=>row.body.object.startsWith(EXECUTOR_NAME_PREFIX));
    const superseded=new Set(namedRows.flatMap(row=>row.body.supersedes?[row.body.supersedes]:[]));
    const heads=namedRows.filter(row=>!superseded.has(row.digest));
    if(new Set(heads.map(row=>row.body.object)).size!==heads.length)throw new Error('执行器名字决定链有分歧，不能猜测当前名字');
    const result: ExecutorNameBinding[] = [],byDigest=new Map<string,ExecutorNameBinding>();
    for (const row of rows) {
      if (!row.body.object.startsWith(EXECUTOR_NAME_PREFIX) || !row.body.bound) continue;
      const bytes = await this.records.objects.get(row.body.bound, tx);
      if (!bytes || sha256Hex(bytes) !== row.body.bound) throw new Error('执行器名字声明原件缺失或摘要不符，不能猜测名字');
      let decoded:unknown;
      try{decoded=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('执行器名字声明原件不合格式，不能读取其内容作为诊断');}
      const parsed = ExecutorNameBinding.safeParse(decoded);
      if (!parsed.success || row.body.object !== EXECUTOR_NAME_PREFIX + parsed.data.executor) throw new Error('执行器名字声明不合格式，不能猜测名字');
      result.push(parsed.data);byDigest.set(row.digest,parsed.data);
    }
    const names = new Map<string,string>(), identities = new Map<string,string>();
    for (const row of result) {
      if (names.has(row.name) && names.get(row.name) !== row.executor || identities.has(row.executor) && identities.get(row.executor) !== row.name)
        throw new Error('执行器名字声明互相冲突，不能导出或应用');
      names.set(row.name,row.executor); identities.set(row.executor,row.name);
    }
    return {reserved:[...identities].map(([executor,name]) => ({schema:'executor-name@1',executor,name})),active:heads.flatMap(row=>{const binding=byDigest.get(row.digest);return !row.body.revoked&&binding?[binding]:[];})};
  }

  async inspect(by: Principal, tx?: Transaction): Promise<{reserved:ExecutorNameBinding[];active:ExecutorNameBinding[]}> {
    const actor = await this.records.principals.get(by.id, tx);
    if (!actor || actor.disabled || !isAdmin(actor)) throw new Error('只有启用的管理员可以读取执行器名字登记');
    return this.bindings(tx);
  }

  async list(by:Principal,tx?:Transaction):Promise<ExecutorNameBinding[]>{return (await this.inspect(by,tx)).active;}

  async assign(by: Principal, executor: string, name: string): Promise<{binding:ExecutorNameBinding;created:boolean}> {
    const identity = idOf('exe').parse(executor), explicitName = ExecutorStableName.parse(name);
    return this.records.store.withTransaction(tx => this.assignInTransaction(by,identity,explicitName,tx));
  }

  async checkInTransaction(by: Principal, executor: string, name: string, tx: Transaction): Promise<ExecutorNameBinding|null> {
    await withEnvironmentPermissionLock(this.records.store, async () => {}, tx);
    const identity=idOf('exe').parse(executor), explicitName=ExecutorStableName.parse(name);
    const actor=await this.records.principals.lockActive(by,tx);
    if (!isAdmin(actor)) throw new Error('只有启用的管理员可以给执行器命名');
    await this.records.store.lock('dispatch-config:executor:'+identity,tx);
    await this.records.store.lock('dispatch-executor-names',tx);
    const existing=await this.bindings(tx);
    const owner=existing.reserved.find(row=>row.name===explicitName), current=existing.reserved.find(row=>row.executor===identity);
    if (owner && owner.executor!==identity) throw new Error('这个执行器名字已经被占用；请明确选择另一个名字');
    if (current && current.name!==explicitName) throw new Error('这个执行器已经有明确名字；应用定义不会自动改名');
    return existing.active.find(row=>row.executor===identity)??null;
  }

  async assignInTransaction(by: Principal, executor: string, name: string, tx: Transaction): Promise<{binding:ExecutorNameBinding;created:boolean}> {
    const identity=idOf('exe').parse(executor), explicitName=ExecutorStableName.parse(name);
    const current=await this.checkInTransaction(by,identity,explicitName,tx);
    const config=await this.records.store.find<AuthorizationRecord['body']>({kind:'authorization',key:'authz.key',value:`resource_config|${WHOLE_HUB}|executor.${identity}`,newestFirst:true,limit:1},tx);
    if (!config.items[0]?.body.bound || config.items[0].body.revoked) throw new Error('执行器没有有效登记；请核对要命名的现有执行器编号');
    if (current) return {binding:current,created:false};
    const binding:ExecutorNameBinding={schema:'executor-name@1',executor:identity,name:explicitName};
    const stored=await this.records.objects.put(canonicalBytes(binding),'application/json',tx);
    await this.records.authorizations.configureResourceInTransaction(by,EXECUTOR_NAME_PREFIX+identity,stored.sha256,'管理员明确登记执行器名字',tx);
    return {binding,created:true};
  }
}
