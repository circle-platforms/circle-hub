// Public surface of the server package (D05 D06 B08 R01 R02): the MCP server, the console, the HTTP surface and the CLI.
// The assembly step (next phase) imports only this file: it builds ServerDeps from the real packages and registers the
// CLI commands that need them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubConfig } from '../config/index.ts';
import type { PacksPort, KnowledgePort, PackCatalogPort, ResourceCatalogPort, RunsService, WorkflowStore } from '../ports.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import type { ParserRegistry } from '../refs/api.ts';

export { createApp } from './app.ts';
export { main, registerCommand, registeredCommands, RESERVED_COMMANDS } from './cli.ts';
export { serve } from './main.ts';
export { AssemblyMissingError, isAssemblyMissing } from './errors.ts';
export { readReleaseId } from './release.ts';
export type { ServerCallContext } from './tools.ts';

/** Everything the server needs; the assembly builds it from the real packages, tests from fakes (hub/server/testing.ts). */
export interface ServerDeps {
  config: HubConfig;
  records: RecordsKit;
  runs: RunsService;
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

/** Builds the server's dependencies from the opened configuration and records (written by the assembly step). */
export type AssembleFunction = (config: HubConfig, records: RecordsKit) => Promise<ServerDeps> | ServerDeps;

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
  /** The full dependencies, built by the assembly; throws AssemblyMissingError until the assembly exists. */
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
  assemble: AssembleFunction;
  /** Registers the commands that need the other packages (pack, resource, secret, knowledge, ...). */
  registerCommands?: (register: RegisterCommand) => void;
}
