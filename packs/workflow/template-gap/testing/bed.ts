// A test bed for the template-gap pack on the real Hub packages (not part of the pack): a records kit in a temporary
// PostgreSQL database, an admin, the pack owner (with a publish right), a user the pack is assigned to and one it is not, the
// real registry/run engine, a synthetic product line with a commands@1 root and a frozen knowledge:index reader; the agile platform is a fake reader that stores what it reads
// the way a connector does (the answer as received, the inner document as content, title and folders as meta). Synthetic only.
import { join, dirname } from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import type { PermissionRole } from '../../../../contracts/generated/vocabulary.ts';
import type { Artifacts, Principal, SourceArtifact } from '../../../../hub/records/api.ts';
import type { CallContext, ExternalRead, ExternalReadContext, ExternalReaderPort, KnowledgePort } from '../../../../hub/ports.ts';
import {
  createPackRegistry,
  createPacksPort,
  createRunsService,
  createWorkflowStore,
  temporaryDirectory,
  writePack,
  type AdminLogEntry,
  type PackRegistry,
  type PublishOutcome,
  type RunsEngine,
} from '../../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { buildCatalog } from '../../../../hub/rules/api.ts';
import type { KnownBuild } from '../../../../contracts/src/product.ts';
import { ROOT, BUILD, PRODUCT, digest } from './index.ts';
import { PACK_DIR, PACK_ID, signManifest, readManifest, packFiles } from '../api.ts';

const knownBuild: KnownBuild = { name: BUILD, family: 'MEADOW', line: '10.6', base: BUILD, platform: null, built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: {}, root: ROOT };
export const SYNTHETIC_KNOWLEDGE: KnowledgePort = {
  builds: async product => product === PRODUCT ? [knownBuild] : [],
  resolveBuild: async (product, name) => product === PRODUCT && name === BUILD ? knownBuild : null,
  currentRoot: async (product, line) => product === PRODUCT && line === knownBuild.line ? { root: ROOT, composition: digest('synthetic composition'), product, build: knownBuild, produced_at: '2026-10-03T00:00:00.000Z' } : null,
  rootOfBuild: async (product, name) => product === PRODUCT && name === BUILD ? { root: ROOT, composition: digest('synthetic composition'), product, build: knownBuild, produced_at: '2026-10-03T00:00:00.000Z' } : null,
  rootInfo: async root => root === ROOT ? [{ root: ROOT, composition: digest('synthetic composition'), product: PRODUCT, build: knownBuild, produced_at: '2026-10-03T00:00:00.000Z' }] : [],
  catalog: async (root, catalog) => root === ROOT && catalog === 'commands@1' ? buildCatalog({ root: ROOT, complete: true, entries: [{ head: 'widget probe', reference: `tree:${ROOT}/CLI/widget/probe`, signatures: [[]] }] }) : null,
  treeReader: () => ({ read: () => null, readEntry: () => null }),
  getNodes: async () => null, diffRoots: async () => null, diffEntries: async () => null,
};

export interface AgileDocument {
  bytes: Uint8Array;
  title: string | null;
  folders: string[];
}

/** agile:mindmap:<id>: original (the platform's envelope with the document double-encoded), content and meta. */
export class FakeAgile implements ExternalReaderPort {
  readonly #artifacts: Artifacts;
  readonly documents = new Map<string, AgileDocument>();
  readonly reads: string[] = [];

  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }

  put(id: string, document: AgileDocument): string {
    this.documents.set(id, document);
    return `agile:mindmap:${id}`;
  }

  async accepts(id: string): Promise<boolean> {
    return id.startsWith('agile:mindmap:') || id.startsWith('knowledge:index:');
  }

  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    if (id.startsWith('knowledge:index:')) {
      const source = this.documents.get(id);
      if (!source) return { ok: false, id, reason: 'synthetic index is missing' };
      const artifact = await this.#artifacts.ingest({ bytes: source.bytes, mediaType: 'application/json', origin: { generated: { generator: 'knowledge.views@1', inputs: [] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [context.principal.id], admins: true, packs: [], shareable: false }, name: 'synthetic-index.json' });
      return { ok: true, id, revision: ROOT, artifacts: [{ name: 'original', artifact }], manifest: 'synthetic' };
    }
    const document = this.documents.get(id.slice('agile:mindmap:'.length));
    if (document === undefined) return { ok: false, id, reason: `synthetic agile platform answered code 1004 for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const envelope = new TextEncoder().encode(JSON.stringify({ code: 1000, msg: '成功', data: new TextDecoder().decode(document.bytes) }));
    const original = await this.#artifacts.ingest({ bytes: envelope, mediaType: 'application/json', origin: { read: { object: id } }, author: { user: null }, provenanceType: 'observed', visibility, name: id });
    const derived = (bytes: Uint8Array, name: string): Promise<SourceArtifact> =>
      this.#artifacts.ingest({
        bytes,
        mediaType: 'application/json',
        origin: { generated: { generator: 'agile-test.mindmap@1', inputs: [`src:${original.body.sha256}`] } },
        author: { user: null },
        provenanceType: 'projected',
        visibility,
        name,
      });
    const content = await derived(document.bytes, `${id} content`);
    const meta = await derived(new TextEncoder().encode(JSON.stringify({ title: document.title, folders: document.folders, found: true })), `${id} meta`);
    return {
      ok: true,
      id,
      revision: '1',
      artifacts: [
        { name: 'original', artifact: original },
        { name: 'content', artifact: content },
        { name: 'meta', artifact: meta },
      ],
      manifest: 'synthetic',
    };
  }
}

export interface Bed {
  kit: TestRecordsKit;
  registry: PackRegistry;
  service: RunsEngine;
  agile: FakeAgile;
  logs: AdminLogEntry[];
  admin: Principal;
  /** Owns the pack id and holds a publish right. */
  owner: Principal;
  /** Has the pack assigned. */
  runner: Principal;
  /** Does not have the pack assigned. */
  stranger: Principal;
  /** The publication of the staged pack. */
  publication: PublishOutcome;
  /** Stores bytes as an upload of this user and returns src:<sha256>. */
  upload(user: Principal, bytes: Uint8Array, name?: string): Promise<string>;
  call(session?: string | null): CallContext;
  close(): Promise<void>;
}

export interface BedOptions {
  /** Changes the staged copy before it is published; its pack.json is signed again afterwards. */
  edit?: (dir: string) => Promise<void>;
}

let traces = 1;
function traceId(): string {
  return (traces++).toString(16).padStart(32, '0').replace(/^0/, 'a');
}

const principal = (user: { id: string; name: string; role: PermissionRole }): Principal => ({ id: user.id, name: user.name, role: user.role });

export async function openBed(postgres: TemporaryPostgres, options: BedOptions = {}): Promise<Bed> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  // Extracted packs are read-only trees: this directory's remove() takes care of them.
  const temp = await temporaryDirectory('circle-hub-template-gap-');
  try {
    const admin = principal((await kit.principals.bootstrapAdmin('管理员')).user);
    const owner = principal(await kit.principals.createUser(admin, '包作者'));
    const runner = principal(await kit.principals.createUser(admin, '评审人'));
    const stranger = principal(await kit.principals.createUser(admin, '旁人'));
    await kit.authorizations.grantPublishRight(admin, owner.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(temp.path, 'extracted'), now });
    const staged = join(temp.path, 'staged');
    for (const file of await packFiles()) { await mkdir(dirname(join(staged, file.path)), { recursive: true }); await copyFile(join(PACK_DIR, file.path), join(staged, file.path)); }
    await writeFile(join(staged, 'pack.json'), `${JSON.stringify({ ...await readManifest(), files: await packFiles() }, null, 2)}\n`);
    if (options.edit !== undefined) {
      await options.edit(staged);
      await signManifest(staged);
    }
    const productDir = (await writePack(join(temp.path, 'synthetic-product'), { id: PRODUCT, version: '1.0.0', kind: 'product', title: '合成模板产品线', description: '只用于包测试的合成产品线和命令目录', files: { 'product.json': { schema: 'product@1', id: PRODUCT, title: '合成模板产品线', names: ['Synthetic Template', 'MEADOW'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: false }], producers: [] } } })).dir;
    const product = await registry.publish(owner, productDir);
    if (!product.ok) throw new Error(JSON.stringify(product.problems));
    await registry.activate(admin, PRODUCT);
    const publication = await registry.publish(owner, staged);
    if (publication.ok) await registry.assign(admin, runner.id, PACK_ID);
    const agile = new FakeAgile(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: SYNTHETIC_KNOWLEDGE,
      external: agile,
      now,
      adminLog: (entry) => logs.push(entry),
    });
    return {
      kit,
      registry,
      service,
      agile,
      logs,
      admin,
      owner,
      runner,
      stranger,
      publication,
      async upload(user, bytes, name = 'mindmap.km.json') {
        const artifact = await kit.artifacts.ingest({
          bytes,
          mediaType: 'application/json',
          origin: { upload: { session: 'sess-upload', message: null } },
          author: { user: user.id },
          provenanceType: 'declared',
          visibility: { readers: [user.id], admins: true, packs: [], shareable: true },
          name,
        });
        return `src:${artifact.body.sha256}`;
      },
      call(session: string | null = 'sess-template-gap') {
        return { traceId: traceId(), sessionId: session };
      },
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
