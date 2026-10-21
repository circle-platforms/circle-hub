// What every part of the knowledge service shares: the records it writes, the ports it consumes, the clock and the limits.
import type { ExternalReaderPort, PacksPort } from '../ports.ts';
import type { Artifacts, Pointers, Principal, Principals, RecordStore, User } from '../records/api.ts';
import type { ParserRegistry } from '../refs/api.ts';
import type { SandboxLimits } from '../rules/api.ts';
import type { CalibrationStore } from './calibration.ts';
import { KnowledgeError } from './errors.ts';
import type { Placer } from './placement.ts';
import type { KnowledgeStore } from './store.ts';

/** The parts of the records kit the knowledge package uses. */
export interface KnowledgeRecords {
  store: RecordStore;
  artifacts: Artifacts;
  pointers: Pointers;
  principals: Pick<Principals, 'get'>;
}

export interface KnowledgeLimits {
  /** Bytes of all sources of one build (default 64 MiB). */
  maxBuildBytes: number;
  /** Builds produced at the same time by one sync (default 2). */
  concurrency: number;
  /** Nodes per get_nodes page (default 100). */
  pageNodes: number;
  /** Statement bytes per get_nodes page before it is cut (default 2 MiB). */
  pageBytes: number;
  /** Largest statement of an entry in bytes (default 1 MiB) and its data as canonical JSON (default 4 MiB). */
  maxStatementBytes: number;
  maxDataBytes: number;
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = {
  maxBuildBytes: 64 * 1024 * 1024,
  concurrency: 2,
  pageNodes: 100,
  pageBytes: 2 * 1024 * 1024,
  maxStatementBytes: 1024 * 1024,
  maxDataBytes: 4 * 1024 * 1024,
};

/** Sandbox limits of the plan and producer functions (raised over the rules defaults: a parsed command tree is large). */
export const DEFAULT_SANDBOX: { plan: Partial<SandboxLimits>; producer: Partial<SandboxLimits> } = {
  plan: { timeoutMs: 60_000, memoryMb: 512, inputBytes: 128 * 1024 * 1024, outputBytes: 16 * 1024 * 1024 },
  producer: { timeoutMs: 120_000, memoryMb: 1024, inputBytes: 128 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 },
};

/**
 * Runs the write phases of productions one after the other in this process: a production checks which nodes and entries
 * exist inside its write, so content-addressed records two parallel productions share are written once.
 */
export class WriteQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface KnowledgeContext {
  records: KnowledgeRecords;
  store: KnowledgeStore;
  parsers: ParserRegistry;
  packs: PacksPort;
  external: ExternalReaderPort;
  placer: Placer;
  calibration: CalibrationStore;
  now: () => Date;
  sandbox: { plan: Partial<SandboxLimits>; producer: Partial<SandboxLimits>; requireOsIsolation: boolean };
  limits: KnowledgeLimits;
  /** Default admin context of standing syncs when a call names none. */
  admin: Principal | null;
  writes: WriteQueue;
}

/** The account behind a principal as stored now; refuses anything but an enabled admin. */
export async function requireAdmin(context: KnowledgeContext, by: Principal | null | undefined, what: string): Promise<User> {
  const principal = by ?? context.admin;
  const account = principal === null || principal === undefined ? null : await context.records.principals.get(principal.id);
  if (account === null || account.disabled || account.role !== 'admin') throw new KnowledgeError(`只有管理员可以${what}`);
  return account;
}
