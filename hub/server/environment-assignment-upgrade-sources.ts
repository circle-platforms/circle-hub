// Read only through the cutover's public transaction ports. No extraction, execution, secret resolution or network.
import { PackManifest, WorkflowFile } from '../../contracts/src/pack.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { idOf } from '../../contracts/src/common.ts';
import { PACK_FILE_PATHS } from '../../contracts/generated/protocol.ts';
import { PACK_VERSION_SCHEMA, parsePackRef, type PackVersionBody } from '../runs/api.ts';
import { WHOLE_HUB, sha256Hex, canonicalBytes, parseStrictJson, type ActionBody, type EnvironmentUpgradeReadContext, type EnvironmentUpgradeSources, type EnvironmentUpgradeSnapshot } from '../records/api.ts';
import { planEnvironmentAssignmentUpgrade } from './environment-assignment-upgrade.ts';

const ExecutorId = idOf('exe');
const workflowPath = PACK_FILE_PATHS.find(path => path === 'workflow.json')!;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function environmentAssignmentUpgradeSources(): EnvironmentUpgradeSources {
  return { collect: collectEnvironmentAssignmentUpgradeSnapshot, plan: planEnvironmentAssignmentUpgrade };
}

export async function collectEnvironmentAssignmentUpgradeSnapshot(ctx: EnvironmentUpgradeReadContext) {
  const at = Date.parse(ctx.at), sourceRecords = new Set(ctx.authorizations.map(row => row.digest));
  const latest = new Map<string, typeof ctx.authorizations[number]>(), owners = new Map<string, string>();
  for (const row of ctx.authorizations) {
    const body = row.body;
    latest.set(JSON.stringify([body.permission, body.subject, body.object]), row);
    if (body.permission === 'publish' && !body.revoked && body.bound !== null) {
      const ref = parsePackRef(body.object);
      if (ref?.version && !owners.has(ref.id)) owners.set(ref.id, body.subject);
    }
  }
  const enabled = (row: typeof ctx.authorizations[number]) => !row.body.revoked && (row.body.expires_at === null || Date.parse(row.body.expires_at) > at);
  const workflows: EnvironmentUpgradeSnapshot['workflows'][number][] = [];
  const seenPublications = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await ctx.store.list<PackVersionBody>({ kind: 'pack_version', limit: 500, newestFirst: false, cursor }, ctx.tx);
    for (const row of page.items) {
      const manifest = PackManifest.parse(row.body.manifest);
      if (row.schema !== PACK_VERSION_SCHEMA || manifest.id !== row.body.pack || manifest.version !== row.body.version || manifest.kind !== row.body.kind || sha256Hex(canonicalBytes(manifest)) !== row.body.digest)
        throw new Error('已发布包的记录与清单不一致，不能推导升级权限');
      const installation = latest.get(JSON.stringify(['assign', WHOLE_HUB, manifest.id]));
      const installedMethod = manifest.kind === 'skill' && installation !== undefined && enabled(installation) && installation.body.bound === row.body.digest;
      if (manifest.kind !== 'workflow' && !installedMethod) continue;
      const owner = owners.get(manifest.id), ref = `${manifest.id}@${manifest.version}`;
      const publication = owner === undefined ? undefined : latest.get(JSON.stringify(['publish', owner, ref]));
      if (!publication || !enabled(publication) || publication.body.bound !== row.body.digest) continue;
      seenPublications.add(ref); sourceRecords.add(row.digest);
      const file = manifest.files.find(entry => entry.path === workflowPath);
      if (!file) {
        if (manifest.kind === 'skill') continue;
        throw new Error('已发布工作流缺少正式声明文件，不能推导升级权限');
      }
      const bytes = await ctx.objects.get(file.sha256, ctx.tx);
      if (!bytes || bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) throw new Error('已发布工作流声明原件缺失或摘要不符');
      const declaration = WorkflowFile.parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
      workflows.push({ id: manifest.id, digest: row.body.digest, kind: manifest.kind, publishedAt: publication.body.decided_at, available: true, installedMethod, declaration: { context: declaration.context, leases: declaration.leases } });
    }
    cursor = page.next;
  } while (cursor !== null);
  // A permission to a missing published body must not silently become an empty entitlement.
  const neededPacks = new Set(ctx.members.flatMap(member => ctx.permissions.get(member.id)?.packs() ?? []));
  for (const row of latest.values()) if (row.body.permission === 'publish' && enabled(row)) {
    const ref = parsePackRef(row.body.object);
    if (ref?.version && neededPacks.has(ref.id) && owners.get(ref.id) === row.body.subject && !seenPublications.has(row.body.object)) {
      const known = await ctx.store.find<PackVersionBody>({ kind: 'pack_version', key: 'pack.digest', value: row.body.bound!, limit: 1 }, ctx.tx);
      if (!known.items.length || known.items[0].body.pack !== ref.id || known.items[0].body.version !== ref.version || known.items[0].body.kind === 'workflow') throw new Error('有效分配所依赖的发布原件缺失或不符，不能将缺事实当成无权限');
    }
  }

  const executors: EnvironmentUpgradeSnapshot['executors'][number][] = [];
  const executorSources = new Map<string, { digest: string; keys: readonly string[] }>();
  const first = new Map<string, typeof ctx.authorizations[number]>();
  for (const row of ctx.authorizations) if (row.body.permission === 'resource_config' && row.body.subject === WHOLE_HUB && row.body.object.startsWith('executor.') && !row.body.revoked && row.body.bound !== null && !first.has(row.body.object)) first.set(row.body.object, row);
  for (const row of latest.values()) {
    if (row.body.permission !== 'resource_config' || row.body.subject !== WHOLE_HUB || !row.body.object.startsWith('executor.') || !enabled(row)) continue;
    const id = ExecutorId.parse(row.body.object.slice('executor.'.length));
    if (!row.body.bound || !first.has(row.body.object)) throw new Error('执行器缺少原始登记事实');
    const bytes = await ctx.objects.get(row.body.bound, ctx.tx);
    if (!bytes || sha256Hex(bytes) !== row.body.bound) throw new Error('执行器源定义原件缺失或摘要不符');
    const source = ExecutorSource.parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if (source.id !== id) throw new Error('执行器源定义身份与登记不符');
    executors.push({ id, registeredAt: first.get(row.body.object)!.body.decided_at, keys: source.resources });
    executorSources.set(id, { digest: row.body.bound, keys: source.resources });
  }
  const holdings = ctx.holders.filter(row => !row.released && (row.expires_at === null || Date.parse(row.expires_at) > at));
  const runs = new Map<string, ReturnType<typeof RunRecord.parse>>();
  const readRun = async (id: string) => {
    let run = runs.get(id);
    if (!run) {
      const page = await ctx.store.find({ kind: 'run', key: 'runs.id', value: id, limit: 2 }, ctx.tx);
      if (page.items.length !== 1 || page.items[0].schema !== 'run@1') throw new Error('预订或派发所引运行原件缺失或歧义');
      run = RunRecord.parse(page.items[0].body);
      if (run.run !== id || run.pack_space !== undefined && run.pack_space !== 'team') throw new Error('预订运行身份或空间不符');
      sourceRecords.add(page.items[0].digest); runs.set(id, run);
    }
    return run;
  };

  const holdingBindings: NonNullable<EnvironmentUpgradeSnapshot['holdingBindings']>[number][] = [];
  cursor = null;
  do {
    const page = await ctx.store.find<ActionBody>({ kind: 'action', key: 'dispatch.phase', value: 'reservation', limit: 500, cursor }, ctx.tx);
    for (const row of page.items) {
      const binding = row.body.detail.binding;
      if (row.body.component !== 'dispatch@1' || row.body.detail.phase !== 'reservation' || !object(binding) || !Array.isArray(binding.fences)) continue;
      if (row.body.detail.read_only === true || !ExecutorId.safeParse(binding.executor).success || !object(binding.input) || row.body.run !== binding.input.run || row.body.detail.job !== binding.job) continue;
      const source = executorSources.get(String(binding.executor));
      if (!source || binding.executor_source_digest !== source.digest || !Array.isArray(binding.resources) || binding.resources.some(key => typeof key !== 'string')) continue;
      // Fences bind the exact holder/run/lease to this executor; key overlap and past grants are not identity evidence.
      for (const holder of holdings) {
        const fence = binding.fences.find(value => object(value) && value.key === holder.key && value.user === holder.user && value.run === holder.run && value.lease === holder.lease
          && Number.isSafeInteger(value.fencing) && Number(value.fencing) <= holder.fencing && Number(value.fencing) >= 1);
        if (!fence || binding.user !== holder.user || binding.input.user !== holder.user || !source.keys.includes(holder.key) || !binding.resources.includes(holder.key) || typeof binding.input.run !== 'string') continue;
        const heldRun = await readRun(holder.run);
        if (heldRun.runner !== holder.user || !heldRun.leases?.some(entry => (entry.op === undefined || entry.op === 'acquire' || entry.op === 'extend') && 'lease' in entry && entry.lease === holder.lease && entry.keys.includes(holder.key))) continue;
        let run = await readRun(binding.input.run);
        const visited = new Set<string>();
        while (run.run !== holder.run && run.predecessor !== undefined && !visited.has(run.run)) {
          if (run.runner !== holder.user) break;
          visited.add(run.run); run = await readRun(run.predecessor);
        }
        if (run.run !== holder.run || run.runner !== holder.user) continue;
        sourceRecords.add(row.digest);
        holdingBindings.push({ user: holder.user, run: holder.run, executor: String(binding.executor), record: row.digest });
      }
    }
    cursor = page.next;
  } while (cursor !== null);
  const effectiveAssignments: EnvironmentUpgradeSnapshot['effectiveAssignments'][number][] = [], revokedAssignments: EnvironmentUpgradeSnapshot['revokedAssignments'][number][] = [];
  for (const member of ctx.members) {
    const permission = ctx.permissions.get(member.id);
    if (!permission) throw new Error('缺少账户的同事务权限快照');
    for (const executor of executors) {
      const subjects = [member.id, ...permission.teams(), WHOLE_HUB];
      if (subjects.some(subject => permission.enabled(permission.latest('resource_assign', subject, executor.id)))) effectiveAssignments.push({ user: member.id, executor: executor.id });
      const direct = permission.latest('resource_assign', member.id, executor.id);
      if (direct?.body.revoked) revokedAssignments.push({ user: member.id, executor: executor.id });
    }
  }
  const snapshot: EnvironmentUpgradeSnapshot = { boundary: ctx.boundary, at: ctx.at,
    members: ctx.members.map(member => ({ id: member.id, created_at: member.created_at, disabled: member.disabled, deleted_at: member.deleted_at ?? null, packs: [...new Set([...ctx.permissions.get(member.id)!.packs(), ...workflows.filter(row => row.installedMethod).map(row => row.id)])].sort() })),
    workflows, executors, holdings: holdings.map(({ key, user, run, released, expires_at }) => ({ key, user, run, released, expires_at })), holdingBindings,
    effectiveAssignments, revokedAssignments,
  };
  return { snapshot, sourceRecords: [...sourceRecords].sort() };
}
