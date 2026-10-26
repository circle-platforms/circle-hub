import type { PermissionRole } from '../../../contracts/generated/vocabulary.ts';
// Test harness against the real Hub parts (not part of the pack): a records kit in a temporary PostgreSQL, the real pack
// registry and run engine, and a fake external reader that serves synthetic impact views. The pack binds no product line.
import { join } from 'node:path';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, KnowledgePort, NodesPage, RootDiff, RootInfo } from '../../../hub/ports.ts';
import type { Artifacts, Principal } from '../../../hub/records/api.ts';
import type { TreeReader } from '../../../hub/refs/api.ts';
import type { CatalogView } from '../../../hub/rules/api.ts';
import { createPackRegistry, createPacksPort, createRunsService, createWorkflowStore, temporaryDirectory, type AdminLogEntry, type PackRegistry, type RunsEngine } from '../../../hub/runs/api.ts';
import { routeKnowledgeViews } from '../../../hub/knowledge/api.ts';
import type { TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { stage } from './pack-files.ts';

/** A knowledge base with nothing in it. This pack does not lock a root. */
export class EmptyKnowledge implements KnowledgePort {
  async builds(): Promise<KnownBuild[]> {
    return [];
  }
  async resolveBuild(): Promise<KnownBuild | null> {
    return null;
  }
  async currentRoot(): Promise<RootInfo | null> {
    return null;
  }
  async rootOfBuild(): Promise<RootInfo | null> {
    return null;
  }
  async rootInfo(): Promise<RootInfo[]> {
    return [];
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

/** External systems serving knowledge:impact objects, stored through the records' artifacts. */
export class FakeExternal implements ExternalReaderPort {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly #artifacts: Artifacts;
  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }
  put(id: string, bytes: Uint8Array): void {
    this.objects.set(id, bytes);
  }
  async accepts(id: string): Promise<boolean> {
    return id.startsWith('knowledge:impact:') || id.startsWith('knowledge:facets:');
  }
  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    const bytes = this.objects.get(id);
    if (bytes === undefined) return { ok: false, id, reason: `synthetic system answered “not found” for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const artifact = await this.#artifacts.ingest({
      bytes,
      mediaType: 'application/json',
      origin: { read: { object: `${id}@1` } },
      author: { user: null },
      provenanceType: 'observed',
      visibility,
      name: 'original',
    });
    return { ok: true, id, revision: '1', artifacts: [{ name: 'original', artifact }], manifest: 'synthetic' };
  }
}

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
  close(): Promise<void>;
}

let traces = 1;
export const call = (session = 'sess-regression') => ({ traceId: `4bf92f3577b34da6a3ce929d0e1e${(traces++).toString(16).padStart(4, '0')}`, sessionId: session });

/** Opens the Hub parts, publishes the staged regression-scope pack, activates and assigns it. */
export interface OpenHubOptions {
  /** A knowledge reader routed beside the fake external (the real one, from the world). */
  knowledge?: ExternalReaderPort | null;
  /** An existing records kit (the world's), with the users that go with it: reused, none re-created. */
  kit?: { kit: Awaited<ReturnType<typeof openTestRecords>>; admin: { id: string; name: string; role: 'admin' }; alice: { id: string; name: string; role: 'user' }; bob: { id: string; name: string; role: 'user' } } | null;
}

export async function openHub(postgres: TemporaryPostgres, options: OpenHubOptions = {}): Promise<Hub> {
  const knowledge = options.knowledge ?? null;
  const kitOf = options.kit ?? null;
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = (kitOf?.kit) ?? (await openTestRecords({ postgres, now }));
  const temp = await temporaryDirectory('regression-scope-hub-');
  const root = temp.path;
  try {
    // With an injected kit the users already exist (the world's); otherwise bootstrap the usual three.
    let admin: Principal;
    let alice: { id: string; name: string; role: 'user' };
    let bob: { id: string; name: string; role: 'user' };
    if (kitOf !== null) {
      admin = kitOf.admin;
      alice = kitOf.alice;
      bob = kitOf.bob;
    } else {
      const boot = (await kit.principals.bootstrapAdmin('管理员')).user;
      admin = boot;
      alice = (await kit.principals.createUser(admin, '甲')) as { id: string; name: string; role: 'user' };
      bob = (await kit.principals.createUser(admin, '乙')) as { id: string; name: string; role: 'user' };
      await kit.authorizations.grantPublishRight(admin, alice.id);
    }
    const registry = createPackRegistry({ records: kit, extractDir: join(root, 'extracted'), now });
    if (kitOf !== null) await kit.authorizations.grantPublishRight(admin, admin.id);
    const publisher = kitOf !== null ? admin : alice;
    const published = await registry.publish(publisher, await stage(join(root, 'regression-scope')));
    if (!published.ok) throw new Error(`regression-scope was not published: ${JSON.stringify(published.problems, null, 1)}`);
    await registry.assign(admin, alice.id, 'regression-scope');
    const external = new FakeExternal(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: new EmptyKnowledge(),
      external: knowledge === null ? external : routeKnowledgeViews(knowledge, external),
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
      async close() {
        if (kitOf === null) await kit.close();
        await temp.remove();
      },
    };
  } catch (error) {
    await kit.close();
    await temp.remove();
    throw error;
  }
}
