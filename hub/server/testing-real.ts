import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../connectors/testing/credentials.ts';
// createTestHub(): the Hub assembled from the REAL packages in-process (hub/server/assemble/hub.ts: pack registry, run
// engine, knowledge, connectors) on a temporary PostgreSQL, listening on a loopback port. The external systems are the
// connectors' synthetic stub servers (hub/connectors/testing, loopback only), and the packs under packs/ that have a
// pack.json are published through the real registry (product packs activated). Helpers create users and tokens, assign
// packs, publish more packs, add resources, set credentials and run a knowledge sync; client() wraps the official SDK
// client over streamable HTTP. This is what the acceptance tests use. Nothing here reaches a real system, the owner's
// keychain or any file outside temporary directories.
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PACK_KIND, type PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { packPathProblem } from '../../contracts/src/pack.ts';
import type { ResourceRecord } from '../../contracts/src/resources.ts';
import type { HubConfig, Limits } from '../config/index.ts';
import type { AddResourceInput } from '../connectors/api.ts';
import {
  agileFixture,
  startAgileStub,
  startBuildSiteStub,
  startPlmStub,
  startWebDavStub,
  type AgileOptions,
  type AgileStub,
  type PlmStub,
  type StaticFile,
  type StubServer,
} from '../connectors/testing/api.ts';
import type { SyncOptions, SyncReport } from '../knowledge/api.ts';
import type { Principal, User } from '../records/api.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import type { PackVersionInfo } from '../runs/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import type { HubApp, ServerDeps } from './api.ts';
import { createApp } from './app.ts';
import { removeTree } from './assemble/files.ts';
import type { LeaseService } from '../leases/service.ts';
import { assembleHub, type AssembledHub } from './assemble/hub.ts';
import type { ClientOptions, TestMcpClient, TestUser, ToolCallResult } from './testing.ts';

export type { ClientOptions, TestMcpClient, TestUser, ToolCallResult } from './testing.ts';

/** The packs of this repository: packs/<kind>/<name>/pack.json. */
export const REPOSITORY_PACKS = fileURLToPath(new URL('../../packs/', import.meta.url));
/** Document id of the mind map the agile stub serves by default (invented). */
export const AGILE_DOCUMENT = 'd7f3k9';

export interface TestHubOptions {
  /** Cluster to create the database in (one per test file); without one the hub starts and stops its own. */
  postgres?: TemporaryPostgres;
  now?: () => Date;
  limits?: Partial<Limits>;
  /** Code root whose release.json /healthz names; default a directory without one. */
  codeRoot?: string;
  /**
   * The packs under packs/ that have a pack.json: true (default) publishes all of them (none there is not an error), false
   * none, a list of pack ids exactly those (one that is not there is an error).
   */
  repositoryPacks?: boolean | string[];
  /** Where the repository's packs are looked for; default REPOSITORY_PACKS (tests of this helper use a synthetic tree). */
  repositoryRoot?: string;
  /** More pack directories, published after the repository's in this order. */
  packs?: string[];
  /** Activate every product pack published at start (default true). */
  activateProducts?: boolean;
  /** Start the connectors' stub servers (default true). */
  stubs?: boolean;
  /** The agile stub's fixture; default agileFixture(AGILE_DOCUMENT). */
  agile?: AgileOptions;
  /** The build site stub's files; default its own. */
  buildSite?: Record<string, StaticFile>;
  /** The WebDAV stub's files; default its own. */
  webdav?: Record<string, string>;
  /** Pack functions under sandbox-exec; default where it is available (synthetic tests may run without it). */
  requireOsIsolation?: boolean;
}

export interface TestStubs {
  agile: AgileStub;
  plm: PlmStub;
  buildSite: StubServer;
  webdav: StubServer;
  /** The agile stub's synthetic account (the PLM stub accepts its tokens). */
  agileAccount: { username: string; password: string };
}

export interface TestHub {
  url: string;
  mcpUrl: string;
  port: number;
  app: HubApp;
  deps: ServerDeps;
  /** Every service of the assembly: registry, connectors, knowledge, the run engine. */
  hub: AssembledHub;
  records: TestRecordsKit;
  /** The bootstrapped admin; it holds the publish right. */
  admin: TestUser;
  stubs: TestStubs | null;
  /** Versions published at start, in order. */
  published: PackVersionInfo[];
  /** Lines of the operator's log (the app's and the assembly's). */
  logs: string[];
  /** The lease service the engine uses (over this hub's database). */
  leases: LeaseService;
  createUser(name: string, role?: PermissionRole): Promise<TestUser>;
  issueToken(user: Principal): Promise<string>;
  assignPack(user: Principal, packId: string): Promise<void>;
  /** Publishes a pack directory as the admin (only the files its pack.json lists); a refusal throws with every problem. */
  publishPack(directory: string, options?: { activate?: boolean }): Promise<PackVersionInfo>;
  activate(packId: string): Promise<void>;
  addResource(input: AddResourceInput): Promise<ResourceRecord>;
  setCredential(resource: string, name: string, value: string): Promise<void>;
  /** A knowledge sync of a product (any name or its line id) as the admin. */
  knowledgeSync(product: string, options?: Omit<SyncOptions, 'by'>): Promise<SyncReport>;
  client(token: string, options?: ClientOptions): Promise<TestMcpClient>;
  close(): Promise<void>;
}

const principalOf = (user: Pick<User, 'id' | 'name' | 'role'>): Principal => ({ id: user.id, name: user.name, role: user.role });

/** Publication order of the kinds: the vocabulary's order, an unknown kind last. */
const kindOrder = (kind: string): number => {
  const at = (PACK_KIND as readonly string[]).indexOf(kind);
  return at < 0 ? PACK_KIND.length : at;
};

/**
 * Pack directories under `root` (depth 3 at most), by kind in the vocabulary's order, then by id: a directory with a
 * pack.json is a pack and is not searched further. With `ids`, only those packs (all of them must be there).
 */
export async function findPackDirectories(root: string = REPOSITORY_PACKS, ids?: readonly string[]): Promise<string[]> {
  const out: { dir: string; kind: string; id: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'pack.json')) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as { kind?: unknown; id?: unknown };
        out.push({ dir, kind: String(manifest.kind), id: String(manifest.id) });
      } catch {
        out.push({ dir, kind: '', id: dir });
      }
      return;
    }
    if (depth >= 3) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(resolve(root), 0);
  const chosen = ids === undefined ? out : out.filter((p) => ids.includes(p.id));
  const missing = (ids ?? []).filter((id) => !out.some((p) => p.id === id));
  if (missing.length > 0) throw new Error(`${root} 下没有这些任务包：${missing.join('、')}`);
  return chosen.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((p) => p.dir);
}

/**
 * Copies exactly the files a pack's manifest lists (and the manifest) into a new directory under `scratch`, so that test
 * files kept beside a pack's functions do not count as unlisted files. Paths that are not pack file paths are refused.
 */
export async function stagePack(directory: string, scratch: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8')) as { files?: { path?: unknown }[] };
  const target = await mkdtemp(join(scratch, 'pack-'));
  for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
    const path = String(file?.path);
    const problem = packPathProblem(path);
    if (problem !== null) throw new Error(`${directory}/pack.json 列出的 ${path.slice(0, 120)} 不是任务包文件路径：${problem}`);
    const source = join(directory, path);
    if (!(await lstat(source)).isFile()) throw new Error(`${directory} 里的 ${path} 不是普通文件`);
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyFile(source, join(target, path));
  }
  await writeFile(join(target, 'pack.json'), await readFile(join(directory, 'pack.json')));
  return target;
}

async function startStubs(options: TestHubOptions): Promise<TestStubs> {
  const fixture = options.agile ?? agileFixture(AGILE_DOCUMENT);
  const started: StubServer[] = [];
  try {
    const agile = await startAgileStub(fixture);
    started.push(agile);
    const plm = await startPlmStub({ accepts: (token) => agile.tokens.has(token) });
    started.push(plm);
    const buildSite = await startBuildSiteStub(options.buildSite);
    started.push(buildSite);
    const webdav = await startWebDavStub(options.webdav);
    started.push(webdav);
    return { agile, plm, buildSite, webdav, agileAccount: { username: fixture.username, password: fixture.password } };
  } catch (error) {
    await Promise.allSettled(started.map((stub) => stub.close()));
    throw error;
  }
}

export async function createTestHub(options: TestHubOptions = {}): Promise<TestHub> {
  const scratch = await mkdtemp(join(tmpdir(), 'circle-hub-testhub-'));
  let records: TestRecordsKit;
  try {
    records = await openTestRecords({ postgres: options.postgres, now: options.now, limits: options.limits });
  } catch (error) {
    await removeTree(scratch);
    throw error;
  }
  const logs: string[] = [];
  let stubs: TestStubs | null = null;
  let app: HubApp | null = null;
  const clients = new Set<TestMcpClient>();
  let closing: Promise<void> | null = null;
  const cleanup = (): Promise<void> =>
    (closing ??= (async () => {
      for (const client of [...clients]) await client.close().catch(() => {});
      if (app !== null) await app.close().catch(() => {});
      if (stubs !== null) await Promise.allSettled([stubs.agile.close(), stubs.plm.close(), stubs.buildSite.close(), stubs.webdav.close()]);
      await records.close().catch(() => {});
      // Extracted packs are read-only trees.
      await removeTree(scratch);
    })());
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
    if (options.stubs !== false) stubs = await startStubs(options);
    // The assembly builds the lease service over the same database by default (the production path); the test hub
    // proves it by exposing the assembled one.
    const hub = await assembleHub(config, records, {
      requireOsIsolation: options.requireOsIsolation ?? (await osIsolationAvailable()),
      requireVaultKey: true,
      ...(options.now === undefined ? {} : { now: options.now }),
      log: (line) => logs.push(line),
      resourceCacheMs: 0,
      // Outside the records' data directory, which records remove without unlocking read-only trees.
      extractDir: join(scratch, 'extracted'),
    });
    const boot = await records.principals.bootstrapAdmin('管理员');
    const admin: TestUser = { user: boot.user, principal: principalOf(boot.user), token: boot.token.token };
    await records.authorizations.grantPublishRight(admin.principal, admin.user.id, '测试 Hub 的管理员发布任务包');

    const publishPack = async (directory: string, publish: { activate?: boolean } = {}): Promise<PackVersionInfo> => {
      const staged = await stagePack(directory, scratch);
      const outcome = await hub.registry.publish(admin.principal, staged);
      if (!outcome.ok) {
        const lines = outcome.problems.map((p) => `- [${p.rule}] ${p.file}${p.field ? ` ${p.field}` : ''}${p.line ? ` 第 ${p.line} 行` : ''}：${p.message}（${p.fix}）`);
        throw new Error(`任务包 ${directory} 没有发布：\n${lines.join('\n')}`);
      }
      if (outcome.version.kind === 'product' && publish.activate !== false && !(await hub.registry.isActive(outcome.version.id))) {
        await hub.registry.activate(admin.principal, outcome.version.id);
      }
      return outcome.version;
    };

    const published: PackVersionInfo[] = [];
    const repository = options.repositoryPacks ?? true;
    const directories = [
      ...(repository === false ? [] : await findPackDirectories(options.repositoryRoot ?? REPOSITORY_PACKS, repository === true ? undefined : repository)),
      ...(options.packs ?? []),
    ];
    for (const directory of directories) published.push(await publishPack(directory, { activate: options.activateProducts !== false }));

    app = createApp(hub.deps, { codeRoot: options.codeRoot ?? records.dataDir, log: (line) => logs.push(line), closeTimeoutMs: 5000 });
    const info = await app.listen();
    const running = app;

    const testHub: TestHub = {
      url: info.url,
      mcpUrl: `${info.url}/mcp`,
      port: info.port,
      app: running,
      deps: hub.deps,
      hub,
      records,
      admin,
      stubs,
      published,
      logs,
      leases: hub.leases,
      async createUser(name, role = 'user') {
        const user = await records.principals.createUser(admin.principal, name, role);
        const token = await records.principals.issueToken(admin.principal, user.id, 'test');
        return { user, principal: principalOf(user), token: token.token };
      },
      async issueToken(user) {
        return (await records.principals.issueToken(admin.principal, user.id, 'test')).token;
      },
      async assignPack(user, packId) {
        await hub.registry.assign(admin.principal, user.id, packId);
      },
      publishPack,
      async activate(packId) {
        await hub.registry.activate(admin.principal, packId);
      },
      addResource(input) {
        return addSyntheticResource(records, hub.packs, hub.connectors, admin.principal, input);
      },
      setCredential(resource, name, value) {
        return setSyntheticCredential(records, hub.connectors, admin.principal, resource, name, value);
      },
      async knowledgeSync(product, sync = {}) {
        const handle = (await hub.packs.productByName(product)) ?? (await hub.packs.productById(product));
        if (handle === null) throw new Error(`没有叫 ${product} 的启用中的产品包`);
        return hub.knowledge.syncProduct(handle, { ...sync, by: admin.principal });
      },
      async client(token, clientOptions = {}) {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...clientOptions.headers };
        if (clientOptions.sessionId !== undefined) headers['circle-session-id'] = clientOptions.sessionId;
        if (clientOptions.traceparent !== undefined) headers.traceparent = clientOptions.traceparent;
        const transport = new StreamableHTTPClientTransport(new URL(`${info.url}/mcp`), { requestInit: { headers } });
        const client = new Client({ name: 'hub-test-real', version: '0.0.0' });
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
      close: cleanup,
    };
    return testHub;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
