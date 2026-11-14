import { workflowBooksTestEnvironments } from './test-environment-inheritance-policy.ts';
import { prepareTestEnvironmentRegistration } from './test-environment-registration.ts';
import {
  TestEnvironment, TestEnvironmentInput, TestEnvironmentId, TestEnvironmentPrefix, TestEnvironmentInheritanceCompletion,
  TEST_ENVIRONMENT_CONFIG_PREFIX, TEST_ENVIRONMENT_INHERITANCE_KEY, TEST_ENVIRONMENT_INHERITANCE_RULE_VERSION,
  TeamId,
} from '../../contracts/api.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { UserId, PackId } from '../../contracts/src/common.ts';
import { referencesIn } from '../../contracts/src/variables.ts';
import type { Authorizations, AuthorizationRecord, ObjectStore, Page, Principal, RecordStore, Transaction, User } from './api.ts';
import type { TestEnvironmentInheritanceSources } from './environment-inheritance-types.ts';
import { Database, iso } from './db.ts';
import { canonicalBytes } from './canonical.ts';
import { sha256Hex } from './digest.ts';
import { parseStrictJson } from './strict-json.ts';
import { newId } from './ids.ts';
import { isAdmin } from './permissions.ts';
import { AccessError, ConflictError, IntegrityError } from './errors.ts';
import { captureRequestPermissions } from './request-permissions.ts';
import { withEnvironmentPermissionLock } from './environment-permission-lock.ts';
import { environmentProgramWrite } from './environment-program-write.ts';
import { PermissionRoleSchema } from '../../contracts/generated/vocabulary.ts';

export type { TestEnvironment, TestEnvironmentInput } from '../../contracts/api.ts';
export interface TestEnvironmentInheritanceState { completed: boolean | null; record: string | null; missingFacts: string[] }
export interface TestEnvironmentOwnership {
  prefixes: readonly { prefix: string; owner: string }[];
  resources: readonly { key: string; owner: string }[];
}
export interface TestEnvironments {
  list(by: Principal, tx?: Transaction): Promise<TestEnvironment[]>;
  get(by: Principal, id: string, tx?: Transaction): Promise<TestEnvironment | null>;
  register(by: Principal, input: TestEnvironmentInput, tx?: Transaction): Promise<TestEnvironment>;
  update(by: Principal, id: string, input: TestEnvironmentInput, tx?: Transaction): Promise<TestEnvironment>;
  remove(by: Principal, id: string, tx?: Transaction): Promise<void>;
  resolve(keys: readonly string[], tx?: Transaction): Promise<TestEnvironment[]>;
  canUse(by: Principal, id: string, tx?: Transaction): Promise<boolean>;
  ownership(tx?: Transaction): Promise<TestEnvironmentOwnership>;
  inheritance(tx?: Transaction): Promise<TestEnvironmentInheritanceState>;
  inherit(by: Principal, sources: TestEnvironmentInheritanceSources): Promise<{ completed: boolean; record: string; assignments: number }>;
}

const key = (row: AuthorizationRecord) => `${row.body.permission}|${row.body.subject}|${row.body.object}`;
const enabledAt = (row: AuthorizationRecord | undefined, at: string) => row !== undefined && !row.body.revoked && (row.body.expires_at === null || row.body.expires_at > at);
const covers = (environment: TestEnvironment, value: string) => environment.resources.some(row => row.key === value) || environment.prefixes.some(row => value.startsWith(row.prefix));

export class RecordTestEnvironments implements TestEnvironments {
  private readonly db: Database;
  private readonly store: RecordStore;
  private readonly objects: ObjectStore;
  private readonly authorizations: Authorizations;
  constructor(db: Database, store: RecordStore, objects: ObjectStore, authorizations: Authorizations) {
    this.db = db; this.store = store; this.objects = objects; this.authorizations = authorizations;
  }

  private async at(tx: Transaction): Promise<string> { return iso((await this.db.query('SELECT clock_timestamp() AS at', [], tx)).rows[0].at); }
  private async admin(by: Principal, tx: Transaction): Promise<Principal> {
    const row = (await this.db.query('SELECT id,name,role,disabled,deleted_at FROM users WHERE id=$1 FOR SHARE', [by.id], tx)).rows[0];
    if (!row || row.disabled || row.deleted_at || !isAdmin({ role: PermissionRoleSchema.parse(row.role) })) throw new AccessError('只有当前启用的真实管理员可以管理测试环境');
    return { id: String(row.id), name: String(row.name), role: PermissionRoleSchema.parse(row.role) };
  }
  private async allAuthorizations(tx: Transaction): Promise<AuthorizationRecord[]> {
    const rows: AuthorizationRecord[] = []; let cursor: string | null = null;
    do {
      const page: Page<AuthorizationRecord> = await this.store.list<AuthorizationRecord['body']>({ kind: 'authorization', newestFirst: false, limit: 500, cursor }, tx);
      rows.push(...page.items); cursor = page.next;
    } while (cursor !== null);
    return rows;
  }
  private latest(rows: readonly AuthorizationRecord[]): Map<string, AuthorizationRecord> { return new Map(rows.map(row => [key(row), row])); }
  private async content(bound: string | null, tx: Transaction): Promise<unknown> {
    const bytes = bound === null ? null : await this.objects.get(bound, tx);
    if (!bytes || sha256Hex(bytes) !== bound) throw new IntegrityError('测试环境声明原件缺失或摘要不符');
    return parseStrictJson(Buffer.from(bytes).toString('utf8'));
  }
  private async catalog(tx: Transaction): Promise<TestEnvironment[]> {
    const at = await this.at(tx), rows = this.latest(await this.allAuthorizations(tx));
    const result: TestEnvironment[] = [];
    for (const row of rows.values()) {
      if (row.body.permission !== 'resource_config' || row.body.subject !== '*' || !row.body.object.startsWith(TEST_ENVIRONMENT_CONFIG_PREFIX) || !enabledAt(row, at)) continue;
      const environment = TestEnvironment.parse(await this.content(row.body.bound, tx));
      if (row.body.object !== TEST_ENVIRONMENT_CONFIG_PREFIX + environment.id) throw new IntegrityError('测试环境登记与内部身份不符');
      result.push(environment);
    }
    return result;
  }
  private async validateExecutors(environment: TestEnvironment, tx: Transaction): Promise<void> {
    if (environment.target === null) throw new IntegrityError('测试环境的目标归属尚未核对');
    const latest = this.latest(await this.allAuthorizations(tx)), at = await this.at(tx);
    for (const id of environment.executors) {
      const row = latest.get(`resource_config|*|executor.${id}`);
      if (!enabledAt(row, at)) throw new IntegrityError('关联执行器的当前登记不可核对');
      const source = ExecutorSource.parse(await this.content(row!.body.bound, tx));
      if (source.id !== id || referencesIn(source.target).length || source.target !== environment.target || source.resources.some(value => !covers(environment, value))) throw new IntegrityError('测试环境与关联执行器的目标或资源声明不一致');
    }
  }
  private async reader(by: Principal, tx: Transaction) { return captureRequestPermissions(this.db, by, new Date(await this.at(tx)), tx); }
  async list(by: Principal, outer?: Transaction): Promise<TestEnvironment[]> {
    return this.store.withTransaction(async tx => {
      const permission = await this.reader(by, tx);
      if (!permission.user || permission.user.disabled || permission.user.deleted_at) return [];
      const values = await this.catalog(tx);
      if (isAdmin(permission.user)) return values;
      return values.filter(value => value.enabled && [by.id, ...permission.teams(), '*'].some(subject => permission.enabled(permission.latest('resource_assign', subject, value.id))));
    }, outer);
  }
  async get(by: Principal, id: string, tx?: Transaction) { return (await this.list(by, tx)).find(value => value.id === id) ?? null; }
  async resolve(keys: readonly string[], outer?: Transaction): Promise<TestEnvironment[]> {
    if (!keys.length) return [];
    return this.store.withTransaction(async tx => {
      const matches = (await this.catalog(tx)).filter(environment => keys.every(value => covers(environment, value)));
      for (const environment of matches) await this.validateExecutors(environment, tx);
      return matches;
    }, outer);
  }
  async canUse(by: Principal, id: string, outer?: Transaction): Promise<boolean> {
    return this.store.withTransaction(async tx => {
      const environment = (await this.catalog(tx)).find(value => value.id === id);
      if (!environment?.enabled) return false;
      await this.validateExecutors(environment, tx);
      const permission = await this.reader(by, tx);
      if (!permission.user || permission.user.disabled || permission.user.deleted_at) return false;
      return [by.id, ...permission.teams(), '*'].some(subject => permission.enabled(permission.latest('resource_assign', subject, id)));
    }, outer);
  }
  private async leaseLock(tx: Transaction) { await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('leases.registrations',0))", [], tx); }
  private async write(by: Principal, environment: TestEnvironment, tx: Transaction): Promise<AuthorizationRecord> {
    const stored = await this.objects.put(canonicalBytes(TestEnvironment.parse(environment)), 'application/json', tx);
    return environmentProgramWrite(tx, () => this.authorizations.configureResourceInTransaction(by, TEST_ENVIRONMENT_CONFIG_PREFIX + environment.id, stored.sha256, '测试环境登记', tx));
  }
  private unique(environment: TestEnvironment, values: readonly TestEnvironment[]) {
    if (values.some(value => value.id !== environment.id && (environment.name !== null && value.name === environment.name || environment.target !== null && value.target === environment.target))) throw new ConflictError('测试环境的名字或目标已经登记');
  }
  async register(by: Principal, input: TestEnvironmentInput, outer?: Transaction): Promise<TestEnvironment> {
    return withEnvironmentPermissionLock(this.store, async tx => {
      await this.leaseLock(tx); const actor = await this.admin(by, tx);
      const environment = prepareTestEnvironmentRegistration(input, actor.id, await this.at(tx));
      this.unique(environment, await this.catalog(tx));
      await this.validateOwners(environment, tx); await this.validateExecutors(environment, tx);
      await this.write(actor, environment, tx); return environment;
    }, outer);
  }
  async update(by: Principal, id: string, input: TestEnvironmentInput, outer?: Transaction): Promise<TestEnvironment> {
    TestEnvironmentId.parse(id);
    return withEnvironmentPermissionLock(this.store, async tx => {
      await this.leaseLock(tx); const actor = await this.admin(by, tx), values = await this.catalog(tx);
      const previous = values.find(value => value.id === id);
      if (!previous) throw new ConflictError('测试环境不存在或已删除');
      const environment = prepareTestEnvironmentRegistration(input, actor.id, await this.at(tx), previous);
      this.unique(environment, values); await this.validateOwners(environment, tx); await this.validateExecutors(environment, tx);
      await this.write(actor, environment, tx); return environment;
    }, outer);
  }
  async remove(by: Principal, id: string, outer?: Transaction): Promise<void> {
    TestEnvironmentId.parse(id);
    await withEnvironmentPermissionLock(this.store, async tx => {
      await this.leaseLock(tx); const actor = await this.admin(by, tx);
      if (!(await this.catalog(tx)).some(value => value.id === id)) throw new ConflictError('测试环境不存在或已删除');
      await environmentProgramWrite(tx, () => this.authorizations.configureResourceInTransaction(actor, TEST_ENVIRONMENT_CONFIG_PREFIX + id, null, '删除测试环境登记', tx, true));
    }, outer);
  }
  private async validateOwners(environment: TestEnvironment, tx: Transaction) {
    const owners = [...new Set([...environment.prefixes, ...environment.resources].flatMap(row => row.owner === null ? [] : [row.owner]))].sort();
    if (!owners.length) return;
    const rows = (await this.db.query('SELECT id,disabled,deleted_at FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [owners], tx)).rows;
    if (rows.length !== owners.length || rows.some(row => row.deleted_at || row.disabled)) throw new ConflictError('测试环境登记的责任账户不存在、已停用或已删除');
  }
  async ownership(outer?: Transaction): Promise<TestEnvironmentOwnership> {
    return this.store.withTransaction(async tx => {
      const prefixes = new Map<string, string>(), resources = new Map<string, string>();
      for (const environment of await this.catalog(tx)) {
        for (const row of environment.prefixes) {
          if (row.owner === null) continue;
          if (prefixes.has(row.prefix) && prefixes.get(row.prefix) !== row.owner) throw new IntegrityError('测试环境前缀的责任归属不唯一');
          prefixes.set(row.prefix, row.owner);
        }
        for (const row of environment.resources) {
          if (row.owner === null) continue;
          if (resources.has(row.key) && resources.get(row.key) !== row.owner) throw new IntegrityError('测试环境资源的责任归属不唯一');
          resources.set(row.key, row.owner);
        }
      }
      return { prefixes: [...prefixes].map(([prefix, owner]) => ({ prefix, owner })), resources: [...resources].map(([key, owner]) => ({ key, owner })) };
    }, outer);
  }
  async inheritance(outer?: Transaction): Promise<TestEnvironmentInheritanceState> {
    try { return await this.store.withTransaction(async tx => {
      const history = (await this.allAuthorizations(tx)).filter(row => row.body.permission === 'resource_config' && row.body.subject === '*' && row.body.object === TEST_ENVIRONMENT_INHERITANCE_KEY);
      if (!history.length) return { completed: false, record: null, missingFacts: [] };
      const row = history[0];
      if (history.length !== 1 || row.body.revoked || row.body.expires_at !== null) throw new IntegrityError('测试环境继承的完成历史被撤回或改变');
      const content = TestEnvironmentInheritanceCompletion.parse(await this.content(row.body.bound, tx));
      for (const digest of content.source_records) if (!await this.store.get(digest, tx)) throw new IntegrityError('测试环境继承的来源历史缺失');
      for (const digest of content.grant_records) {
        const grant = await this.store.get<AuthorizationRecord['body']>(digest, tx);
        if (!grant || grant.kind !== 'authorization' || grant.body.permission !== 'resource_assign' || grant.body.revoked || grant.body.decided_by !== row.body.decided_by || !content.environment_ids.includes(grant.body.object)) throw new IntegrityError('测试环境继承的原始分配记录不符');
      }
      return { completed: true, record: row.digest, missingFacts: [] };
    }, outer); } catch { return { completed: null, record: null, missingFacts: ['测试环境继承完成事实无法核对；不会重新授予或退回旧许可'] }; }
  }

  async inherit(by: Principal, sources: TestEnvironmentInheritanceSources): Promise<{ completed: boolean; record: string; assignments: number }> {
    return withEnvironmentPermissionLock(this.store, async tx => {
      await this.leaseLock(tx);
      const state = await this.inheritance(tx);
      if (state.completed === null) throw new IntegrityError(state.missingFacts.join('；'));
      if (state.completed) return { completed: true, record: state.record!, assignments: 0 };
      const actor = await this.admin(by, tx), at = await this.at(tx);
      const authorizations = await this.allAuthorizations(tx), latest = this.latest(authorizations);
      const source = await sources.collect({ store: { get: this.store.get.bind(this.store), find: this.store.find.bind(this.store), list: this.store.list.bind(this.store) }, objects: { get: this.objects.get.bind(this.objects) }, tx, at, authorizations });
      const references = new Set(source.sourceRecords);
      for (const workflow of source.workflows) {
        PackId.parse(workflow.id);
        TestEnvironmentPrefix.parse({ prefix: workflow.prefix, owner: null, registered_at: null });
        workflow.sourceRecords.forEach(value => references.add(value));
      }
      for (const digest of references) if (!await this.store.get(digest, tx)) throw new IntegrityError('测试环境继承来源原件缺失');
      const legacy = (await this.db.query('SELECT prefix,owner,registered_at FROM lease_registrations ORDER BY prefix', [], tx)).rows.map(row => ({ prefix: String(row.prefix), owner: String(row.owner), registered_at: iso(row.registered_at) }));
      const environments = await this.catalog(tx), added: TestEnvironment[] = [];
      const groups = new Map<string, ExecutorSource[]>();
      for (const value of source.executors) {
        const executor = ExecutorSource.parse(value);
        if (!executor.id) throw new IntegrityError('执行器缺少真实登记身份');
        const target = referencesIn(executor.target).length ? null : executor.target;
        const group = target === null ? [] : groups.get(target) ?? [];
        group.push(executor);
        groups.set(target ?? executor.id, group);
      }
      for (const group of groups.values()) {
        const target = referencesIn(group[0].target).length ? null : group[0].target;
        const existing = target === null ? undefined : environments.find(value => value.target === target);
        if (existing) continue;
        const keys = [...new Set(group.flatMap(value => value.resources))];
        const resources = keys.map(key => {
          const owners = legacy.filter(row => key.startsWith(row.prefix));
          return { key, owner: owners.length === 1 ? owners[0].owner : null, registered_at: owners.length === 1 ? owners[0].registered_at : null };
        });
        added.push(TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name: target, target, prefixes: [], resources, executors: target === null ? [] : group.map(value => value.id), enabled: group.some(value => value.enabled), missing_facts: [...(target === null ? ['原登记尚未提供测试环境名字', '执行器目标包含未解析引用'] : []), ...(resources.some(row => row.owner === null) ? ['部分资源没有已核对的登记责任人'] : [])] }));
      }
      for (const registration of legacy) {
        const matches = [...environments, ...added].filter(value => value.target !== null && value.resources.some(row => row.key.startsWith(registration.prefix)));
        if (matches.length === 1 && added.includes(matches[0])) matches[0].prefixes.push(registration);
        else if (matches.length === 1 && matches[0].prefixes.some(row => row.prefix === registration.prefix && row.owner === registration.owner && row.registered_at === registration.registered_at)) continue;
        else added.push(TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name: null, target: null, prefixes: [registration], resources: [], executors: [], enabled: true, missing_facts: ['原前缀登记没有唯一可核对的目标归属', '原登记尚未提供测试环境名字'] }));
      }
      for (const environment of added) {
        this.unique(environment, environments);
        const decision = await this.write(actor, environment, tx);
        references.add(decision.digest); environments.push(environment);
      }
      const accounts = (await this.db.query('SELECT id,disabled,deleted_at FROM users ORDER BY id FOR SHARE', [], tx)).rows;
      const validUser = (id: string) => accounts.some(row => row.id === id && !row.disabled && !row.deleted_at);
      const grants = new Map<string, { subject: string; environment: string; until: number }>();
      for (const workflow of source.workflows) {
        if (!workflowBooksTestEnvironments(workflow.prefix, environments)) continue;
        const assignments = [...latest.values()].filter(row => row.body.permission === 'assign' && row.body.object === workflow.id && enabledAt(row, at));
        for (const assignment of assignments) {
          const subject = assignment.body.subject;
          if (subject !== '*' && !(UserId.safeParse(subject).success && validUser(subject)) && !(TeamId.safeParse(subject).success && enabledAt(latest.get(`assign|*|${subject}`), at))) continue;
          if (workflow.installedMethod && subject !== '*') continue;
          const deadlines = [assignment, ...workflow.sourceRecords.flatMap(digest => authorizations.filter(row => row.digest === digest))].map(row => row.body.expires_at === null ? Infinity : Date.parse(row.body.expires_at));
          const until = Math.min(...deadlines);
          for (const environment of environments) {
            const key = subject + '|' + environment.id, previous = grants.get(key);
            if (!previous || until > previous.until) grants.set(key, { subject, environment: environment.id, until });
          }
        }
      }
      const written: string[] = [];
      for (const grant of grants.values()) {
        const previous = latest.get(`resource_assign|${grant.subject}|${grant.environment}`);
        if (previous) continue;
        const decision = await this.authorizations.grant(actor, { permission: 'resource_assign', subject: grant.subject, object: grant.environment, expiresAt: grant.until === Infinity ? null : new Date(grant.until).toISOString(), note: '按已批准升级规则自动继承原工作流预订分配；非管理员手工分配' }, tx);
        written.push(decision.digest);
      }
      authorizations.forEach(row => references.add(row.digest));
      const completion = TestEnvironmentInheritanceCompletion.parse({ schema: 'test-environment-inheritance-completion@1', rule_version: TEST_ENVIRONMENT_INHERITANCE_RULE_VERSION, completed_at: at, source_records: [...references].sort(), grant_records: written, environment_ids: environments.map(value => value.id) });
      const object = await this.objects.put(canonicalBytes(completion), 'application/json', tx);
      const marker = await environmentProgramWrite(tx, () => this.authorizations.configureResourceInTransaction(actor, TEST_ENVIRONMENT_INHERITANCE_KEY, object.sha256, '已批准规则的测试环境分配一次继承完成', tx));
      return { completed: true, record: marker.digest, assignments: written.length };
    });
  }
}
