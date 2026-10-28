import {installMindmapFixture, installWorkbookFixture} from '../../../../hub/testing/skills.ts';
import {commandTokens} from '../../../../contracts/generated/command-grammar.ts';
import {catalogFor,SYNTHETIC_COMMAND_POLICY} from './command-catalog.ts';
import {COMMAND_IDENTITIES} from '../functions/test-support.ts';
// Test harness of the case-compile pack against the real Hub parts: a fake external reader serving the synthetic
// case document (agile:mindmap) and the two named documents (doc:doc), a fake knowledge port answering the command
// catalog of the locked build, and the staged pack published into a temporary registry.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { KnownBuild } from '../../../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, KnowledgePort, NodesPage, RootDiff, RootInfo } from '../../../../hub/ports.ts';
import type { Artifacts, Principal } from '../../../../hub/records/api.ts';
import type { TreeReader } from '../../../../hub/refs/api.ts';
import {createCatalogView, buildCatalog, type CatalogView } from '../../../../hub/rules/api.ts';
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
} from '../../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { LeaseService } from '../../../../hub/leases/service.ts';
import { createPool, Database } from '../../../../hub/records/db.ts';
import { stage } from '../pack-files.ts';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ROOT = sha('synthetic root of Fixture_Build_A');

export const BUILD: KnownBuild = {
  name: 'Fixture_Build_A',
  family: 'Widget',
  line: 'fixture-line',
  base: 'Fixture_Build_A',
  platform: null,
  built_at: '2026-09-01T00:00:00.000Z',
  released_at: '2026-09-02T00:00:00.000Z',
  sources: {},
  root: ROOT,
};

const CATALOG_SPEC = {
  root: ROOT,
  complete: true,
  entries: [
    { head: 'widget health interval', signatures: [{ params: [{ name: 'seconds', type: 'int' as const, minimum: 1, maximum: 300 }] }], summary: 'set the health check interval' },
    { head: 'widget session persistence', signatures: [{ params: [{ name: 'mode', type: 'enum' as const, values: ['source-address', 'cookie'] }] }], summary: 'set the persistence mode' },
  ],
};

export class FakeKnowledge implements KnowledgePort {
  fullCatalogReads=0;selectedCatalogReads=0;treeReads:string[]=[];
  readonly #catalogView: CatalogView = createCatalogView(catalogFor(COMMAND_IDENTITIES,ROOT).entries,{reference:`tree:${ROOT}/commands`,complete:true,caseSensitive:true});

  async builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]> {
    return product === 'widget' && (filter?.line === undefined || filter.line === BUILD.line) ? [BUILD] : [];
  }
  async resolveBuild(product: string, name: string): Promise<KnownBuild | null> {
    return product === 'widget' && name.toLowerCase() === BUILD.name.toLowerCase() ? BUILD : null;
  }
  async currentRoot(product: string, line: string): Promise<RootInfo | null> {
    return product === 'widget' && line === BUILD.line ? this.info() : null;
  }
  async rootOfBuild(product: string, name: string): Promise<RootInfo | null> {
    return (await this.resolveBuild(product, name)) === null ? null : this.info();
  }
  async rootInfo(root: string): Promise<RootInfo[]> {
    return root === ROOT ? [this.info()] : [];
  }
  async catalog(root: string, id: string,selection?:{base:string;lines:string[]}): Promise<CatalogView | null> {
    if(root!==ROOT||id!=='commands@1')return null;
    if(selection)this.selectedCatalogReads++;else this.fullCatalogReads++;
    return selection?createCatalogView(this.#catalogView.entries().filter(entry=>selection.lines.some(line=>{const tokens=commandTokens(line);return tokens&&entry.words.every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted);})),{reference:`tree:${ROOT}/commands`,complete:true,caseSensitive:true}):this.#catalogView;
  }
  treeReader(): TreeReader {
    return { read: (root,path,entry) => {this.treeReads.push(root+path+'@'+entry);return null;}, readEntry: () => null };
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
    return { command_policy:structuredClone(SYNTHETIC_COMMAND_POLICY),root: ROOT, composition: sha('composition of Fixture_Build_A'), product: 'widget', build: BUILD, produced_at: '2026-09-03T00:00:00.000Z' };
  }
}

export interface FakeObject {
  bytes: Uint8Array;
  mediaType: string;
  meta?: Record<string, unknown>;
}

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
    return id.startsWith('agile:mindmap:') || id.startsWith('doc:doc:') || id.startsWith('knowledge:index:');
  }
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    const object = this.objects.get(id);
    if (object === undefined) return { ok: false, id, reason: `synthetic system answered “not found” for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const artifact = await this.#artifacts.ingest({
      bytes: object.bytes,
      mediaType: object.mediaType,
      origin: { read: { object: `${id}@1` } },
      author: { user: null },
      provenanceType: 'observed',
      visibility,
      name: id,
    });
    return { ok: true, id, revision: '1', artifacts: [{ name: 'original', artifact }], manifest: 'synthetic' };
  }
}

function productPack(id: string, title: string, names: string[]) {
  return {
    id,
    version: '1.0.0',
    kind: 'product' as const,
    title,
    description: '测试用的合成产品包',
    files: { 'product.json': { schema: 'product@1', id, title, names, catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: false }], producers: [] } },
  };
}

export interface Hub {
  kit: TestRecordsKit;
  registry: PackRegistry;
  service: RunsEngine;
  knowledge:FakeKnowledge;
  external: FakeExternal;
  admin: Principal;
  alice: Principal;
  bob: Principal;
  logs: AdminLogEntry[];
  close(): Promise<void>;
}

let traces = 1;
export const call = (session = 'sess-case-compile') => ({
  traceId: `4bf92f3577b34da6a3ce929d0e1e${(traces++).toString(16).padStart(4, '0')}`,
  sessionId: session,
});

export async function openHub(postgres: TemporaryPostgres): Promise<Hub> {
  let clock = Date.parse('2026-10-23T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('case-compile-hub-');
  try {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const alice = await kit.principals.createUser(admin, '甲');
    const bob = await kit.principals.createUser(admin, '乙');
    await kit.authorizations.grantPublishRight(admin, alice.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(temp.path, 'extracted'), now });
    const parsers=await installMindmapFixture(registry,kit,admin);
    await installWorkbookFixture(registry,kit,admin);
    const staged = await stage(join(temp.path, 'case-compile'));
    const published = await registry.publish(alice, staged);
    if (!published.ok) throw new Error(`case-compile was not published: ${JSON.stringify(published.problems, null, 1)}`);
    const product = await registry.publish(alice, (await writePack(join(temp.path, 'widget'), productPack('widget', 'Widget', ['Widget', 'Gadget']))).dir);
    if (!product.ok) throw new Error(`product pack was not published: ${JSON.stringify(product.problems, null, 1)}`);
    await registry.activate(admin, 'widget');
    await registry.assign(admin, alice.id, 'case-compile');

    const external = new FakeExternal(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const knowledge=new FakeKnowledge();
    const service = createRunsService({
      parsers,
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge,
      external,
      leases: new LeaseService(new Database(createPool(kit.database, 2)), { now: async () => now() }),
      // This private synthetic database has no dispatch service or jobs.
      leaseJobs: async () => [],
      now,
      adminLog: (entry: AdminLogEntry) => logs.push(entry),
    });

    return {
      kit,
      registry,
      service,
      knowledge,
      external,
      admin,
      alice,
      bob,
      logs,
      close: async () => {
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
