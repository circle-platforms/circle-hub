import type { ContributionLayer } from '../../knowledge/api.ts';
// What the engine is built from: the records kit parts it writes and reads, the ports of the packages built beside it, the
// parser registry, the sandbox options and the clock. createEngineContext adds the shared caches.
import type { Principals, RecordsKit } from '../../records/api.ts';
import type { ExternalReaderPort, KnowledgePort, PacksPort, WorkflowStore } from '../../ports.ts';
import type { LeaseService } from '../../leases/service.ts';
import { createDefaultRegistry, createDocumentCache, type DocumentCache, type ParserRegistry } from '../../refs/api.ts';
import type { SandboxLimits, SandboxOptions } from '../../rules/api.ts';
import { createKeyedLock, wellFormed } from './util.ts';

/** One line for the admin log: the real reason behind a neutral answer, or a pack function failure. Never shown to callers. */
export interface AdminLogEntry {
  traceId: string | null;
  run: string | null;
  /** What the engine was doing, for example start_run, submit_result, check consistency. */
  what: string;
  detail: string;
}

export interface RunsEngineDeps {
  effectRegistry?:import('../../ports.ts').EffectRegistryPort;
  dispatch?: { jobs(by: import('../../records/api.ts').Principal,run:string):Promise<import('../../dispatch/api.ts').RunJob[]>; reconcile(by:import('../../records/api.ts').Principal,job:string):Promise<import('../../dispatch/api.ts').JobStatus> };
  /** The records kit parts the engine uses; with `config`, start_run knows the record size limit before it stores anything. */
  records: Pick<RecordsKit, 'store' | 'objects' | 'artifacts'> & {
    variables: Pick<RecordsKit['variables'], 'snapshot'>;
    config?: Pick<RecordsKit['config'], 'limits'>;
    principals?: Pick<Principals, 'get'> & Partial<Pick<Principals, 'list'>>;
  };
  workflows: WorkflowStore;
  packs: PacksPort;
  knowledge: KnowledgePort & { layers?: { contributions: ContributionLayer } };
  external: ExternalReaderPort;
  /** Core parsers; default the six of hub/refs. */
  parsers?: ParserRegistry;
  /** Passed to every pack function call (requireOsIsolation: false only in synthetic test environments without sandbox-exec). */
  sandbox?: SandboxOptions;
  /** Limits of pack function calls (projection, expected sources, build choice, subject builders, check functions). */
  sandboxLimits?: Partial<SandboxLimits>;
  now?: () => Date;
  /** Window in which repeating start_run with the same client key returns the same run; default 24 hours (D05 R[5]). */
  clientKeyWindowMs?: number;
  /** Receives the real reasons behind neutral answers and pack function failures (the server writes them as admin notes). */
  adminLog?: (entry: AdminLogEntry) => void;
  /** The lease service (D04 R[0]); without it a workflow that declares leases cannot start. */
  leases?: LeaseService;
  /** Trusted, read-only unfinished jobs by resource key; no fencing data leaves this port. */
  leaseJobs?: (keys: readonly string[]) => Promise<Array<{ key: string; job: string }>>;
}

export const ENGINE_COMPONENT = 'runs.engine@1';
export const DEFAULT_CLIENT_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pack function calls in flight per evaluation (the sandbox itself runs at most 8 children at a time). */
export const CHECK_PARALLELISM = 8;

export interface EngineContext {
  deps: RunsEngineDeps;
  parsers: ParserRegistry;
  documents: DocumentCache;
  now: () => Date;
  clientKeyWindowMs: number;
  /** Largest record body the store takes (canonical JSON bytes), when the kit's configuration was given. */
  maxRecordBytes: number | null;
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  log: (entry: AdminLogEntry) => void;
}

export function createEngineContext(deps: RunsEngineDeps): EngineContext {
  const window = deps.clientKeyWindowMs ?? DEFAULT_CLIENT_KEY_WINDOW_MS;
  if (!Number.isSafeInteger(window) || window <= 0) throw new RangeError('clientKeyWindowMs must be a positive integer');
  return {
    deps,
    parsers: deps.parsers ?? createDefaultRegistry(),
    documents: createDocumentCache(32),
    now: deps.now ?? (() => new Date()),
    clientKeyWindowMs: window,
    maxRecordBytes: deps.records.config?.limits.maxRecordBytes ?? null,
    lock: createKeyedLock(),
    log: (entry) => {
      try {
        // Details quote input and pack output: keep them well-formed so that whoever stores the note can.
        deps.adminLog?.({ ...entry, what: wellFormed(entry.what), detail: wellFormed(entry.detail) });
      } catch {
        // The admin log must never change an answer.
      }
    },
  };
}
