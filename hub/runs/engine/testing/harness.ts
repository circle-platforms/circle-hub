import {createTestParserRegistry} from '../../../testing/parsers.ts';
import type { PermissionRole } from '../../../../contracts/generated/vocabulary.ts';
// Test harness of the runs engine: a records kit in a temporary PostgreSQL database, three accounts, the toy packs in a
// temporary directory, fakes of the ports built beside the engine, a clock the tests can move, and the service.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Limits, Principal } from '../../../records/api.ts';
import type { CallContext, LoadedWorkflow } from '../../../ports.ts';
import { osIsolationAvailable, type SandboxLimits, type SandboxOptions } from '../../../rules/api.ts';
import type { TemporaryPostgres } from '../../../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../testing/records.ts';
import { createRunsService, type AdminLogEntry, type RunsEngine } from '../api.ts';
import { LeaseService } from '../../../leases/service.ts';
import { createPool, Database } from '../../../records/db.ts';
import { FakeExternal } from './external.ts';
import { FakeKnowledge, FakePacks } from './knowledge.ts';
import { locatePack, reviewPack, verifyPack, writePack, type ReviewOptions } from './packs.ts';
import { standardDocument, toyMap } from './mindmap.ts';
import { FakeWorkflowStore } from './workflows.ts';

export interface HarnessOptions {
  parsers?:import('../../../refs/api.ts').ParserRegistry;
  review?: ReviewOptions;
  /** Passed through to reviewPack (dataQuotes adds the slot-data quote check). */
  dataQuotes?: boolean;
  verifyAcceptsDeclared?: boolean;
  sandboxLimits?: Partial<SandboxLimits>;
  sandbox?: SandboxOptions;
  clientKeyWindowMs?: number;
  /** Limits of the records kit (a small maxRecordBytes shows what does not fit in one record). */
  limits?: Partial<Limits>;
  /** Wire the lease service into the engine (a workflow that declares leases needs it). */
  leases?: boolean;
  leaseJobs?: (keys: readonly string[]) => Promise<Array<{key:string;job:string}>>;
}

export interface Harness {
  kit: TestRecordsKit;
  service: RunsEngine;
  workflows: FakeWorkflowStore;
  knowledge: FakeKnowledge;
  packs: FakePacks;
  external: FakeExternal;
  /** The lease service the engine uses (null when the harness was opened without leases). */
  leases: LeaseService | null;
  review: LoadedWorkflow;
  verify: LoadedWorkflow;
  locate: LoadedWorkflow;
  admin: Principal;
  alice: Principal;
  bob: Principal;
  logs: AdminLogEntry[];
  /** Moves the clock the engine and the records use. */
  advance(ms: number): void;
  /** Stores bytes as an upload of this user and returns src:<sha256>. */
  upload(user: Principal, bytes: Uint8Array, mediaType?: string, session?: string): Promise<string>;
  call(session?: string | null): CallContext;
  close(): Promise<void>;
}

/** The sandbox needs macOS sandbox-exec by default; tests that run pack functions skip where it is missing (Linux CI). */
export async function sandboxSkip(): Promise<string | false> {
  return (await osIsolationAvailable()) ? false : 'operating-system isolation for pack functions (sandbox-exec) is not available here';
}

const principal = (u: { id: string; name: string; role: PermissionRole }): Principal => ({ id: u.id, name: u.name, role: u.role });

let traceCounter = 1;
export function traceId(): string {
  const n = (traceCounter++).toString(16);
  return `${'4bf92f3577b34da6a3ce929d0e0e'.slice(0, 32 - Math.max(4, n.length))}${n.padStart(4, '0')}`;
}

export async function openHarness(postgres: TemporaryPostgres, options: HarnessOptions = {}): Promise<Harness> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now, ...(options.limits !== undefined ? { limits: options.limits } : {}) });
  const dir = await mkdtemp(join(tmpdir(), 'circle-hub-runs-'));
  try {
    const { user: adminUser } = await kit.principals.bootstrapAdmin('管理员');
    const admin = principal(adminUser);
    const alice = principal(await kit.principals.createUser(admin, '甲'));
    const bob = principal(await kit.principals.createUser(admin, '乙'));
    const workflows = new FakeWorkflowStore(admin.id);
    const review = await workflows.add(await writePack(dir, reviewPack({ ...(options.review ?? {}), ...(options.dataQuotes !== undefined ? { dataQuotes: options.dataQuotes } : {}) })));
    const verify = await workflows.add(await writePack(dir, verifyPack({ acceptsDeclared: options.verifyAcceptsDeclared })));
    const locate = await workflows.add(await writePack(dir, locatePack()));
    for (const pack of ['toy-review', 'toy-verify', 'toy-locate']) workflows.assign(alice.id, pack);
    const packs = new FakePacks();
    await packs.install(dir);
    const knowledge = new FakeKnowledge();
    const external = new FakeExternal(kit.artifacts);
    external.put('toy:mindmap:docq7', { bytes: toyMap(standardDocument()), mediaType: 'application/json', meta: { title: '分区浇灌用例', document: 'docq7' } });
    external.put('toy:story:4021', { bytes: new TextEncoder().encode('# 需求 4021\n\n分区编号 1 到 8，每次浇灌 1 到 120 分钟。\n'), mediaType: 'text/markdown', meta: { title: '需求 4021 分区浇灌' } });
    external.put('toy:manual:zone', {
      bytes: new TextEncoder().encode('# 分区命令\n\n## zone set\n\nzone set <zone> <minutes>：zone 取 1 到 8，minutes 取 1 到 120。\n'),
      mediaType: 'text/markdown',
      meta: { title: '分区命令手册' },
    });
    external.put('toy:history:zone-list', { bytes: new TextEncoder().encode('历史用例：设置 1 区浇灌 10 分钟。\n'), mediaType: 'text/plain' });
    const logs: AdminLogEntry[] = [];
    const leases = options.leases === true ? new LeaseService(new Database(createPool(kit.database, 2)), { now: async () => now() }) : null;
    const service = createRunsService({
      sandbox: options.sandbox ?? { requireOsIsolation: await osIsolationAvailable() },
      records: kit,
      parsers: options.parsers??createTestParserRegistry(),
      workflows,
      packs,
      knowledge,
      external,
      now,
      ...(leases !== null ? { leases, leaseJobs: options.leaseJobs ?? (async () => []) } : {}),
      ...(options.sandboxLimits !== undefined ? { sandboxLimits: options.sandboxLimits } : {}),
      ...(options.clientKeyWindowMs !== undefined ? { clientKeyWindowMs: options.clientKeyWindowMs } : {}),
      adminLog: (entry) => logs.push(entry),
    });
    return {
      kit,
      service,
      workflows,
      knowledge,
      packs,
      external,
      leases,
      review,
      verify,
      locate,
      admin,
      alice,
      bob,
      logs,
      advance(ms) {
        clock += ms;
      },
      async upload(user, bytes, mediaType = 'application/json', session = 'sess-upload') {
        const artifact = await kit.artifacts.ingest({
          bytes,
          mediaType,
          origin: { upload: { session, message: null } },
          author: { user: user.id },
          provenanceType: 'declared',
          visibility: { readers: [user.id], admins: true, packs: [], shareable: true },
          name: 'upload.json',
        });
        return `src:${artifact.body.sha256}`;
      },
      call(session: string | null = 'sess-a') {
        return { traceId: traceId(), sessionId: session };
      },
      async close() {
        await kit.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await kit.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

