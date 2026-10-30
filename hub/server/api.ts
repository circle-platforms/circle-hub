// Public surface of the server package (D05 D06 B08 R01 R02): the MCP server, the console, the HTTP surface and the CLI.
// The assembly step (next phase) imports only this file: it builds ServerDeps from the real packages and registers the
// CLI commands that need them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubConfig } from '../config/index.ts';
import type { PacksPort, KnowledgePort, PackCatalogPort, ResourceCatalogPort, RunsService, WorkflowStore } from '../ports.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import type { ParserRegistry } from '../refs/api.ts';
import type { RunsEngine } from '../runs/api.ts';

export { createApp } from './app.ts';
export { main, registerCommand, registeredCommands, RESERVED_COMMANDS } from './cli.ts';
export { serve } from './main.ts';
export { AssemblyMissingError, isAssemblyMissing } from './errors.ts';
export { readReleaseId } from './release.ts';
export type { ServerCallContext } from './tools.ts';
export type { TextContext } from './text.ts';

/** Everything the server needs; the assembly builds it from the real packages, tests from fakes (hub/server/testing.ts). */
export interface ServerDeps {
  config: HubConfig;
  records: RecordsKit;
  runs: RunsService;
  maintenance?: Pick<RunsEngine, 'startMaintenance' | 'stopMaintenance'>;
  /**
   * The run engine's extras the text of the answers uses (filled by the assembly): start_run through startRunDetailed (the
   * run record, the whole production result, the evidence gaps) and the stored result of a submission by its digest.
   * Without it start_run uses `runs.startRun` and the texts name the console instead of record references.
   */
  runsDetail?: Pick<RunsEngine, 'startRunDetailed' | 'getResult'>;
  knowledge: KnowledgePort;
  workflows: WorkflowStore;
  packs: PackCatalogPort;
  resources: ResourceCatalogPort;
  /** Core parsers: the upload structure summary and get_nodes reference reads. */
  parsers: ParserRegistry;
  /** Clock for call-log times and console sessions; default the system clock. */
  now?: () => Date;
  /**
   * Product packs, for the console's knowledge page: every name of a line and the lines a user may read (R01 R[2]).
   * Optional: without it an admin sees the product pack ids of the catalog and a user sees no line.
   */
  products?: Pick<PacksPort, 'products' | 'readableProducts'>;
}

export interface AppOptions {
  /** The server certificate and key of the built-in HTTPS (PEM); required when the configuration has `https`. */
  tls?: { cert: string; key: string };
  /** Directory whose release.json names the running release; default the code root of this server. */
  codeRoot?: string;
  /** Operational problems (a call-log write that failed); default stderr. Never receives arguments or secrets. */
  log?: (line: string) => void;
  /** Longest wait in close() for requests in flight, default 10 s. */
  closeTimeoutMs?: number;
  /**
   * After closeTimeoutMs the connections are closed; close() then waits up to this long more for the handlers still
   * running, so their call-log lines are written before the records close. Default 15 s (both fit launchd's ExitTimeOut).
   */
  closeGraceMs?: number;
  /** Request body bytes held at once over all /mcp requests; over it a request gets 503. Default four times the request cap. */
  maxInflightBodyBytes?: number;
}

export interface ListenInfo {
  host: string;
  port: number;
  /** The built-in HTTPS listener, when the configuration has one. */
  https?: { host: string; port: number; url: string };
  /** http://127.0.0.1:<port> */
  url: string;
}

export interface HubApp {
  /** The request listener (Host and Origin checks included). */
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  /** Listens on the configured loopback address and port (0: a free port). */
  listen(): Promise<ListenInfo>;
  /**
   * Stops accepting, lets requests in flight finish (bounded), then closes every connection and waits (bounded again) for
   * the handlers that are still running. Idempotent.
   */
  close(): Promise<void>;
  /** The release this process serves (release.json in the code root), null without one. */
  readonly release: string | null;
}

/** Builds the server's dependencies from the opened configuration and records, for `serve` (the vault key required). */
export type AssembleFunction = (config: HubConfig, records: RecordsKit) => Promise<ServerDeps> | ServerDeps;

/** Where a command-time assembly writes its operator's log lines: the invoking CLI's standard error. */
export interface CommandIo {
  stderr(line: string): void;
}

/**
 * Builds the server's dependencies for one CLI command (`run show` through CliContext.deps()): no vault master key, no
 * sandbox probe, no start-up notices; its log lines go to the CLI's standard error.
 */
export type CommandAssembleFunction = (config: HubConfig, records: RecordsKit, io: CommandIo) => Promise<ServerDeps> | ServerDeps;

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** What a registered CLI command gets: the IO, the configuration and lazily opened records (runtime role, no migration). */
export interface CliContext {
  io: CliIo;
  config(): HubConfig;
  records(): Promise<RecordsKit>;
  /**
   * The full dependencies, built by the assembly module's `assembleCommand` (never `serve`'s `assemble`); throws
   * AssemblyMissingError when the module has none.
   */
  deps(): Promise<ServerDeps>;
  /** The admin a command acts as: `--as <name or id>`, or the only enabled admin. */
  actingAdmin(as?: string): Promise<Principal>;
}

export interface CliCommand {
  /** The first argument, for example `pack`. */
  name: string;
  /** One line of Chinese usage for the help text. */
  summary: string;
  run(args: readonly string[], context: CliContext): Promise<number>;
}

export type RegisterCommand = (command: CliCommand) => void;

/** The shape of hub/server/assemble.ts. */
export interface AssemblyModule {
  /** `serve`'s assembly only. */
  assemble: AssembleFunction;
  /** The assembly of one CLI command (CliContext.deps()); without it such a command refuses with AssemblyMissingError. */
  assembleCommand?: CommandAssembleFunction;
  /** Registers the commands that need the other packages (pack, resource, secret, knowledge, init-admin, operator-token). */
  registerCommands?: (register: RegisterCommand) => void;
}
