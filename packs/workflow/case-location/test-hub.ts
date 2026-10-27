import {installMindmapFixture} from '../../../hub/testing/skills.ts';
import type { PermissionRole } from '../../../contracts/generated/vocabulary.ts';
// Test harness of the case-location pack against the real Hub parts (not part of the pack): a records kit in a temporary
// PostgreSQL, the real pack registry (publish check included) and run engine, a synthetic product pack of a line named FAMX
// and FAMY, and small fakes of the ports the pack does not exercise for real: a knowledge base with one build and root,
// and external systems that serve invented agile mind maps (with their tree facts as meta) and PLM stories and bugs.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, KnowledgePort, NodesPage, RootDiff, RootInfo } from '../../../hub/ports.ts';
import type { Artifacts, Principal } from '../../../hub/records/api.ts';
import type { TreeReader } from '../../../hub/refs/api.ts';
import type { CatalogView } from '../../../hub/rules/api.ts';
import {
  createPackRegistry,
  createPacksPort,
  createRunsService,
  createWorkflowStore,
  temporaryDirectory,
  writePack,
  type AdminLogEntry,
  type PackRegistry,
  type RunsEngine,
} from '../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { stage } from './pack-files.ts';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ROOT = sha('synthetic root of Rel_FAMX_10_6_1_57');

/** The build a run bound to the line locks (the newest released build with a root). */
export const BUILD: KnownBuild = {
  name: 'Rel_FAMX_10_6_1_57',
  family: 'FAMX',
  line: '10.6.1',
  base: 'Rel_FAMX_10_6_1_57',
  platform: null,
  built_at: '2026-09-01T00:00:00.000Z',
  released_at: '2026-09-10T00:00:00.000Z',
  sources: {},
  root: ROOT,
};

/**
 * Every build the synthetic knowledge base knows of the line: both name families (the FAMY alias released before its base,
 * so the default lock stays on BUILD), a newer released build without a root (1_60) and an unreleased one (1_63), and a
 * build of another line (10.7.4).
 */
export const BUILDS: KnownBuild[] = [
  BUILD,
  // The real-data finding: a released build of the line the knowledge base knows by name only (no tree, no base
  // text, no root) — registered by the sync as a name-only build, still a build candidate.
  { name: 'Rel_FAMY_10_6_1_11', family: 'FAMY', line: '10.6.1', base: 'Rel_FAMY_10_6_1_11', platform: null, built_at: '2026-08-01T00:00:00.000Z', released_at: '2026-08-02T00:00:00.000Z', sources: {}, root: null },
  { name: 'Rel_FAMY_10_6_1_57', family: 'FAMY', line: '10.6.1', base: 'Rel_FAMX_10_6_1_57', platform: null, built_at: '2026-09-01T00:00:00.000Z', released_at: '2026-09-05T00:00:00.000Z', sources: {}, root: ROOT },
  { name: 'Rel_FAMX_10_6_1_60', family: 'FAMX', line: '10.6.1', base: 'Rel_FAMX_10_6_1_60', platform: null, built_at: '2026-09-18T00:00:00.000Z', released_at: '2026-09-20T00:00:00.000Z', sources: {}, root: null },
  { name: 'Rel_FAMX_10_6_1_63', family: 'FAMX', line: '10.6.1', base: 'Rel_FAMX_10_6_1_63', platform: null, built_at: '2026-09-25T00:00:00.000Z', released_at: null, sources: {}, root: null },
  { name: 'Rel_FAMX_10_7_4_101', family: 'FAMX', line: '10.7.4', base: 'Rel_FAMX_10_7_4_101', platform: null, built_at: '2026-05-01T00:00:00.000Z', released_at: '2026-05-02T00:00:00.000Z', sources: {}, root: sha('synthetic root of Rel_FAMX_10_7_4_101') },
];

/** A KnowledgePort with a handful of builds of line famx; the location pack reads the builds through the run context. */
export class SyntheticKnowledge implements KnowledgePort {
  async builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]> {
    if (product !== 'famx') return [];
    return BUILDS.filter((b) => (filter?.line === undefined || b.line === filter.line) && (filter?.released === undefined || (b.released_at !== null) === filter.released));
  }
  async resolveBuild(product: string, name: string): Promise<KnownBuild | null> {
    if (product !== 'famx') return null;
    const key = name.toLowerCase();
    const found = BUILDS.find((b) => b.name.toLowerCase() === key);
    if (found === undefined) return null;
    return found.base === found.name ? found : (BUILDS.find((b) => b.name === found.base) ?? null);
  }
  async currentRoot(product: string, line: string): Promise<RootInfo | null> {
    if (product !== 'famx') return null;
    const newest = BUILDS.filter((b) => b.line === line && b.root !== null && b.released_at !== null).sort((a, b) => (b.released_at as string).localeCompare(a.released_at as string))[0];
    return newest === undefined ? null : this.rootOfBuild(product, newest.name);
  }
  async rootOfBuild(product: string, name: string): Promise<RootInfo | null> {
    const build = await this.resolveBuild(product, name);
    if (build === null || build.root === null) return null;
    return { root: build.root, composition: sha(`composition of ${build.name}`), product, build, produced_at: '2026-09-21T00:00:00.000Z' };
  }
  async rootInfo(root: string): Promise<RootInfo[]> {
    const out: RootInfo[] = [];
    for (const build of BUILDS) {
      if (build.root !== root || build.base !== build.name) continue;
      const info = await this.rootOfBuild('famx', build.name);
      if (info !== null) out.push(info);
    }
    return out;
  }
  async catalog(): Promise<CatalogView | null> {
    return null;
  }
  treeReader(): TreeReader {
    return { read: () => null, readEntry: () => null };
  }
  async getNodes(): Promise<NodesPage | null> {
    return null;
  }
  async diffRoots(): Promise<RootDiff | null> {
    return null;
  }
  async diffEntries(): Promise<null> {
    return null;
  }
}

export interface FakeObject {
  bytes: Uint8Array;
  mediaType: string;
  /** Becomes the `meta` artifact: what the system pack derived (an agile mind map: title, ancestors, root). */
  meta?: Record<string, unknown>;
}

/** External systems serving agile:mindmap and plm objects, stored through the records' artifacts like a connector does. */
export class FakeExternal implements ExternalReaderPort {
  readonly objects = new Map<string, FakeObject>();
  readonly reads: string[] = [];
  readonly #artifacts: Artifacts;
  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }
  put(id: string, object: FakeObject): void {
    this.objects.set(id, object);
  }
  async accepts(id: string): Promise<boolean> {
    return id.startsWith('agile:mindmap:') || id.startsWith('plm:story:') || id.startsWith('plm:bug:');
  }
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    const object = this.objects.get(id);
    if (object === undefined) return { ok: false, id, reason: `synthetic system answered “not found” for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const ingest = (bytes: Uint8Array, mediaType: string, name: string) =>
      this.#artifacts.ingest({ bytes, mediaType, origin: { read: { object: `${id}@1` } }, author: { user: null }, provenanceType: 'observed', visibility, name });
    const artifacts = [{ name: 'original', artifact: await ingest(object.bytes, object.mediaType, id) }];
    if (object.meta !== undefined) artifacts.push({ name: 'meta', artifact: await ingest(new TextEncoder().encode(JSON.stringify(object.meta)), 'application/json', `${id} meta`) });
    return { ok: true, id, revision: '1', artifacts, manifest: 'synthetic' };
  }
}

/** A synthetic product pack: one line, its names, no catalogs and no producers. */
function productPack(id: string, title: string, names: string[]) {
  return {
    id,
    version: '1.0.0',
    kind: 'product' as const,
    title,
    description: '测试用的合成产品包：一条产品线和它的名字',
    files: { 'product.json': { schema: 'product@1', id, title, names, catalogs: [], producers: [] } },
  };
}

const PRODUCT = productPack('famx', '合成的 FAMX/FAMY 产品线', ['FAMX', 'FAMY']);

export interface Hub {
  kit: TestRecordsKit;
  registry: PackRegistry;
  service: RunsEngine;
  external: FakeExternal;
  admin: Principal;
  alice: Principal;
  /** A user the pack is not assigned to. */
  bob: Principal;
  logs: AdminLogEntry[];
  root: string;
  close(): Promise<void>;
}

/** Publishes and activates another synthetic product line (alice publishes, the admin activates). */
export async function publishProduct(hub: Hub, product: { id: string; title: string; names: string[] }): Promise<void> {
  const published = await hub.registry.publish(hub.alice, (await writePack(join(hub.root, `product-${product.id}`), productPack(product.id, product.title, product.names))).dir);
  if (!published.ok) throw new Error(`the product pack ${product.id} was not published: ${JSON.stringify(published.problems, null, 1)}`);
  await hub.registry.activate(hub.admin, product.id);
}

let traces = 1;
export const call = (session = 'sess-location') => ({ traceId: `4bf92f3577b34da6a3ce929d0e0e${(traces++).toString(16).padStart(4, '0')}`, sessionId: session });

/** Opens the Hub parts, publishes the staged case-location pack and the product pack, activates and assigns them. */
export async function openHub(postgres: TemporaryPostgres): Promise<Hub> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('case-location-hub-');
  const root = temp.path;
  try {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const alice = await kit.principals.createUser(admin, '甲');
    const bob = await kit.principals.createUser(admin, '乙');
    await kit.authorizations.grantPublishRight(admin, alice.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(root, 'extracted'), now });
    const parsers=await installMindmapFixture(registry,kit,admin);
    const published = await registry.publish(alice, await stage(join(root, 'case-location')));
    if (!published.ok) throw new Error(`case-location was not published: ${JSON.stringify(published.problems, null, 1)}`);
    const product = await registry.publish(alice, (await writePack(join(root, 'famx'), PRODUCT)).dir);
    if (!product.ok) throw new Error(`the product pack was not published: ${JSON.stringify(product.problems, null, 1)}`);
    await registry.activate(admin, 'famx');
    await registry.assign(admin, alice.id, 'case-location');
    const external = new FakeExternal(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      parsers,
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: new SyntheticKnowledge(),
      external,
      now,
      adminLog: (entry) => logs.push(entry),
    });
    const principal = (u: { id: string; name: string; role: PermissionRole }): Principal => ({ id: u.id, name: u.name, role: u.role });
    return {
      kit,
      registry,
      service,
      external,
      admin: principal(admin),
      alice: principal(alice),
      bob: principal(bob),
      logs,
      root,
      async close() {
        await kit.close();
        await temp.remove();
      },
    };
  } catch (error) {
    await kit.close();
    await temp.remove();
    throw error;
  }
}
