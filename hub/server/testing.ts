// createTestServer(): the server assembled in-process on a temporary PostgreSQL (hub/testing) with the fakes of hub/server/fakes.ts,
// listening on a loopback port; helpers create users, tokens and assignments; client() wraps the official SDK client over
// streamable HTTP with the Bearer token and the Circle-Session-Id header. Nothing here touches the real runs, knowledge or
// connectors packages, the network beyond loopback, or any file outside temporary directories.
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HubConfig, Limits } from '../config/index.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { Principal, RecordsKit, User } from '../records/api.ts';
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import type { HubApp, ServerDeps } from './api.ts';
import { createApp } from './app.ts';
import { FakeKnowledge, FakePackCatalog, FakeProducts, FakeResources, FakeRuns, FakeWorkflows, defaultPacks, type FakePack } from './fakes.ts';

export interface TestServerOptions {
  /** Cluster to create the database in (one per test file); without one the server starts and stops its own. */
  postgres?: TemporaryPostgres;
  now?: () => Date;
  limits?: Partial<Limits>;
  /** Code root whose release.json /healthz names; default a directory without one. */
  codeRoot?: string;
  packs?: FakePack[];
  /** Leave out the product port of the console (ServerDeps.products). */
  withoutProducts?: boolean;
  /** Leave out the engine's extras (ServerDeps.runsDetail): start_run through RunsService.startRun, no record references. */
  withoutRunsDetail?: boolean;
}

export interface TestUser {
  user: User;
  principal: Principal;
  token: string;
}

export interface TestFakes {
  runs: FakeRuns;
  workflows: FakeWorkflows;
  knowledge: FakeKnowledge;
  packs: FakePackCatalog;
  resources: FakeResources;
  products: FakeProducts;
}

export interface ClientOptions {
  sessionId?: string;
  traceparent?: string;
  headers?: Record<string, string>;
}

export interface TestMcpClient {
  client: Client;
  /** Lists the tools (which also makes the SDK client validate every structuredContent against its outputSchema). */
  listTools(): ReturnType<Client['listTools']>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface ToolCallResult {
  isError: boolean;
  content: { type: string; text?: string }[];
  structuredContent: Record<string, unknown>;
}

export interface TestServer {
  url: string;
  mcpUrl: string;
  port: number;
  app: HubApp;
  deps: ServerDeps;
  records: TestRecordsKit;
  fakes: TestFakes;
  admin: TestUser;
  /** Operational log lines the app wrote (call-log write failures, page errors). */
  logs: string[];
  createUser(name: string, role?: PermissionRole): Promise<TestUser>;
  issueToken(user: Principal): Promise<string>;
  assign(user: Principal, packId: string): Promise<void>;
  client(token: string, options?: ClientOptions): Promise<TestMcpClient>;
  close(): Promise<void>;
}

const principalOf = (user: User): Principal => ({ id: user.id, name: user.name, role: user.role });

/**
 * ServerDeps over an opened records kit with the fakes of the five ports, the product port and the engine's extras
 * (runsDetail, which the fake run service implements): an assembly for tests.
 */
export function fakeDeps(
  config: HubConfig,
  records: RecordsKit,
  options: { now?: () => Date; packs?: FakePack[]; withoutProducts?: boolean; withoutRunsDetail?: boolean } = {},
): { deps: ServerDeps; fakes: TestFakes } {
  const now = options.now ?? (() => new Date());
  const workflows = new FakeWorkflows(records, options.packs ?? defaultPacks());
  const products = new FakeProducts(records, workflows);
  const fakes: TestFakes = {
    workflows,
    products,
    runs: new FakeRuns(records, workflows, now),
    knowledge: new FakeKnowledge(products),
    packs: new FakePackCatalog(records, workflows),
    resources: new FakeResources(records),
  };
  const deps: ServerDeps = {
    config,
    records,
    runs: fakes.runs,
    knowledge: fakes.knowledge,
    workflows,
    packs: fakes.packs,
    resources: fakes.resources,
    parsers: createDefaultRegistry(),
    now,
    ...(options.withoutProducts ? {} : { products }),
    ...(options.withoutRunsDetail ? {} : { runsDetail: fakes.runs }),
  };
  return { deps, fakes };
}

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const records = await openTestRecords({ postgres: options.postgres, now: options.now, limits: options.limits });
  const logs: string[] = [];
  try {
    const config: HubConfig = {
      dataDir: records.dataDir,
      logDir: join(records.dataDir, 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: records.database,
      keychain: { service: 'circle-hub-test', account: 'vault' },
      limits: { ...records.config.limits },
    };
    const { deps, fakes } = fakeDeps(config, records, options);
    const app = createApp(deps, { codeRoot: options.codeRoot ?? records.dataDir, log: (line) => logs.push(line), closeTimeoutMs: 5000 });
    const info = await app.listen();
    const boot = await records.principals.bootstrapAdmin('管理员');
    const admin: TestUser = { user: boot.user, principal: principalOf(boot.user), token: boot.token.token };
    const clients = new Set<TestMcpClient>();

    const server: TestServer = {
      url: info.url,
      mcpUrl: `${info.url}/mcp`,
      port: info.port,
      app,
      deps,
      records,
      fakes,
      admin,
      logs,
      async createUser(name, role = 'user') {
        const user = await records.principals.createUser(admin.principal, name, role);
        const token = await records.principals.issueToken(admin.principal, user.id, 'test');
        return { user, principal: principalOf(user), token: token.token };
      },
      async issueToken(user) {
        return (await records.principals.issueToken(admin.principal, user.id, 'test')).token;
      },
      async assign(user, packId) {
        await records.authorizations.assign(admin.principal, user.id, packId);
      },
      async client(token, clientOptions = {}) {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...clientOptions.headers };
        if (clientOptions.sessionId !== undefined) headers['circle-session-id'] = clientOptions.sessionId;
        if (clientOptions.traceparent !== undefined) headers.traceparent = clientOptions.traceparent;
        const transport = new StreamableHTTPClientTransport(new URL(`${info.url}/mcp`), { requestInit: { headers } });
        const client = new Client({ name: 'hub-server-test', version: '0.0.0' });
        await client.connect(transport);
        await client.listTools();
        const wrapper: TestMcpClient = {
          client,
          listTools: () => client.listTools(),
          call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult,
          close: async () => {
            clients.delete(wrapper);
            await client.close();
          },
        };
        clients.add(wrapper);
        return wrapper;
      },
      async close() {
        for (const client of [...clients]) await client.close().catch(() => {});
        await app.close();
        await records.close();
      },
    };
    return server;
  } catch (error) {
    await records.close();
    throw error;
  }
}
