// Verified declaration collection through the records transaction; no execution, credentials or lease-history inference.
import { PackManifest, WorkflowFile } from '../../contracts/src/pack.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { idOf } from '../../contracts/src/common.ts';
import { PACK_FILE_PATHS } from '../../contracts/generated/protocol.ts';
import { PACK_VERSION_SCHEMA, parsePackRef, type PackVersionBody } from '../runs/api.ts';
import {
  WHOLE_HUB, sha256Hex, canonicalBytes, parseStrictJson,
  type Page, type StoredRecord, type TestEnvironmentInheritanceContext,
  type TestEnvironmentInheritanceInput, type TestEnvironmentInheritanceSources,
} from '../records/api.ts';

const ExecutorId = idOf('exe');
const workflowPath = PACK_FILE_PATHS.find(path => path === 'workflow.json')!;

export function environmentPermissionSources(): TestEnvironmentInheritanceSources {
  return { collect: collectEnvironmentPermissionSources };
}

export async function collectEnvironmentPermissionSources(ctx: TestEnvironmentInheritanceContext): Promise<TestEnvironmentInheritanceInput> {
  const at = Date.parse(ctx.at);
  const latest = new Map<string, typeof ctx.authorizations[number]>();
  const owners = new Map<string, string>();
  const key = (permission: string, subject: string, object: string) => JSON.stringify([permission, subject, object]);
  for (const row of ctx.authorizations) {
    const body = row.body;
    latest.set(key(body.permission, body.subject, body.object), row);
    if (body.permission === 'publish' && !body.revoked && body.bound !== null) {
      const ref = parsePackRef(body.object);
      if (ref?.version && !owners.has(ref.id)) owners.set(ref.id, body.subject);
    }
  }
  const active = (row: typeof ctx.authorizations[number]) => !row.body.revoked &&
    (row.body.expires_at === null || Date.parse(row.body.expires_at) > at);
  const workflows: TestEnvironmentInheritanceInput['workflows'][number][] = [];
  const sourceRecords = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Page<StoredRecord<PackVersionBody>> = await ctx.store.list<PackVersionBody>({ kind: 'pack_version', limit: 500, newestFirst: false, cursor }, ctx.tx);
    for (const row of page.items) {
      const manifest = PackManifest.parse(row.body.manifest);
      if (row.schema !== PACK_VERSION_SCHEMA || manifest.id !== row.body.pack || manifest.version !== row.body.version ||
          manifest.kind !== row.body.kind || sha256Hex(canonicalBytes(manifest)) !== row.body.digest) {
        throw new Error('已发布包的记录与清单不一致，不能保留测试环境分配');
      }
      const installation = latest.get(key('assign', WHOLE_HUB, manifest.id));
      const installedMethod = manifest.kind === 'skill' && installation !== undefined && active(installation) && installation.body.bound === row.body.digest;
      if (manifest.kind !== 'workflow' && !installedMethod) continue;
      const owner = owners.get(manifest.id);
      const publication = owner === undefined ? undefined : latest.get(key('publish', owner, `${manifest.id}@${manifest.version}`));
      if (!publication || !active(publication) || publication.body.bound !== row.body.digest) continue;
      seen.add(`${manifest.id}@${manifest.version}`);
      const file = manifest.files.find(entry => entry.path === workflowPath);
      if (!file) {
        if (manifest.kind === 'skill') continue;
        throw new Error('已发布工作流缺少正式预订声明文件');
      }
      const bytes = await ctx.objects.get(file.sha256, ctx.tx);
      if (!bytes || bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) throw new Error('已发布工作流声明原件缺失或摘要不符');
      const declaration = WorkflowFile.parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
      if (!declaration.leases) continue;
      const references = [row.digest, publication.digest, ...(installedMethod ? [installation!.digest] : [])];
      references.forEach(reference => sourceRecords.add(reference));
      workflows.push({ id: manifest.id, prefix: declaration.leases.prefix, installedMethod, sourceRecords: references });
    }
    cursor = page.next;
  } while (cursor !== null);
  const assignedPacks = new Set([...latest.values()].filter(row => row.body.permission === 'assign' && active(row)).map(row => row.body.object));
  for (const row of latest.values()) {
    if (row.body.permission !== 'publish' || !active(row)) continue;
    const ref = parsePackRef(row.body.object);
    if (!ref?.version || !assignedPacks.has(ref.id) || owners.get(ref.id) !== row.body.subject || seen.has(row.body.object)) continue;
    const body = row.body.bound === null ? null : await ctx.store.find<PackVersionBody>({ kind: 'pack_version', key: 'pack.digest', value: row.body.bound, limit: 2 }, ctx.tx);
    if (!body || body.items.length !== 1 || body.items[0].body.pack !== ref.id || body.items[0].body.version !== ref.version || body.items[0].body.kind === 'workflow') {
      throw new Error('有效分配所依赖的发布原件缺失或不符，不能当成没有分配');
    }
  }
  const executors: ExecutorSource[] = [];
  for (const row of latest.values()) {
    if (row.body.permission !== 'resource_config' || row.body.subject !== WHOLE_HUB || !row.body.object.startsWith('executor.') || !active(row)) continue;
    const id = ExecutorId.parse(row.body.object.slice('executor.'.length));
    if (row.body.bound === null) throw new Error('执行器登记缺少源定义引用');
    const bytes = await ctx.objects.get(row.body.bound, ctx.tx);
    if (!bytes || sha256Hex(bytes) !== row.body.bound) throw new Error('执行器源定义原件缺失或摘要不符');
    const source = ExecutorSource.parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if (source.id !== id) throw new Error('执行器源定义身份与登记不符');
    executors.push(source);
    sourceRecords.add(row.digest);
  }
  return { workflows, executors, sourceRecords: [...sourceRecords].sort() };
}
