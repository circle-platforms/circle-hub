// A test bed for the template-gap pack on the real Hub packages (not part of the pack): a records kit in a temporary
// PostgreSQL database, an admin, the pack owner (with a publish right), a user the pack is assigned to and one it is not, the
// real pack registry publishing a staged copy of the pack, and the real run engine on the registry's ports. The pack binds no
// product, so the knowledge port is a stub that knows nothing; the agile platform is a fake reader that stores what it reads
// the way a connector does (the answer as received, the inner document as content, title and folders as meta). Synthetic only.
import { join } from 'node:path';
import type { PermissionRole } from '../../../../contracts/generated/vocabulary.ts';
import type { Artifacts, Principal, SourceArtifact } from '../../../../hub/records/api.ts';
import type { CallContext, ExternalRead, ExternalReadContext, ExternalReaderPort, KnowledgePort } from '../../../../hub/ports.ts';
import {
  createPackRegistry,
  createPacksPort,
  createRunsService,
  createWorkflowStore,
  temporaryDirectory,
  type AdminLogEntry,
  type PackRegistry,
  type PublishOutcome,
  type RunsEngine,
} from '../../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { PACK_ID, signManifest, stagePack } from '../api.ts';

// A named object rather than a literal typed as the port, so that it also compiles while the port gains methods.
const knowsNothing = {
  builds: async () => [],
  resolveBuild: async () => null,
  currentRoot: async () => null,
  rootOfBuild: async () => null,
  rootInfo: async () => [],
  catalog: async () => null,
  treeReader: () => ({ read: () => null, readEntry: () => null }),
  getNodes: async () => null,
  diffRoots: async () => null,
  diffEntries: async () => null,
};
/** The knowledge base is never consulted by a pack without a product binding. */
export const NO_KNOWLEDGE: KnowledgePort = knowsNothing;

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
    return id.startsWith('agile:mindmap:');
  }

  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
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
    const staged = await stagePack(join(temp.path, 'staged'));
    if (options.edit !== undefined) {
      await options.edit(staged);
      await signManifest(staged);
    }
    const publication = await registry.publish(owner, staged);
    if (publication.ok) await registry.assign(admin, runner.id, PACK_ID);
    const agile = new FakeAgile(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: NO_KNOWLEDGE,
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
