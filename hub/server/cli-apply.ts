import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DeploymentDefinition, type DeploymentDefinition as Definition } from '../../contracts/src/deployment.ts';
import { PackManifest } from '../../contracts/src/pack.ts';
import { ResourceRecord } from '../../contracts/src/resources.ts';
import { SecretReference } from '../../contracts/src/variables.ts';
import { canonicalBytes, parseStrictJson, sha256Hex, WHOLE_HUB } from '../records/api.ts';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { jsonSafe } from './assemble/terminal.ts';
import { packCommand } from './cli-pack.ts';
import { CliError, UsageError } from './errors.ts';
import type { Session } from './cli-session.ts';

export const APPLY_USAGE = 'apply <部署定义.json>（已有定义相同则跳过，差异列出字段，不覆盖）';
export const EXPORT_USAGE = 'export（导出部署定义，不包含密钥值、令牌、密码或密钥库内容）';

export function parseDeployment(input: unknown): Definition {
  const parsed = DeploymentDefinition.safeParse(input);
  if (!parsed.success) throw new UsageError('部署定义不合格式：' + parsed.error.issues.map(issue => issue.path.join('/')).join('、'));
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
  return parseDeployment({ schema: 'deployment@1',
    accounts: users.map(({ id, name, role, disabled }) => ({ id, name, role, disabled })),
    teams: await Promise.all(teams.map(async team => ({ id: team.id, name: team.name, members: (await records.teams.members(by, team.id)).map(member => member.user.id) }))),
    packs: packDefinitions,
    resources, executors: (await new ExecutorRegistry(records).sources(by)).map(entry => entry.source),
    workflowAssignments, resourceAssignments, knowledgeSources: packs.filter(pack => pack.kind === 'product' && pack.active).map(pack => pack.id),
  });
}

export interface DeploymentReport { created: number; skipped: number; differences: Array<{ section: string; index: number; fields: string[] }>; }

export async function applyDeployment(session: Session, input: unknown, base = session.ctx.io.cwd): Promise<DeploymentReport> {
  const definition = parseDeployment(input);
  const by = await session.admin(), records = await session.records(), hub = await session.hub(false, true);
  const packs = await loadPacks(session, definition, base);
  const current = await exportDeployment(session);
  const report: DeploymentReport = { created: 0, skipped: 0, differences: [] };
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
  session.out(`已配置 ${report.created} 项；相同跳过 ${report.skipped} 项；差异 ${report.differences.length} 项`);
  return report.differences.length ? 1 : 0;
}

export async function exportCommand(session: Session, args: readonly string[]): Promise<number> {
  if (args.length) throw new UsageError(EXPORT_USAGE);
  const definition = await exportDeployment(session);
  session.ctx.io.stdout(jsonSafe(JSON.stringify(definition, null, 2)));
  return 0;
}
