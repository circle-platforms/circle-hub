import { readRunJobs } from '../../dispatch/api.ts';
import { productVariableNameAvailable } from '../variables.ts';
// assembleHub: the Hub built from the real packages over an opened configuration and records kit. Order: the vault master
// key (when required: a missing or wrong key stops here, before anything listens), the core parsers, the pack registry and
// its three ports, the connectors (resources, logins, read plugins) with the ExternalReaderPort and the resource catalog,
// the knowledge service (reading through the connectors alone), the named documents (C4), the run engine (reading the
// knowledge views and the named documents and, for every other id, the connectors), and the ServerDeps the server takes.
// The Hub calls no model (owner decision 2026-10-22): knowledge is assembled without a placer, and a judgment-service key
// left in the vault is never read.
// Nothing here reads the environment, a file outside the data directory, or a credential value.
import { join } from 'node:path';
import { DispatchService, freezeEffectRegistry } from '../../dispatch/api.ts';
import type { HubConfig } from '../../config/index.ts';
import {
  createConnectors,
  createExternalReader,
  createResourceCatalog,
  type Connectors,
  type FetchLike,
} from '../../connectors/api.ts';
import { createKnowledge, createKnowledgeReader, routeKnowledgeViews, type Knowledge } from '../../knowledge/api.ts';
import type { ExternalReaderPort, PackCatalogPort, PacksPort, ResourceCatalogPort, WorkflowStore } from '../../ports.ts';
import type { Principal, RecordsKit } from '../../records/api.ts';
import { LeaseService } from '../../leases/service.ts';
import { createPool, Database } from '../../records/db.ts';
import { createSkillParserRegistry, type ParserRegistry } from '../../refs/api.ts';
import { osIsolationAvailable, type SandboxOptions } from '../../rules/api.ts';
import {
  createPackCatalog,
  createPackRegistry,
  createPacksPort,
  createRunsService,
  recheckEffectChecks,
  createWorkflowStore,
  type PackRegistry,
  type RunsEngine,
  type RunsEngineDeps,
} from '../../runs/api.ts';
import type { AssembleFunction, CommandIo, ServerDeps } from '../api.ts';
import { createDocs, routeDocs, type Docs } from '../docs.ts';
import { CallNotes, withCallNotes } from './notes.ts';
import { terminalSafe } from './terminal.ts';
import { requireVaultKey } from './vault.ts';

export interface AssemblyOptions {
  /**
   * Pack functions run under macOS sandbox-exec, which denies the network (default true). Only synthetic test environments
   * where it is missing may pass false (hub/rules).
   */
  requireOsIsolation?: boolean;
  /** Read the vault master key before anything else and stop when it is missing (default true). */
  requireVaultKey?: boolean;
  /**
   * The assembly serves one CLI command, not `serve`: a missing key refuses the command ("没有执行") instead of saying the
   * Hub does not start (default false).
   */
  command?: boolean;
  /** Probe sandbox-exec at start-up and say when pack functions cannot run here (default false; serve does it). */
  checkSandbox?: boolean;
  /** Transport of the connectors; default the global fetch. Tests reach only loopback stubs. */
  fetch?: FetchLike;
  /** Clock of every package and of the server's call log and console sessions. */
  now?: () => Date;
  /** The operator's log (one line each); default stderr. */
  log?: (line: string) => void;
  /** Where published packs are extracted read-only; default <data dir>/packs (derived data, rebuilt from the objects). */
  extractDir?: string;
  /** How long the connectors reuse the resource list, in ms (default theirs, 5 s; tests 0). */
  resourceCacheMs?: number;
  /** The admin a standing knowledge sync acts as when a call names none (default none: every sync names its admin). */
  knowledgeAdmin?: Principal | null;
  /** Window of start_run's client keys (default the engine's, 24 hours). */
  clientKeyWindowMs?: number;
  /** The lease service for workflows that declare leases (D04 R[0]). Default: one built over the same database as the
   * records kit (its clock follows this assembly's `now`); null for a read-only assembly that wants no pool of its own. */
  leases?: LeaseService | null;
}

/** Everything the assembly built: the server's dependencies and the services the administrator commands use. */
export interface AssembledHub {
  deps: ServerDeps;
  config: HubConfig;
  records: RecordsKit;
  parsers: ParserRegistry;
  registry: PackRegistry;
  packs: PacksPort;
  workflows: WorkflowStore;
  catalog: PackCatalogPort;
  connectors: Connectors;
  /** The connectors' reader: the knowledge service's own external (the views are not a source of the tree). */
  external: ExternalReaderPort;
  /** The run engine's reader: `knowledge:` ids through the knowledge views, every other id through the connectors. */
  runsExternal: ExternalReaderPort;
  resources: ResourceCatalogPort;
  /** The named documents (C4): doc put/list/show and the `doc:doc:` reader for runs of packs that declare it. */
  docs: Docs;
  knowledge: Knowledge;
  /** The run engine; the connectors' and the registry's failures while it serves a call reach that call's note. */
  runs: RunsEngine;
  /** The lease service the engine uses (built over the same database unless the caller brought one). */
  leases: LeaseService;
  dispatch: DispatchService | null;
  notes: CallNotes;
  /** What the operator should know about this assembly, in Chinese (no sandbox-exec, ...). */
  notices: string[];
}

const stderrLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export async function assembleHub(config: HubConfig, records: RecordsKit, options: AssemblyOptions = {}): Promise<AssembledHub> {
  const notes = new CallNotes(options.log ?? stderrLog);
  const notices: string[] = [];
  // 1. The vault master key: read (never created) and checked against the vault before anything else.
  if (options.requireVaultKey !== false) await requireVaultKey(records, { command: options.command === true });

  const now = options.now;
  const sandbox: SandboxOptions = { requireOsIsolation: options.requireOsIsolation ?? true };
  if (options.checkSandbox === true && sandbox.requireOsIsolation === true && !(await osIsolationAvailable())) {
    notices.push('这台机器上没有可用的 sandbox-exec：任务包函数（投影、检查、同步和读取插件）都不会运行，相关的调用会失败');
  }

  // 2. Package lifecycle and the installed, sandboxed format capabilities.
  const registry = createPackRegistry({
    variableNameAvailable: (name,tx)=>productVariableNameAvailable(records,name,tx),
    records,
    extractDir: options.extractDir ?? join(config.dataDir, 'packs'),
    ...(now === undefined ? {} : { now }),
    sandbox,
    onError: notes.registryError,
    onTamper: notes.tamper,
  });
  const parsers = createSkillParserRegistry({ registry, records, sandbox, now });
  await parsers.refresh?.();
  const packs = createPacksPort(registry);
  const workflows = createWorkflowStore(registry);
  const catalog = createPackCatalog(registry);

  // 4. Connectors: resources, logins and read plugins over the published system packs.
  const connectors = createConnectors({
    records,
    packs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(now === undefined ? {} : { now }),
    log: notes.connector,
    sandbox: { requireOsIsolation: sandbox.requireOsIsolation },
    parsers,
    ...(options.resourceCacheMs === undefined ? {} : { resourceCacheMs: options.resourceCacheMs }),
  });
  if(options.requireVaultKey !== false)await connectors.primeSecrets();
  const external = createExternalReader(connectors);
  const resources = createResourceCatalog(connectors);

  // 5. Knowledge: it reads its sources through the connectors alone. No placer: the Hub calls no model, so spans the
  // code cannot place stay unplaced at the root (a producer may declare them for the bot's placement proposals).
  const knowledge = createKnowledge({
    records,
    parsers,
    packs,
    external,
    sandbox: { requireOsIsolation: sandbox.requireOsIsolation },
    ...(now === undefined ? {} : { clock: now }),
    admin: options.knowledgeAdmin ?? null,
  });

  // 6. The named documents (C4): doc put/list/show and the reader of the `doc:doc:` external ids.
  const docs = createDocs({ records, workflows, ...(now === undefined ? {} : { now }) });

  // 7. The run engine: inputs and expected sources of the knowledge views (`knowledge:impact|facets|index:...`) are read
  // from the knowledge service, the named documents (`doc:doc:...`) from the documents service, every other id through
  // the connectors. It writes each call's reasons to the call's admin note itself (CallContext.adminNote); the connectors
  // and the registry report through the call notes.
  const runsExternal = routeDocs(docs.reader, routeKnowledgeViews(createKnowledgeReader(knowledge), external));
  // The lease service: the caller's own (tests may inject a clock), or one built over the same database — so `serve`
  // and the test hub alike give lease-declaring workflows a service (C3); a CLI command's assembly may pass null to
  // keep a read-only command from opening a pool it does not need.
  const leaseDatabase = options.leases === undefined ? new Database(createPool(config.database, 2)) : null;
  const leases = options.leases === null ? undefined : options.leases ?? new LeaseService(leaseDatabase!, { records: records.store, ...(now === undefined ? {} : { now: async () => now() }) });
  let dispatch: DispatchService | null = null;
  const engineDeps:RunsEngineDeps = {
    effectRegistry:{snapshot:variables=>freezeEffectRegistry(records,variables)},
    dispatch:{jobs:(by,run)=>dispatch?readRunJobs(records,dispatch,by,run):Promise.resolve([]),reconcile:(by,job)=>{if(!dispatch)throw new Error('派发服务没有接线');return dispatch.resume(by,job);}},
    records,
    workflows,
    packs,
    knowledge,
    external: runsExternal,
    parsers,
    sandbox,
    ...(now === undefined ? {} : { now }),
    ...(options.clientKeyWindowMs === undefined ? {} : { clientKeyWindowMs: options.clientKeyWindowMs }),
    ...(leases !== undefined ? { leases, leaseJobs: async (keys: readonly string[]) => {
      if (!dispatch) throw new Error('作业读取端口未就绪，请管理员检查装配');
      return dispatch.activeLeaseJobs(keys);
    } } : {}),
    adminLog: notes.engine,
  };
  const engine=createRunsService(engineDeps);
  const runs = withCallNotes(engine, notes);
  dispatch = leases ? new DispatchService({ records, leases, runs, workflows,adminLog:notes.engine,recheckChecks:input=>recheckEffectChecks(engineDeps,input),redactor:connectors.redactor, ...(leaseDatabase ? { close: () => leaseDatabase.end() } : {}), ...(now ? { now } : {}) }) : null;

  const deps: ServerDeps = {
    config,
    records,
    runs,
    runsDetail: runs,
    ...(options.command?{}:{maintenance:engine}),
    knowledge,
    workflows,
    packs: catalog,
    resources,
    parsers,
    ...(now === undefined ? {} : { now }),
    products: packs,
  };
  return { deps, config, records, parsers, registry, packs, workflows, catalog, connectors, external, runsExternal, resources, docs, knowledge, runs, leases: leases as LeaseService, dispatch, notes, notices };
}

/**
 * The AssembleFunction `serve` uses: the vault key required, sandbox-exec probed, and every notice written to the operator's
 * log once at start-up. For `serve` only: a CLI command's dependencies come from createCommandAssembly.
 */
export function createAssembly(options: AssemblyOptions = {}): AssembleFunction {
  return async (config, records) => {
    const hub = await assembleHub(config, records, { requireVaultKey: true, checkSandbox: true, ...options });
    for (const notice of hub.notices) hub.notes.log(`注意：${notice}`);
    return hub.deps;
  };
}

export type { CommandAssembleFunction, CommandIo } from '../api.ts';

/**
 * The assembly of one CLI command (AssemblyModule.assembleCommand, the server core's `ctx.deps()` for `run show`): no vault
 * master key needed (a run is read without one; a locked keychain or a missing key does not refuse a read-only command), no
 * sandbox-exec probe, no start-up notices, and the operator's log lines (a connector or registry event) go to the CLI's
 * standard error, made safe for a terminal.
 */
export function createCommandAssembly(options: AssemblyOptions = {}): (config: HubConfig, records: RecordsKit, io: CommandIo) => Promise<ServerDeps> {
  return async (config, records, io) => {
    const hub = await assembleHub(config, records, {
      log: (line) => io.stderr(terminalSafe(line)),
      ...options,
      requireVaultKey: false,
      checkSandbox: false,
      command: true,
    });
    return hub.deps;
  };
}
