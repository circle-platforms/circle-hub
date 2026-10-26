import type { PermissionRole } from '../../../contracts/generated/vocabulary.ts';
// Test harness of the quality-board pack against the real Hub parts (not part of the pack): a records kit in a temporary
// PostgreSQL, the real pack registry (publish check included) and run engine, a synthetic product pack of a line named FAMX
// and FAMY, a knowledge base with one build and root, and a fake knowledge reader serving a hand-built facet view.
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

export const ROOT = sha('quality-board synthetic root of Rel_FAMX_10_6_1_57');

/** The one build the synthetic knowledge base knows, with a root: what a run bound to the line locks. */
export const BUILD: KnownBuild = {
  name: 'Rel_FAMX_10_6_1_57',
  family: 'FAMX',
  line: '10.6.1',
  base: 'Rel_FAMX_10_6_1_57',
  platform: null,
  built_at: '2026-09-01T00:00:00.000Z',
  released_at: '2026-09-02T00:00:00.000Z',
  sources: {},
  root: ROOT,
};

/** A KnowledgePort with one build of line famx; the quality-board pack reads the views through the external reader. */
export class OneBuildKnowledge implements KnowledgePort {
  async builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]> {
    return product === 'famx' && (filter?.line === undefined || filter.line === BUILD.line) ? [BUILD] : [];
  }
  async resolveBuild(product: string, name: string): Promise<KnownBuild | null> {
    return product === 'famx' && name.toLowerCase() === BUILD.name.toLowerCase() ? BUILD : null;
  }
  async currentRoot(product: string, line: string): Promise<RootInfo | null> {
    return product === 'famx' && line === BUILD.line ? this.info() : null;
  }
  async rootOfBuild(product: string, name: string): Promise<RootInfo | null> {
    return (await this.resolveBuild(product, name)) === null ? null : this.info();
  }
  async rootInfo(root: string): Promise<RootInfo[]> {
    return root === ROOT ? [this.info()] : [];
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
  private info(): RootInfo {
    return { root: ROOT, composition: sha('composition of Rel_FAMX_10_6_1_57'), product: 'famx', build: BUILD, produced_at: '2026-09-03T00:00:00.000Z' };
  }
}

/** A fake knowledge reader: serves knowledge:facets ids from hand-built views, stored through the records' artifacts. */
export class FakeKnowledgeViews implements ExternalReaderPort {
  readonly views = new Map<string, Record<string, unknown>>();
  readonly reads: string[] = [];
  readonly #artifacts: Artifacts;
  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }
  put(id: string, view: Record<string, unknown>): void {
    this.views.set(id, view);
  }
  async accepts(id: string): Promise<boolean> {
    return id.startsWith('knowledge:facets:');
  }
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    const view = this.views.get(id);
    if (view === undefined) return { ok: false, id, reason: `synthetic knowledge reader answered “not found” for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const ingest = (bytes: Uint8Array, name: string) =>
      this.#artifacts.ingest({ bytes, mediaType: 'application/json', origin: { generated: { generator: 'knowledge.views@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected', visibility, name });
    const bytes = new TextEncoder().encode(JSON.stringify(view));
    const artifacts = [
      { name: 'original', artifact: await ingest(bytes, 'facet-view.json') },
      { name: 'meta', artifact: await ingest(new TextEncoder().encode(JSON.stringify({ title: '合成视图', view: 'facets', product: 'famx', roots: [ROOT], revision: ROOT })), 'index-view-meta.json') },
    ];
    return { ok: true, id, revision: ROOT, artifacts, manifest: 'synthetic' };
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
  views: FakeKnowledgeViews;
  admin: Principal;
  alice: Principal;
  /** A user the pack is not assigned to. */
  bob: Principal;
  logs: AdminLogEntry[];
  root: string;
  close(): Promise<void>;
}

let traces = 1;
export const call = (session = 'sess-quality-board') => ({ traceId: `4bf92f3577b34da6a3ce929d0e0e${(traces++).toString(16).padStart(4, '0')}`, sessionId: session });

/** Opens the Hub parts, publishes the staged quality-board pack and the product pack, activates and assigns them. */
export async function openHub(postgres: TemporaryPostgres): Promise<Hub> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('quality-board-hub-');
  const root = temp.path;
  try {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const alice = await kit.principals.createUser(admin, '甲');
    const bob = await kit.principals.createUser(admin, '乙');
    await kit.authorizations.grantPublishRight(admin, alice.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(root, 'extracted'), now });
    const published = await registry.publish(alice, await stage(join(root, 'quality-board')));
    if (!published.ok) throw new Error(`quality-board was not published: ${JSON.stringify(published.problems, null, 1)}`);
    const product = await registry.publish(alice, (await writePack(join(root, 'famx'), PRODUCT)).dir);
    if (!product.ok) throw new Error(`the product pack was not published: ${JSON.stringify(product.problems, null, 1)}`);
    await registry.activate(admin, 'famx');
    await registry.assign(admin, alice.id, 'quality-board');
    const views = new FakeKnowledgeViews(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: new OneBuildKnowledge(),
      external: views,
      now,
      adminLog: (entry) => logs.push(entry),
    });
    const principal = (u: { id: string; name: string; role: PermissionRole }): Principal => ({ id: u.id, name: u.name, role: u.role });
    return {
      kit,
      registry,
      service,
      views,
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
