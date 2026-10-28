// Temporary PostgreSQL for tests, run straight from the embedded-postgres binaries in node_modules (adapted from the earlier
// acceptance harness and postgres-process script). A temp data directory, a random port, loopback TCP or a Unix socket only,
// a random password with SCRAM, a minimal child environment, and stop() that removes everything.
// The unit runner may publish one already-migrated cluster through HUB_UNIT_PG_* (not CIRCLE_HUB_*, which the Hub refuses
// when unknown). startPostgres then clones a database with CREATE DATABASE ... TEMPLATE and stop() drops only those
// databases. A test that asks for its own socket still gets a private postmaster.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { DatabaseConfig } from '../config/index.ts';

export interface StartPostgresOptions {
  /** Listen on a Unix socket in the temp directory only (no TCP). Default false: 127.0.0.1 only. */
  socket?: boolean;
  /**
   * With `socket`: local connections need no password (trust on a 0700 socket directory only the current user can enter), so
   * a Hub child process can be configured from CIRCLE_HUB_* variables alone, which never carry secrets.
   */
  passwordless?: boolean;
  /** Startup timeout, default 60 s. */
  timeoutMs?: number;
  /** Start a private postmaster even when HUB_UNIT_PG_* publishes a shared cluster. */
  private?: boolean;
  /** Private clusters only. Default 60, the historical test-cluster size. */
  maxConnections?: number;
  /** Private clusters only, for example `512MB`. Default 32MB. */
  sharedBuffers?: string;
  /** Private clusters only. The shared unit cluster turns this off so autovacuum does not block template clones. */
  autovacuum?: boolean;
}

export interface TemporaryPostgres {
  /** Superuser connection to the maintenance database `postgres` (no password for a passwordless cluster). */
  readonly config: DatabaseConfig;
  readonly socket: boolean;
  /** Unix-socket directory (also for TCP clusters, where only the server itself uses it). */
  readonly socketDir: string;
  /** Temp directory holding the cluster; removed by stop(). A shared-cluster handle removes only its scratch directory. */
  readonly root: string;
  /** Postmaster pid of a private cluster. Absent when this handle only clones databases. */
  readonly pid?: number;
  /**
   * Creates a database and returns its connection config.
   * On a private cluster the database is empty. On the shared unit cluster it is cloned from the migrated template,
   * unless `empty` is set (migration tests that must observe versions being applied).
   */
  createDatabase(name?: string, options?: { empty?: boolean }): Promise<DatabaseConfig>;
  dropDatabase(name: string): Promise<void>;
  /** Fast shutdown, then removes the temp directory. Safe to call twice. */
  stop(): Promise<void>;
}

interface Binaries {
  initdb: string;
  postgres: string;
}

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const running = new Set<{ child: ChildProcess; root: string }>();
let exitHookInstalled = false;

/** Immediate shutdown and removal of every cluster still running in this process. */
function killAll(): void {
  for (const instance of running) {
    try {
      instance.child.kill('SIGQUIT');
    } catch {}
    try {
      rmSync(instance.root, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
  running.clear();
}

const TERMINATING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
let handlingSignal = false;

async function stopAllOnSignal(): Promise<void> {
  await Promise.allSettled([...running].map(async (instance) => {
    await stopChild(instance.child);
    await rm(instance.root, { recursive: true, force: true, maxRetries: 3 });
    running.delete(instance);
  }));
  // Retry only unfinished cleanup, after the bounded child shutdowns have settled.
  killAll();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort for a test process that ends without calling stop(). Node emits no 'exit' for a terminating signal (node --test
  // sends SIGTERM to a timed-out or cancelled file), so those are handled too: clean up, then re-raise the signal. SIGKILL
  // cannot be caught; a cluster left by it stays until removed by hand.
  process.on('exit', killAll);
  for (const signal of TERMINATING_SIGNALS) {
    process.once(signal, () => {
      if (handlingSignal) return;
      handlingSignal = true;
      // A signal handler can wait: stop the postmaster and its children before removing their data directory.
      // Deleting it immediately races the final filesystem writes on Linux.
      void stopAllOnSignal().finally(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    });
  }
}

async function binaries(): Promise<Binaries> {
  const name = `@embedded-postgres/${platform()}-${arch()}`;
  let module: Record<string, unknown>;
  try {
    module = (await import(name)) as Record<string, unknown>;
  } catch {
    throw new Error(`没有找到 ${name}：embedded-postgres 不支持这个平台，或者依赖没有安装`);
  }
  if (typeof module.initdb !== 'string' || typeof module.postgres !== 'string') throw new Error(`${name} 没有提供 initdb 和 postgres`);
  return { initdb: module.initdb, postgres: module.postgres };
}

/** No PG* variables, no secrets: the children see only what they need. */
function childEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnvironment(), timeout: timeoutMs });
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`initdb 失败（退出码 ${code ?? 'null'}，信号 ${signal ?? 'null'}）：${errors.trim()}`));
    });
  });
}

function clientConfig(config: DatabaseConfig): pg.ClientConfig {
  const password = config.password;
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    // A function, so pg never falls back to PGPASSWORD or a password file.
    password: async () => {
      if (password === undefined) throw new Error('the test cluster asked for a password it was not given');
      return password;
    },
    database: config.database,
    ssl: false,
    application_name: 'circle-hub-test',
    connectionTimeoutMillis: 5000,
  };
}

async function withClient<T>(config: DatabaseConfig, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(clientConfig(config));
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function waitReady(config: DatabaseConfig, child: ChildProcess, output: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`PostgreSQL 没有启动：${output().trim()}`);
    try {
      await withClient(config, (client) => client.query('SELECT 1'));
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`PostgreSQL 在 ${timeoutMs} 毫秒内没有就绪：${output().trim()}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

interface SharedCluster {
  host: string;
  port: number;
  user: string;
  password: string;
  template: string;
  emptyTemplate: string;
  socketDir: string;
}

/** Present only when the unit runner has started the shared cluster. Incomplete values throw, so a typo cannot fall through to initdb. */
function sharedCluster(): SharedCluster | undefined {
  const host = process.env.HUB_UNIT_PG_HOST;
  if (host === undefined || host === '') return undefined;
  const port = Number(process.env.HUB_UNIT_PG_PORT);
  const user = process.env.HUB_UNIT_PG_USER ?? '';
  const password = process.env.HUB_UNIT_PG_PASSWORD ?? '';
  const template = process.env.HUB_UNIT_PG_TEMPLATE ?? '';
  const emptyTemplate = process.env.HUB_UNIT_PG_EMPTY ?? 'template0';
  const socketDir = process.env.HUB_UNIT_PG_SOCKET_DIR ?? '';
  if (!Number.isInteger(port) || port <= 0 || user === '' || password === '' || !DATABASE_NAME.test(template) || !DATABASE_NAME.test(emptyTemplate)) {
    throw new Error('HUB_UNIT_PG_* 不完整，拒绝连到一个说不清的共享集群');
  }
  return { host, port, user, password, template, emptyTemplate, socketDir };
}

async function attachShared(shared: SharedCluster): Promise<TemporaryPostgres> {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-pg-shared-'));
  const config: DatabaseConfig = { host: shared.host, port: shared.port, database: 'postgres', user: shared.user, password: shared.password };
  const created = new Set<string>();
  const create = async (name: string, template: string): Promise<DatabaseConfig> => {
    if (!DATABASE_NAME.test(name) || !DATABASE_NAME.test(template)) throw new TypeError('test database names are lowercase letters, digits and underscores');
    // Template copies serialize, and a momentary autovacuum or a peer clone can refuse the copy. Retry the same name.
    let last: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await withClient(config, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE ${client.escapeIdentifier(template)}`));
        last = undefined;
        break;
      } catch (error) {
        last = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/being accessed|is being used/i.test(message) || attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    if (last !== undefined) throw last;
    created.add(name);
    return { ...config, database: name };
  };
  let stopping: Promise<void> | undefined;
  return {
    config,
    socket: false,
    socketDir: shared.socketDir,
    root,
    async createDatabase(name = `t_${randomBytes(6).toString('hex')}`, options?: { empty?: boolean }): Promise<DatabaseConfig> {
      return create(name, options?.empty === true ? shared.emptyTemplate : shared.template);
    },
    async dropDatabase(name: string): Promise<void> {
      if (!DATABASE_NAME.test(name)) throw new TypeError('test database names are lowercase letters, digits and underscores');
      await withClient(config, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
      created.delete(name);
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        for (const name of [...created]) {
          await withClient(config, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`)).catch(() => {});
        }
        created.clear();
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      })();
      return stopping;
    },
  };
}

export async function startPostgres(options: StartPostgresOptions = {}): Promise<TemporaryPostgres> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const socket = options.socket === true;
  const passwordless = options.passwordless === true;
  if (passwordless && !socket) throw new TypeError('passwordless clusters listen on a Unix socket only');
  if (!socket && !passwordless && options.private !== true) {
    const shared = sharedCluster();
    if (shared) return attachShared(shared);
  }
  const maxConnections = options.maxConnections ?? 60;
  if (!Number.isInteger(maxConnections) || maxConnections < 10 || maxConnections > 2000) throw new TypeError('maxConnections 必须是 10 到 2000 的整数');
  const sharedBuffers = options.sharedBuffers ?? '32MB';
  if (!/^\d{1,4}MB$/.test(sharedBuffers)) throw new TypeError('sharedBuffers 只接受像 32MB 这样的写法');
  const { initdb, postgres } = await binaries();
  // A Unix socket path holds at most 103 bytes; fall back to /tmp when the system temp directory is too deep for that.
  const base = socket && Buffer.byteLength(join(tmpdir(), 'circle-hub-pg-XXXXXX', 's', '.s.PGSQL.65535')) > 103 ? '/tmp' : tmpdir();
  const root = await mkdtemp(join(base, 'circle-hub-pg-'));
  const dataDir = join(root, 'data');
  const socketDir = join(root, 's');
  const user = 'hub_test';
  const password = randomBytes(24).toString('base64url');
  let child: ChildProcess | undefined;
  let instance: { child: ChildProcess; root: string } | undefined;
  try {
    await mkdir(socketDir, { mode: 0o700 });
    const passwordFile = join(root, 'pwfile');
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
    try {
      await run(
        initdb,
        [
          '--pgdata', dataDir,
          ...(passwordless ? ['--auth-local=trust', '--auth-host=scram-sha-256'] : ['--auth=scram-sha-256']),
          '--username', user,
          '--pwfile', passwordFile,
          '--encoding=UTF8',
          '--no-locale',
          '--no-sync',
          '--no-instructions',
        ],
        timeoutMs,
      );
    } finally {
      await rm(passwordFile, { force: true });
    }
    const port = await freePort();
    child = spawn(
      postgres,
      [
        '-D', dataDir,
        '-p', String(port),
        '-k', socketDir,
        '-c', `listen_addresses=${socket ? '' : '127.0.0.1'}`,
        '-c', 'unix_socket_permissions=0700',
        '-c', 'fsync=off',
        '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off',
        '-c', `shared_buffers=${sharedBuffers}`,
        '-c', `max_connections=${maxConnections}`,
        ...(options.autovacuum === false ? ['-c', 'autovacuum=off'] : []),
        '-c', 'TimeZone=UTC',
        '-c', 'log_timezone=UTC',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: childEnvironment() },
    );
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
    });
    instance = { child, root };
    running.add(instance);
    installExitHook();
    const config: DatabaseConfig = { host: socket ? socketDir : '127.0.0.1', port, database: 'postgres', user, ...(passwordless ? {} : { password }) };
    await waitReady(config, child, () => output, timeoutMs);
    // A forgotten stop() must not keep the test process alive; stop() takes the reference back while it waits.
    child.unref();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    const started = child;
    const self = instance;
    let stopping: Promise<void> | undefined;
    return {
      config,
      socket,
      socketDir,
      root,
      pid: child.pid,
      async createDatabase(name = `t_${randomBytes(6).toString('hex')}`, _options?: { empty?: boolean }): Promise<DatabaseConfig> {
        if (!DATABASE_NAME.test(name)) throw new TypeError('test database names are lowercase letters, digits and underscores');
        await withClient(config, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
        return { ...config, database: name };
      },
      async dropDatabase(name: string): Promise<void> {
        if (!DATABASE_NAME.test(name)) throw new TypeError('test database names are lowercase letters, digits and underscores');
        await withClient(config, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
      },
      stop(): Promise<void> {
        stopping ??= (async () => {
          await stopChild(started);
          running.delete(self);
          await rm(root, { recursive: true, force: true, maxRetries: 3 });
        })();
        return stopping;
      },
    };
  } catch (error) {
    if (child !== undefined) await stopChild(child).catch(() => {});
    if (instance !== undefined) running.delete(instance);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.ref();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
