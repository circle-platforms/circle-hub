// Temporary PostgreSQL for tests, run straight from the embedded-postgres binaries in node_modules (adapted from the earlier
// acceptance harness and postgres-process script). A temp data directory, a random port, loopback TCP or a Unix socket only,
// a random password with SCRAM, a minimal child environment, and stop() that removes everything. Never a shared server.
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
}

export interface TemporaryPostgres {
  /** Superuser connection to the maintenance database `postgres` (no password for a passwordless cluster). */
  readonly config: DatabaseConfig;
  readonly socket: boolean;
  /** Unix-socket directory (also for TCP clusters, where only the server itself uses it). */
  readonly socketDir: string;
  /** Temp directory holding the cluster; removed by stop(). */
  readonly root: string;
  /** Creates an empty database and returns its connection config. */
  createDatabase(name?: string): Promise<DatabaseConfig>;
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

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort for a test process that ends without calling stop(). Node emits no 'exit' for a terminating signal (node --test
  // sends SIGTERM to a timed-out or cancelled file), so those are handled too: clean up, then re-raise the signal. SIGKILL
  // cannot be caught; a cluster left by it stays until removed by hand.
  process.on('exit', killAll);
  for (const signal of TERMINATING_SIGNALS) {
    process.once(signal, () => {
      killAll();
      // Re-raise with the default action, unless the process has its own handler for this signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
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

export async function startPostgres(options: StartPostgresOptions = {}): Promise<TemporaryPostgres> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const socket = options.socket === true;
  const passwordless = options.passwordless === true;
  if (passwordless && !socket) throw new TypeError('passwordless clusters listen on a Unix socket only');
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
        '-c', 'shared_buffers=32MB',
        '-c', 'max_connections=60',
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
      async createDatabase(name = `t_${randomBytes(6).toString('hex')}`): Promise<DatabaseConfig> {
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
