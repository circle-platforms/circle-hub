// What every part of the knowledge service shares: the records it writes, the ports it consumes, the clock and the limits.
import type { ExternalReaderPort, PacksPort } from '../ports.ts';
import type { Artifacts, ObjectStore, Pointers, Principal, Principals, RecordStore, RecordVariables, User } from '../records/api.ts';
import type { ParserRegistry } from '../refs/api.ts';
import type { SandboxLimits } from '../rules/api.ts';
import type { CalibrationStore } from './calibration.ts';
import { KnowledgeError } from './errors.ts';
import type { Placer } from './placement.ts';
import type { KnowledgeStore } from './store.ts';

/** The parts of the records kit the knowledge package uses. */
export interface KnowledgeRecords {
  variables?: Pick<RecordVariables,'snapshot'|'valueAt'|'history'>;
  store: RecordStore;
  artifacts: Artifacts;
  pointers: Pointers;
  principals: Pick<Principals, 'get'> & Partial<Pick<Principals, 'list'|'tokens'>>;
  /** Content-addressed bytes: the stored outputs of producer calls (memoized batches) and the bytes of computed views. */
  objects: Pick<ObjectStore, 'put' | 'get'>;
}

export interface KnowledgeLimits {
  /** Bytes of all single sources of one build, and of the documents of one batch of a list slot (default 64 MiB). */
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
  /** External objects of the list slots of one production read at the same time (default 4). */
  listReadConcurrency: number;
  /** A list source the knowledge package stored at most this many seconds ago is used again without a new read (default 86400; 0 reads every one again). */
  listMaxAgeSeconds: number;
  /** Batches of one list producer processed at the same time (default 2). */
  batchConcurrency: number;
  /** Most entries one node holds; further entries for it are refused (default 20000). */
  maxNodeEntries: number;
  /** Rows (composition rows, unplaced rows, list sources) up to which a composition stays in one record (default 1000). */
  inlineRows: number;
  /** Records per transaction while a root is written (default 500) and such transactions at the same time (default 4). */
  writeChunk: number;
  writeConcurrency: number;
  /** Largest view answer in bytes of canonical JSON (default 15 MiB: the core JSON parser reads at most 16 MiB). */
  maxViewBytes: number;
  /**
   * Calls a list may make to isolate the documents its producer fails on: this many per batch, plus as many as for four
   * batches (default 16: about one failing document in every batch of 50). Over it the production fails.
   */
  isolationCallsPerBatch: number;
  /** Producer calls of one production that may run past the sandbox's time limit (default 16); the next one fails the production. */
  maxTimedOutCalls: number;
  /** A list whose skipped documents are more than this share of the listed ones fails the production (default 0.5). */
  maxSkippedShare: number;
  /** Distinct value combinations one facet view collects (default 100000); later new combinations are left out and flagged. */
  facetCombinations: number;
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = {
  maxBuildBytes: 64 * 1024 * 1024,
  concurrency: 2,
  pageNodes: 100,
  pageBytes: 2 * 1024 * 1024,
  maxStatementBytes: 1024 * 1024,
  maxDataBytes: 4 * 1024 * 1024,
  listReadConcurrency: 4,
  listMaxAgeSeconds: 86_400,
  batchConcurrency: 2,
  maxNodeEntries: 20_000,
  inlineRows: 1000,
  writeChunk: 500,
  writeConcurrency: 4,
  maxViewBytes: 15 * 1024 * 1024,
  isolationCallsPerBatch: 16,
  maxTimedOutCalls: 16,
  maxSkippedShare: 0.5,
  facetCombinations: 100_000,
};

/**
 * Sandbox limits of the plan and producer functions (raised over the rules defaults: a parsed command tree is large). The
 * plan's output may take the sandbox's largest output (64 MiB): every build it lists carries its list roles, about 1 million
 * listed ids of 60 bytes in one sync.
 */
export const DEFAULT_SANDBOX: { plan: Partial<SandboxLimits>; producer: Partial<SandboxLimits> } = {
  plan: { timeoutMs: 60_000, memoryMb: 1024, inputBytes: 128 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 },
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
  knownBuildInventory?:ReadonlyArray<{name:string;record:string}>;
  /** Reads the feeding layer beside seedlings (kb-feeding); absent when no feeding records exist yet (nothing fed). */
  feedingReader?:import('./feeding-types.ts').FeedingReader;
  /** Whether the generic additional-root scope was explicitly declared, beyond automatic unversioned discovery. */
  additionalScopeRootsDeclared?: boolean;
  additionalScopeRoots?: (product:string)=>Promise<readonly {root:string;composition:string}[]>;
  credentialAcceptance?:import('./credential-policy.ts').CredentialAcceptanceOptions;
  feeding?:import('./feeding.ts').FeedingLayer;
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
