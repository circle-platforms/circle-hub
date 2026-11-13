import { readFile, mkdir, open, lstat, realpath, unlink, link, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { DeploymentDefinition, ProtectedConfigurationEnvelope, ProtectedConfigurationReceipt, type DeploymentDefinition as Definition } from '../../contracts/src/deployment.ts';
import { PackManifest } from '../../contracts/src/pack.ts';
import { ResourceRecord } from '../../contracts/src/resources.ts';
import { SecretReference } from '../../contracts/src/variables.ts';
import { canonicalBytes, parseStrictJson, sha256Hex, WHOLE_HUB, type RecordsConfig, type ConfigurationSnapshot } from '../records/api.ts';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { jsonSafe } from './assemble/terminal.ts';
import { variableCommand } from './variables.ts';
import { docIdOf } from './docs.ts';
import { packCommand } from './cli-pack.ts';
import { CliError, UsageError } from './errors.ts';
import type { Session } from './cli-session.ts';

export const APPLY_USAGE = 'apply <部署定义.json>（已有定义相同则跳过，差异列出字段，不覆盖）';
export const EXPORT_USAGE = 'export（导出部署定义，不包含密钥值、令牌、密码或密钥库内容）';

export function parseDeployment(input: unknown): Definition {
  const parsed = DeploymentDefinition.safeParse(input);
  if (!parsed.success) throw new UsageError('部署定义不合格式：' + parsed.error.issues.map(issue => issue.path.join('/')).join('、'));
  for (const document of parsed.data.documents) {
    const bytes = Buffer.from(document.bytesBase64, 'base64');
    if (bytes.toString('base64') !== document.bytesBase64 || bytes.byteLength !== document.size || sha256Hex(bytes) !== document.sha256)
      throw new UsageError('命名文档的字节、长度或摘要不相同');
  }
  return parsed.data;
}

/** Field paths only: values may contain deployment information and are never diagnostics. */
export function differentFields(current: unknown, desired: unknown, path = ''): string[] {
  if (Object.is(current, desired)) return [];
  if (current !== null && desired !== null && typeof current === 'object' && typeof desired === 'object') {
    const a = current as Record<string, unknown>, b = desired as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key =>
      differentFields(a[key], b[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')));
  }
  return [path || '/'];
}

type PackInput = Definition['packs'][number];
export interface DeploymentPack extends PackInput { manifest: PackManifest | null; }

/** Exact version edges only. Missing external edges are checked by the caller before writes. */
export function deploymentOrder(packs: readonly DeploymentPack[]): DeploymentPack[] {
  const entries = new Map<string, DeploymentPack>();
  for (const pack of packs) {
    if (entries.has(pack.ref)) throw new UsageError('发布列表有重复版本');
    entries.set(pack.ref, pack);
  }
  const active = new Set<string>(), done = new Set<string>(), result: DeploymentPack[] = [];
  const visit = (pack: DeploymentPack) => {
    if (active.has(pack.ref)) throw new UsageError('包依赖图有环');
    if (done.has(pack.ref)) return;
    active.add(pack.ref);
    for (const dependency of pack.dependsOn) {
      const entry = entries.get(dependency);
      if (entry) visit(entry);
    }
    active.delete(pack.ref); done.add(pack.ref); result.push(pack);
  };
  for (const pack of packs) visit(pack);
  return result;
}

export function exactMatch<T extends { id: string }>(rows: readonly T[], value: string, name: (row: T) => string): T | undefined {
  const matches = rows.filter(row => row.id === value || name(row) === value);
  if (matches.length > 1) throw new CliError('名字或编号对应多个对象，须使用明确编号');
  return matches[0];
}

async function loadPacks(session: Session, definition: Definition, base: string): Promise<DeploymentPack[]> {
  const hub = await session.hub();
  const result: DeploymentPack[] = [];
  for (const entry of definition.packs) {
    let manifest: PackManifest | null = null;
    const directory = entry.directory === undefined ? undefined : resolve(base, entry.directory);
    if (directory !== undefined) {
      try { manifest = PackManifest.parse(parseStrictJson(await readFile(join(directory, 'pack.json'), 'utf8'))); }
      catch { throw new UsageError('发布目录缺少有效的 pack.json'); }
      if (`${manifest.id}@${manifest.version}` !== entry.ref) throw new UsageError('发布目录与指定包版本不相同');
    } else if (!await hub.registry.resolve(entry.ref)) throw new CliError('包版本尚未发布，须补充 directory');
    const dependencies = [...entry.dependsOn];
    for (const dependency of manifest?.dependencies ?? []) {
      if (dependency.space) throw new UsageError('部署发布不能引用个人空间的技能');
      const candidates = definition.packs.filter(p => p.ref.split('@')[0] === dependency.pack);
      const ref = dependency.version ? `${dependency.pack}@${dependency.version}` : candidates.length === 1 ? candidates[0].ref : undefined;
      if (!ref) throw new UsageError('技能依赖须有明确版本或在部署文件中列出明确版本');
      dependencies.push(ref);
    }
    for (const dependency of manifest?.embeds ?? []) dependencies.push(`${dependency.pack}@${dependency.version}`);
    result.push({ ...entry, directory, manifest, dependsOn: [...new Set(dependencies)] });
  }
  const ordered = deploymentOrder(result), refs = new Set(result.map(p => p.ref));
  for (const pack of result) if (pack.manifest?.kind === 'skill' && result.some(other => other.dependsOn.includes(pack.ref))) pack.install = true;
  for (const pack of ordered) for (const ref of pack.dependsOn) {
    if (!refs.has(ref) && !await hub.registry.resolve(ref)) throw new CliError('依赖的精确包版本尚未发布');
  }
  return ordered;
}

function resourceDefinition(record: ResourceRecord): Definition['resources'][number]['definition'] {
  const credentials: Record<string, string> = {};
  for (const [name, reference] of Object.entries(record.credentials)) {
    if (!SecretReference.safeParse(reference).success) throw new CliError('资源凭据不是命名引用，不能导出');
    credentials[name] = reference.slice(9, -1);
  }
  return { system_pack: record.system_pack, name: record.name, environment: record.environment, origins: record.origins,
    allow_plaintext: record.allow_plaintext, credentials, settings: record.settings, ...(record.limits ? { limits: record.limits } : {}) };
}

/** Reads definitions and authorization metadata, never credential APIs or resolved variable values. */
export async function exportDeployment(session: Session): Promise<Definition> {
  const by = await session.admin(), records = await session.records(), hub = await session.hub(false, true);
  const users = (await records.principals.list()).filter(user => !user.deleted_at);
  const teams = await records.teams.list(by);
  const resources: Definition['resources'] = [];
  const resourceAssignments: Definition['resourceAssignments'] = [];
  for (const listing of await hub.resources.list(by)) {
    let decision = await records.authorizations.resourceConfig(listing.id);
    if (!decision?.body.bound) {
      let cursor: string | null = null;
      do {
        const page = await records.authorizations.history({ permission: 'resource_config', subject: WHOLE_HUB, object: listing.id, newestFirst: true, limit: 500, cursor });
        decision = page.items.find(row => !row.body.revoked && row.body.bound !== null) ?? null;
        cursor = page.next;
      } while (!decision && cursor);
    }
    const bytes = decision?.body.bound ? await records.objects.get(decision.body.bound) : null;
    if (!bytes) throw new CliError('资源定义原件缺失，不能导出');
    let source: ResourceRecord;
    try { source = ResourceRecord.parse(parseStrictJson(Buffer.from(bytes).toString('utf8'))); }
    catch { throw new CliError('资源定义原件不合格式，不能导出'); }
    if (source.id !== listing.id || sha256Hex(bytes) !== decision!.body.bound) throw new CliError('资源定义完整性核对错误');
    resources.push({ id: source.id, definition: resourceDefinition(source), enabled: listing.enabled });
    const assigned = await records.authorizations.teamsOf(by, 'resource', source.id);
    for (const team of assigned.teams) resourceAssignments.push({ resource: source.id, team: team.id });
    if (assigned.all) resourceAssignments.push({ resource: source.id, all: true });
  }
  const packs = await hub.registry.listPacks();
  const installed = await hub.registry.installedSkills();
  const packDefinitions: Definition['packs'] = packs.filter(pack => pack.latest !== null).map(pack => ({ ref: `${pack.id}@${pack.latest}`, dependsOn: [], install: false }));
  for (const skill of installed) {
    const ref = `${skill.info.id}@${skill.info.version}`, found = packDefinitions.find(pack => pack.ref === ref);
    if (found) found.install = true;
    else packDefinitions.push({ ref, dependsOn: [], install: true });
  }
  const workflowAssignments: Definition['workflowAssignments'] = [];
  for (const pack of packs.filter(pack => pack.kind === 'workflow')) {
    const assigned = await records.authorizations.teamsOf(by, 'pack', pack.id);
    for (const team of assigned.teams) workflowAssignments.push({ pack: pack.id, team: team.id });
    for (const user of users) {
      if (await records.authorizations.isActive('assign', user.id, pack.id)) workflowAssignments.push({ pack: pack.id, user: user.id });
    }
  }
  const variables: Definition['variables'] = [];
  for (const variable of await records.variables.list(by)) {
    if (variable.kind !== 'var' || variable.decision.body.revoked) continue;
    if (!variable.definition) throw new CliError('普通变量定义原件缺失，不能完整导出');
    variables.push({ schema: 'variable@1', name: variable.name, value: variable.definition.value });
  }
  const documents: Definition['documents'] = [];
  for (const document of await hub.docs.list()) {
    const source = (await records.artifacts.records(document.sha256)).find(row => 'read' in row.body.origin && row.body.origin.read.object === docIdOf(document.name, document.sha256));
    if (!source || source.body.scan.findings.length) throw new CliError('命名文档来源缺失或含待处理凭据，不能导出其字节');
    const bytes = await records.artifacts.trustedBytes(document.sha256);
    if (!bytes || bytes.byteLength !== document.size || sha256Hex(bytes) !== document.sha256) throw new CliError('命名文档原件缺失或完整性错误，不能导出');
    documents.push({ name: document.name, sha256: document.sha256, size: document.size, bytesBase64: Buffer.from(bytes).toString('base64'), mediaType: source.body.media_type, fileName: source.body.name ?? `${document.name}.bin` });
  }
  const leaseRegistrations = await (await session.leases()).registrations('');
  return parseDeployment({ schema: 'deployment@1',
    accounts: users.map(({ id, name, role, disabled }) => ({ id, name, role, disabled })),
    teams: await Promise.all(teams.map(async team => ({ id: team.id, name: team.name, members: (await records.teams.members(by, team.id)).map(member => member.user.id) }))),
    packs: packDefinitions,
    resources, executors: (await new ExecutorRegistry(records).sources(by)).map(entry => entry.source),
    workflowAssignments, resourceAssignments, knowledgeSources: packs.filter(pack => pack.kind === 'product' && pack.active).map(pack => pack.id),
    variables, documents, leaseRegistrations, missingConfiguration: ['知识同步产品线配置意图未知：当前版本没有持久读写配置的领域 API，不能从同步历史或知识根推断'],
  });
}

export interface DeploymentReport { created: number; skipped: number; missingConfiguration: string[]; differences: Array<{ section: string; index: number; fields: string[] }>; }

export async function applyDeployment(session: Session, input: unknown, base = session.ctx.io.cwd): Promise<DeploymentReport> {
  const definition = parseDeployment(input);
  const by = await session.admin(), records = await session.records(), hub = await session.hub(false, true);
  const packs = await loadPacks(session, definition, base);
  const current = await exportDeployment(session);
  const report: DeploymentReport = { created: 0, skipped: 0, differences: [], missingConfiguration: definition.missingConfiguration };
  try {
    const compare = (section: string, index: number, before: unknown, after: unknown): boolean => {
      const fields = differentFields(before, after);
      if (fields.length) report.differences.push({ section, index, fields });
      else report.skipped++;
      return fields.length === 0;
    };
    const required = <T>(value: T | undefined, kind: string): T => { if (!value) throw new CliError(`${kind}不存在；只按精确名字或编号查找`); return value; };
    for (const [index, account] of definition.accounts.entries()) {
      const found = exactMatch(current.accounts as Array<typeof account & { id: string }>, account.id ?? account.name, row => row.name);
      if (found) { compare('accounts', index, { name: found.name, role: found.role, disabled: found.disabled }, { name: account.name, role: account.role, disabled: account.disabled }); continue; }
      if (account.id) throw new CliError('账户编号不存在；新账户应省略编号');
      const user = await records.principals.createUser(by, account.name, account.role); report.created++;
      if (account.disabled) { await records.principals.setDisabled(by, user.id, true); report.created++; }
      current.accounts.push({ id: user.id, name: user.name, role: user.role, disabled: account.disabled });
    }
    const userId = (value: string) => required(exactMatch(current.accounts as Array<Definition['accounts'][number] & { id: string }>, value, row => row.name), '账户').id;
    for (const [index, team] of definition.teams.entries()) {
      let found = exactMatch(current.teams as Array<typeof team & { id: string }>, team.id ?? team.name, row => row.name);
      if (!found) {
        if (team.id) throw new CliError('团队编号不存在；新团队应省略编号');
        const created = await records.teams.create(by, team.name);
        found = { id: created.id, name: created.name, members: [] }; current.teams.push(found); report.created++;
      } else compare('teams', index, found.name, team.name);
      for (const member of team.members) {
        const id = userId(member);
        if (found.members.includes(id)) report.skipped++;
        else { await records.teams.add(by, found.id, id); found.members.push(id); report.created++; }
      }
    }
    const installSkill = async (ref: string) => {
      const published = await hub.registry.resolve(ref);
      if (published?.kind !== 'skill') throw new CliError('只有通用技能可以 install');
      if ((await hub.registry.installedSkills()).some(entry => `${entry.info.id}@${entry.info.version}` === ref)) return;
      await hub.registry.install(by, ref); report.created++;
    };
    for (const pack of packs) {
      for (const dependency of pack.dependsOn) {
        if ((await hub.registry.resolve(dependency))?.kind === 'skill') await installSkill(dependency);
      }
      const published = await hub.registry.resolve(pack.ref);
      if (!pack.directory || !pack.manifest) {
        report.skipped++;
        if (pack.install) await installSkill(pack.ref);
        continue;
      }
      const existing = published;
      if (existing) {
        if (existing.digest !== sha256Hex(canonicalBytes(pack.manifest))) throw new CliError('已发布包版本与目录清单不同，版本不可覆盖');
        for (const file of pack.manifest.files) {
          const bytes = await readFile(join(pack.directory, file.path));
          if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) throw new CliError('发布目录文件与清单不同');
        }
        report.skipped++;
      } else {
        if (!await records.authorizations.canPublish(by.id)) { await records.authorizations.grantPublishRight(by, by.id); report.created++; }
        const code = await packCommand(session, ['publish', pack.directory, '--stage']);
        if (code !== 0) throw new CliError('发布包未完成');
        report.created++;
      }
      if (pack.install) await installSkill(pack.ref);
    }
    for (const [index, variable] of definition.variables.entries()) {
      const found = current.variables.find(row => row.name === variable.name);
      if (found) { compare('variables', index, found.value, variable.value); continue; }
      const directory = await mkdtemp(join(tmpdir(), 'circle-hub-apply-variable-'));
      try {
        const file = join(directory, 'value.json');
        await writeFile(file, canonicalBytes(variable.value), { mode: 0o600, flag: 'wx' });
        const code = await variableCommand(session, ['set', variable.name, '--file', file, '--reason', '部署定义文件配置普通变量']);
        if (code !== 0) throw new CliError('普通变量配置未完成');
      } finally { await rm(directory, { recursive: true, force: true }); }
      current.variables.push(variable); report.created++;
    }
    for (const [index, document] of definition.documents.entries()) {
      const found = current.documents.find(row => row.name === document.name);
      if (found) { compare('documents', index, { sha256: found.sha256, mediaType: found.mediaType, fileName: found.fileName }, { sha256: document.sha256, mediaType: document.mediaType, fileName: document.fileName }); continue; }
      const result = await hub.docs.put(by, document.name, Buffer.from(document.bytesBase64, 'base64'), { fileName: document.fileName, mediaType: document.mediaType });
      report.created += Number(result.created);
      if (result.findings) throw new CliError('命名文档含待处理凭据，未确认可用；请管理员核对来源扫描');
      if (!result.created) report.skipped++;
      current.documents.push(document);
    }
    for (const [index, resource] of definition.resources.entries()) {
      const rows = current.resources.map(row => ({ ...row, id: row.id! }));
      const found = exactMatch(rows, resource.id ?? resource.definition.name, row => row.definition.name);
      if (found) { compare('resources', index, { definition: found.definition, enabled: found.enabled }, { definition: resource.definition, enabled: resource.enabled }); continue; }
      if (resource.id) throw new CliError('资源编号不存在；新资源应省略编号');
      const created = await hub.connectors.admin.addResource(by, resource.definition); report.created++;
      if (!resource.enabled) { await hub.connectors.admin.disable(by, created.id); report.created++; }
      current.resources.push({ ...resource, id: created.id });
    }
    const executors = new ExecutorRegistry(records);
    for (const [index, executor] of definition.executors.entries()) {
      const found = exactMatch(current.executors.map(row => ({ ...row, id: row.id! })), executor.id ?? executor.target, row => row.target);
      if (found) { const { id: _id, ...before } = found; const { id: _wanted, ...after } = executor; compare('executors', index, before, after); continue; }
      if (executor.id) throw new CliError('执行器编号不存在；新执行器应省略编号');
      const created = await executors.add(by, executor); current.executors.push(created.source); report.created++;
    }
    const teamId = (value: string) => required(exactMatch(current.teams.map(row => ({ ...row, id: row.id! })), value, row => row.name), '团队').id;
    for (const assignment of definition.workflowAssignments) {
      const subject = 'user' in assignment ? userId(assignment.user) : teamId(assignment.team);
      if (await records.authorizations.isActive('assign', subject, assignment.pack)) { report.skipped++; continue; }
      if ('user' in assignment) await hub.registry.assign(by, subject, assignment.pack);
      else await hub.registry.assignTeam(by, subject, assignment.pack);
      report.created++;
    }
    for (const assignment of definition.resourceAssignments) {
      const resource = required(exactMatch(current.resources.map(row => ({ ...row, id: row.id! })), assignment.resource, row => row.definition.name), '资源');
      const subject = 'team' in assignment ? teamId(assignment.team) : WHOLE_HUB;
      if (await records.authorizations.isActive('resource_assign', subject, resource.id)) { report.skipped++; continue; }
      await records.authorizations.assignResource(by, resource.id, subject); report.created++;
    }
    for (const [index, registration] of definition.leaseRegistrations.entries()) {
      const owner = userId(registration.owner);
      const found = current.leaseRegistrations.find(row => row.prefix === registration.prefix);
      if (found) { compare('leaseRegistrations', index, found.owner, owner); continue; }
      const { leaseCommand } = await import('./cli-admin.ts');
      const code = await leaseCommand(session, ['register', registration.prefix, '--owner', owner, '--reason', '部署定义文件登记测试环境']);
      if (code !== 0) throw new CliError('测试环境预订登记未完成');
      current.leaseRegistrations.push({ ...registration, owner }); report.created++;
    }
    for (const pack of definition.knowledgeSources) {
      if (await hub.registry.isActive(pack)) report.skipped++;
      else { await hub.registry.activate(by, pack); report.created++; }
    }
    return report;
  } catch (error) {
    session.out(`部署未完成；本次已配置 ${report.created} 项，相同跳过 ${report.skipped} 项；先前已生效的操作未撤回`);
    for (const difference of report.differences) session.out(`${difference.section}[${difference.index}] 差异字段：${difference.fields.join('、')}`);
    throw error;
  }
}

export async function applyCommand(session: Session, args: readonly string[]): Promise<number> {
  if (args.length !== 1) throw new UsageError(APPLY_USAGE);
  const file = resolve(session.ctx.io.cwd, args[0]);
  let input: unknown;
  try { input = parseStrictJson(await readFile(file, 'utf8')); }
  catch { throw new UsageError('部署定义不是可读取的严格 JSON 文件'); }
  const report = await applyDeployment(session, input, dirname(file));
  for (const difference of report.differences) session.out(`${difference.section}[${difference.index}] 与现状不同：${difference.fields.join('、')}；未覆盖`);
  for (const missing of report.missingConfiguration) session.out(`缺少配置：${missing}`);
  session.out(`已配置 ${report.created} 项；相同跳过 ${report.skipped} 项；差异 ${report.differences.length} 项`);
  return report.differences.length || report.missingConfiguration.length ? 1 : 0;
}

export async function exportCommand(session: Session, args: readonly string[]): Promise<number> {
  if (args.length) throw new UsageError(EXPORT_USAGE);
  const definition = await exportDeployment(session);
  session.ctx.io.stdout(jsonSafe(JSON.stringify(definition, null, 2)));
  return 0;
}

/** Required records-owned current-schema capability; no fallback to public export or an older reader. */
export interface ProtectedConfigurationDomain<State> {
  /** Verifies the exact current schema before reading configuration, including auth hashes and complete pack object bytes. */
  capture(): Promise<State>;
  /** Validates current format, object integrity and configuration closure without applying or logging it. */
  validate(input: unknown): State | Promise<State>;
  /** Verifies the target schema and restores original identities and configuration through the controlled records API. */
  restore(snapshot: State): Promise<void>;
}

type ProtectedRoot = { dataDir: string };
const PRIVATE_CONFIG_DIRECTORY = 'private-config-snapshots';

function protectedProblem(message: string): CliError {
  return new CliError(message, '保留配置未完成；不要继续清除数据。库结构不兼容时选择归档并初始化，或用部署定义文件恢复；已开始重置时由 reset 恢复校验过的备份');
}

async function privateConfigurationDirectory(config: ProtectedRoot, create: boolean): Promise<string> {
  const root = resolve(config.dataDir), rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw protectedProblem('数据目录不是普通目录，不能读写受保护配置');
  const directory = join(root, PRIVATE_CONFIG_DIRECTORY);
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error?.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())
    throw protectedProblem('受保护配置目录的类型、属主或权限不正确');
  if (await realpath(directory) !== join(await realpath(root), PRIVATE_CONFIG_DIRECTORY))
    throw protectedProblem('受保护配置目录不在当前数据目录内');
  return directory;
}

async function readProtectedConfiguration(config: ProtectedRoot, input: unknown): Promise<{ payload: unknown }> {
  const receipt = ProtectedConfigurationReceipt.safeParse(input);
  if (!receipt.success) throw protectedProblem('受保护配置文件凭据不合格式');
  const directory = await privateConfigurationDirectory(config, false);
  const path = join(resolve(config.dataDir), receipt.data.file);
  if (dirname(path) !== directory || relative(directory, path).includes('/')) throw protectedProblem('受保护配置文件不在指定目录内');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size !== receipt.data.bytes)
      throw protectedProblem('受保护配置文件的类型、属主、权限或长度不正确');
    const bytes = await handle.readFile();
    if (sha256Hex(bytes) !== receipt.data.sha256) throw protectedProblem('受保护配置文件摘要不正确');
    const parsed = ProtectedConfigurationEnvelope.safeParse(parseStrictJson(bytes.toString('utf8')));
    if (!parsed.success) throw protectedProblem('受保护配置文件格式不兼容');
    if (sha256Hex(canonicalBytes(parsed.data.payload)) !== parsed.data.payloadSha256) throw protectedProblem('受保护配置内容摘要不正确');
    await privateConfigurationDirectory(config, false);
    return { payload: parsed.data.payload };
  } finally { await handle.close(); }
}

/** Captures a protected current-schema configuration file before reset's destructive stage. Never prints payload or hashes. */
export async function exportProtectedConfiguration<State>(config: ProtectedRoot, domain: ProtectedConfigurationDomain<State>, target?: string): Promise<ProtectedConfigurationReceipt> {
  let payload: State;
  try { payload = await domain.validate(await domain.capture()); }
  catch { throw protectedProblem('当前数据库结构不兼容或配置原件不完整，不能导出保留配置'); }
  let bytes: Uint8Array;
  try { bytes = canonicalBytes(ProtectedConfigurationEnvelope.parse({ schema: 'protected-deployment@1', createdAt: new Date().toISOString(), payloadSha256: sha256Hex(canonicalBytes(payload)), payload })); }
  catch { throw protectedProblem('受保护配置不能完整序列化，不能继续重置'); }
  let path: string | undefined, temporary: string | undefined;
  let published = false;
  try {
    const directory = await privateConfigurationDirectory(config, true);
    const name = target === undefined ? `${randomUUID()}.json` : privateConfigurationName(config, target);
    path = join(directory, name);
    temporary = join(directory, `.pending-${randomUUID()}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, path);
    published = true;
    await unlink(temporary);
    temporary = undefined;
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    const receipt = { file: `${PRIVATE_CONFIG_DIRECTORY}/${name}`, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    const verified = await readProtectedConfiguration(config, receipt);
    await domain.validate(verified.payload);
    return receipt;
  } catch {
    if (temporary !== undefined) await unlink(temporary).catch(() => {});
    if (published && path !== undefined) await unlink(path).catch(() => {});
    throw protectedProblem('受保护配置写入或回读校验失败，不能继续重置');
  }
}

/** Restores only a verified private snapshot. Reset owns quiescence, authorization and rollback on any failure. */
export async function applyProtectedConfiguration<State>(config: ProtectedRoot, receipt: ProtectedConfigurationReceipt, domain: ProtectedConfigurationDomain<State>): Promise<void> {
  let snapshot: State;
  try { snapshot = await domain.validate((await readProtectedConfiguration(config, receipt)).payload); }
  catch { throw protectedProblem('受保护配置文件校验失败，未调用配置恢复'); }
  try { await domain.restore(snapshot); }
  catch { throw protectedProblem('当前结构下的保留配置恢复失败，需要 reset 恢复备份'); }
}


function privateConfigurationName(config: ProtectedRoot, path: string): string {
  const file = relative(resolve(config.dataDir), resolve(path));
  const parsed = ProtectedConfigurationReceipt.safeParse({ file, sha256: '0'.repeat(64), bytes: 1 });
  if (!parsed.success) throw protectedProblem('受保护配置路径不在指定私有目录内');
  return file.slice(PRIVATE_CONFIG_DIRECTORY.length + 1);
}

export interface ResetConfigurationPorts {
  exportConfiguration(path: string): Promise<void>;
  restoreConfiguration(path: string): Promise<void>;
  applyDefinition(path: string): Promise<void>;
}
export interface DomainResetConfigurationOptions<State> extends ProtectedRoot {
  domain: ProtectedConfigurationDomain<State>;
  /** Existing public apply orchestration, bound to the new database and closed before resolving; reject on differences. */
  applyDefinition(path: string): Promise<void>;
}

/** Owner DSN for the same database name before and after reset; records opens and closes each operation's pool. */
export interface CurrentResetConfigurationOptions {
  config: RecordsConfig;
  applyDefinition(path: string): Promise<void>;
}
export type ResetConfigurationOptions<State = ConfigurationSnapshot> = DomainResetConfigurationOptions<State> | CurrentResetConfigurationOptions;

/** Composition entry for server/api: platform receives callbacks, and imports no server implementation. */
export function createResetConfigurationPorts<State = ConfigurationSnapshot>(options: ResetConfigurationOptions<State>): ResetConfigurationPorts {
  if ('config' in options) {
    return createResetConfigurationPorts<ConfigurationSnapshot>({
      dataDir: options.config.dataDir,
      domain: {
        capture: async () => (await import('../records/api.ts')).exportConfigurationSnapshot(options.config),
        validate: async input => (await import('../records/api.ts')).validateConfigurationSnapshot(input),
        restore: async snapshot => (await import('../records/api.ts')).restoreConfigurationSnapshot(options.config, snapshot),
      },
      applyDefinition: path => options.applyDefinition(path),
    });
  }
  return {
    exportConfiguration: async path => { await exportProtectedConfiguration(options, options.domain, path); },
    restoreConfiguration: async path => {
      let receipt: ProtectedConfigurationReceipt;
      try {
        const name = privateConfigurationName(options, path);
        const directory = await privateConfigurationDirectory(options, false);
        const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) throw new Error();
          const bytes = await handle.readFile();
          receipt = { file: `${PRIVATE_CONFIG_DIRECTORY}/${name}`, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
        } finally { await handle.close(); }
      } catch { throw protectedProblem('受保护配置文件不可用，未调用配置恢复'); }
      await applyProtectedConfiguration(options, receipt, options.domain);
    },
    applyDefinition: async path => {
      try { await options.applyDefinition(path); }
      catch { throw protectedProblem('部署定义恢复未完成，需要 reset 恢复备份'); }
    },
  };
}
