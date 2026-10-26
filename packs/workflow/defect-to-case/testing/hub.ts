// Test harness of the defect-to-case pack against the real Hub parts.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { KnownBuild } from '../../../../contracts/src/product.ts';
import type {
  ExternalRead,
  ExternalReadContext,
  ExternalReaderPort,
  KnowledgePort,
  NodesPage,
  RootDiff,
  RootInfo,
} from '../../../../hub/ports.ts';
import type { Artifacts, Principal } from '../../../../hub/records/api.ts';
import type { TreeReader } from '../../../../hub/refs/api.ts';
import { buildCatalog, type CatalogView } from '../../../../hub/rules/api.ts';
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
import { stage } from '../pack-files.ts';
import {
  MANUAL_PASSAGE,
  SYNTHETIC_BUG_74001,
  SYNTHETIC_BUG_71010_UNCHECKABLE,
  SYNTHETIC_CATALOG_SPEC,
  SYNTHETIC_INDEX_VIEW,
} from './fixtures.ts';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ROOT = sha('synthetic root of Rel_FAMX_10_6_1_57');

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

export class FakeKnowledge implements KnowledgePort {
  readonly #catalogView: CatalogView;
  constructor() {
    this.#catalogView = buildCatalog(SYNTHETIC_CATALOG_SPEC);
  }

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
  async catalog(root: string, id: string): Promise<CatalogView | null> {
    return root === ROOT && id === 'commands@1' ? this.#catalogView : null;
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
    return {
      root: ROOT,
      composition: sha('composition of Rel_FAMX_10_6_1_57'),
      product: 'famx',
      build: BUILD,
      produced_at: '2026-09-03T00:00:00.000Z',
    };
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
    return id.startsWith('plm:bug:') || id.startsWith('knowledge:index:') || id.startsWith('manual:cli:');
  }
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    let object = this.objects.get(id);
    let revision = '1';
    if (id.startsWith('knowledge:index:')) {
      const pinned = /@([a-f0-9]{64})$/.exec(id);
      const bare = pinned ? id.slice(0, -65) : id;
      const base = bare.split('?')[0];
      const source = this.objects.get(bare) ?? [...this.objects].find(([key]) => key.split('?')[0] === base)?.[1];
      if (source) {
        const view = JSON.parse(new TextDecoder().decode(source.bytes));
        revision = view.build.root;
        if (pinned && pinned[1] !== revision) return { ok: false, id, reason: 'synthetic pinned root is unavailable' };
        const query = new Map((bare.split('?')[1] ?? '').split('&').map(part => { const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)]; }));
        const only = query.get('only')?.split(',').map(decodeURIComponent);
        if (only) { view.only = [...new Set(only)].sort(); view.keys = Object.fromEntries(Object.entries(view.keys).filter(([key]) => only.includes(key))); }
        const hashes = new Set(Object.values(view.keys).flat());
        view.entries = Object.fromEntries(Object.entries(view.entries).filter(([key]) => hashes.has(key)));
        const fields = query.get('fields')?.split(',').map(decodeURIComponent);
        if (fields) {
          view.fields = fields;
          for (const entry of Object.values(view.entries) as Array<{data:Record<string,unknown>;statement:string}>) { entry.data = Object.fromEntries(Object.entries(entry.data).filter(([key]) => fields.includes(key))); entry.statement = ''; }
        }
        view.cut_keys = [];
        object = { bytes: Buffer.from(JSON.stringify(view)), mediaType: 'application/json' };
      }
    }
    if (object === undefined) return { ok: false, id, reason: `synthetic system answered “not found” for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const ingest = (bytes: Uint8Array, mediaType: string, name: string) =>
      this.#artifacts.ingest({
        bytes,
        mediaType,
        origin: { read: { object: `${id}@1` } },
        author: { user: null },
        provenanceType: 'observed',
        visibility,
        name,
      });
    const artifacts = [{ name: 'original', artifact: await ingest(object.bytes, object.mediaType, id) }];
    if (object.meta !== undefined) {
      artifacts.push({
        name: 'meta',
        artifact: await ingest(new TextEncoder().encode(JSON.stringify(object.meta)), 'application/json', `${id} meta`),
      });
    }
    return { ok: true, id, revision, artifacts, manifest: sha('synthetic read manifest') };
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
  external: FakeExternal;
  admin: Principal;
  alice: Principal;
  bob: Principal;
  logs: AdminLogEntry[];
  root: string;
  close(): Promise<void>;
}

let traces = 1;
export const call = (session = 'sess-defect-to-case') => ({
  traceId: `4bf92f3577b34da6a3ce929d0e0e${(traces++).toString(16).padStart(4, '0')}`,
  sessionId: session,
});

export async function openHub(postgres: TemporaryPostgres): Promise<Hub> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('defect-to-case-hub-');
  const root = temp.path;
  try {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const alice = await kit.principals.createUser(admin, '甲');
    const bob = await kit.principals.createUser(admin, '乙');
    await kit.authorizations.grantPublishRight(admin, alice.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(root, 'extracted'), now });
    const staged = await stage(join(root, 'defect-to-case'));
    const published = await registry.publish(alice, staged);
    if (!published.ok) throw new Error(`defect-to-case was not published: ${JSON.stringify(published.problems, null, 1)}`);

    const product = await registry.publish(alice, (await writePack(join(root, 'famx'), productPack('famx', 'FAMX', ['FAMX', 'FAMY']))).dir);
    if (!product.ok) throw new Error(`product pack was not published: ${JSON.stringify(product.problems, null, 1)}`);
    await registry.activate(admin, 'famx');
    await registry.assign(admin, alice.id, 'defect-to-case');

    const external = new FakeExternal(kit.artifacts);
    // Put synthetic bug 74001
    external.put('plm:bug:74001', {
      bytes: new TextEncoder().encode(JSON.stringify(SYNTHETIC_BUG_74001)),
      mediaType: 'application/json',
      meta: { title: `缺陷 74001 ${SYNTHETIC_BUG_74001.title}`, status: 'closed' },
    });
    // Put synthetic bug 71010
    external.put('plm:bug:71010', {
      bytes: new TextEncoder().encode(JSON.stringify(SYNTHETIC_BUG_71010_UNCHECKABLE)),
      mediaType: 'application/json',
      meta: { title: `缺陷 71010 ${SYNTHETIC_BUG_71010_UNCHECKABLE.title}`, status: 'closed' },
    });
    // Put synthetic index view
    const indexBytes = new TextEncoder().encode(JSON.stringify(SYNTHETIC_INDEX_VIEW));
    external.put('knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands', { bytes: indexBytes, mediaType: 'application/json' });
    // The narrowed spelling the run binds (only=<commands> + the fields the check compares).
    external.put('knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative', { bytes: indexBytes, mediaType: 'application/json' });
    // Put synthetic manual
    external.put('manual:cli:10.6.1', {
      bytes: new TextEncoder().encode(MANUAL_PASSAGE),
      mediaType: 'text/markdown',
    });

    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: new FakeKnowledge(),
      external,
      now,
      adminLog: (entry: AdminLogEntry) => logs.push(entry),
    });

    return {
      kit,
      registry,
      service,
      external,
      admin,
      alice,
      bob,
      logs,
      root,
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
