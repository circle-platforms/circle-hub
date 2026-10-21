// Persistent PostgreSQL from the embedded-postgres binaries pinned in node_modules (initdb, pg_ctl and postgres only).
// The cluster has no TCP listener (listen_addresses = '') and one unix socket in <root>/run.
//
// Authentication, and why: the socket directory and the socket are private to the owner (0700), and pg_hba.conf has two
// peer lines through the ident map `owner`: the superuser role may connect to every database, the application role only
// to the Hub database. Peer authentication asks the kernel which operating-system user is on the other end of the
// socket; the ident map lets only the account that owns the deployment in, as one of two roles: its own superuser role
// (named after the account: initdb, the migrations, pg_dump and pg_restore; it owns the Hub database and every object in
// it) and the application role the running server uses (circle_hub: not a superuser, owns nothing, only connects and
// holds the grants the migration gives it, so it can neither run superuser-only statements such as COPY ... TO PROGRAM
// nor drop, alter or disable the triggers of the append-only tables; see roles.ts). Kept out of postgres and template1,
// where PUBLIC may connect and create temporary tables, it cannot leave objects there either. There is no password to
// store, leak or rotate; TCP, every other role mapping and every other local user are refused.
import { access, appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformError } from './errors.ts';
import { isMissingOrEmpty } from './files.ts';
import { assertSocketPath, DATA_ROOT_VARIABLE, type Layout } from './layout.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';
import { APPLICATION_ROLE, DATABASE_NAME, DATABASE_PORT } from './settings.ts';
import { quoteIdentifier, socketConnector, withSession, type SqlConnector } from './sql.ts';

export interface PostgresBinaries {
  initdb: string;
  pg_ctl: string;
  postgres: string;
}

export interface DatabaseTarget {
  socketDir: string;
  port: number;
  user: string;
  database: string;
}

export interface PostgresOptions {
  layout: Layout;
  /** Superuser role created by initdb; must equal the operating-system user. Default: the current user. */
  admin?: string;
  /** Application role of the server. Default circle_hub. */
  role?: string;
  /** Names the socket file only. Default 5432. */
  port?: number;
  database?: string;
  binaries?: PostgresBinaries;
  /** Root whose node_modules holds the binaries, for example a release directory. Default: this checkout. */
  binariesRoot?: string;
  runner?: CommandRunner;
  /** Connector for the admin role (tests may replace it). */
  connector?: SqlConnector;
  startTimeoutSeconds?: number;
}

export interface PostgresStatus {
  initialised: boolean;
  running: boolean;
  pid?: number;
  dataMajor?: number;
  binaryMajor: number;
  binaryVersion: string;
  socketDir: string;
}

export interface PostgresControl {
  readonly layout: Layout;
  /** The platform's own connection: superuser role, Hub database. */
  readonly target: DatabaseTarget;
  /** The server's connection: application role, Hub database. */
  readonly application: DatabaseTarget;
  readonly connector: SqlConnector;
  readonly applicationConnector: SqlConnector;
  binaries(): Promise<PostgresBinaries>;
  binaryVersion(): Promise<{ text: string; major: number }>;
  /** Creates the cluster only when PG_VERSION is missing; true when it created one. */
  initialise(): Promise<boolean>;
  /** True when it started the server, false when it was already running. */
  start(): Promise<boolean>;
  /** Fast shutdown; true when it stopped a running server. */
  stop(): Promise<boolean>;
  status(): Promise<PostgresStatus>;
  /**
   * Creates the application role and the Hub database when missing; true when it created the database. The database
   * belongs to the superuser role; the application role gets CONNECT only (the migration grants the rest).
   */
  ensureDatabase(): Promise<boolean>;
  /** True when the application role and the Hub database both exist (the server must be running). */
  databaseExists(): Promise<boolean>;
}

const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOLS = ['initdb', 'pg_ctl', 'postgres'] as const;
/** Names written into pg_hba.conf and pg_ident.conf (quoted): nothing that could end the quotes or the field. */
const ROLE_NAME = /^[A-Za-z0-9._$-]{1,63}$/;
const DATABASE_NAME_RULE = /^[A-Za-z0-9_$-]{1,63}$/;
const MANAGED_CONF = 'circle-hub.conf';
const IDENT_MAP = 'owner';

export function binaryPackage(): string {
  return `@embedded-postgres/${process.platform}-${process.arch}`;
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The pinned binaries under `<root>/node_modules`, falling back to Node resolution for this checkout. */
export async function resolveBinaries(root: string = CODE_ROOT): Promise<PostgresBinaries> {
  const pkg = binaryPackage();
  const candidates = [join(root, 'node_modules', pkg, 'native', 'bin')];
  if (root === CODE_ROOT) {
    try {
      candidates.push(join(dirname(fileURLToPath(import.meta.resolve(pkg))), '..', 'native', 'bin'));
    } catch {
      // Not installed for this platform.
    }
  }
  for (const dir of candidates) {
    const binaries = { initdb: join(dir, 'initdb'), pg_ctl: join(dir, 'pg_ctl'), postgres: join(dir, 'postgres') };
    let complete = true;
    for (const tool of TOOLS) complete &&= await present(binaries[tool]);
    if (complete) return binaries;
  }
  throw new PlatformError(`找不到 PostgreSQL 二进制（${pkg}，在 ${root}）`, '在该目录运行 npm ci');
}

/** "postgres (PostgreSQL) 18.4" -> 18 */
export function majorOf(versionText: string): number {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionText);
  if (!match) throw new PlatformError(`看不懂版本输出：${versionText.trim().slice(0, 120)}`);
  return Number(match[1]);
}

export async function toolVersion(path: string, runner: CommandRunner): Promise<{ text: string; major: number }> {
  const result = await runner(path, ['--version'], { env: toolEnvironment() });
  if (result.code !== 0) throw new PlatformError(`${path} --version 失败（退出码 ${result.code}）：${tailLines(result.stderr)}`);
  const text = result.stdout.trim();
  return { text, major: majorOf(text) };
}

export function currentUser(): string {
  return userInfo().username;
}

function quoteConf(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function managedConf(layout: Layout, port: number): string {
  return [
    '# Managed by circle-hub and rewritten at every start; do not edit.',
    "listen_addresses = ''",
    `port = ${port}`,
    `unix_socket_directories = ${quoteConf(layout.run)}`,
    'unix_socket_permissions = 0700',
    'logging_collector = on',
    `log_directory = ${quoteConf(join(layout.logs, 'postgres'))}`,
    "log_filename = 'postgresql-%a.log'",
    'log_truncate_on_rotation = on',
    "log_rotation_age = '1d'",
    'log_rotation_size = 0',
    "timezone = 'UTC'",
    "log_timezone = 'UTC'",
    '',
  ].join('\n');
}

/** The superuser role may connect to every database, the application role only to the Hub database. */
export function managedHba(admin: string, role: string, database: string): string {
  const lines = [
    '# Managed by circle-hub and rewritten at every start; do not edit.',
    `# Unix socket only. Peer authentication through the "${IDENT_MAP}" map in pg_ident.conf: only the deployment owner, as listed roles.`,
    `local   all   "${admin}"   peer   map=${IDENT_MAP}`,
  ];
  if (role !== admin) lines.push(`local   "${database}"   "${role}"   peer   map=${IDENT_MAP}`);
  return `${lines.join('\n')}\n`;
}

export function managedIdent(admin: string, role: string): string {
  const lines = ['# Managed by circle-hub and rewritten at every start; do not edit.', '# MAP   SYSTEM-USER   DATABASE-ROLE'];
  for (const target of new Set([admin, role])) lines.push(`${IDENT_MAP}   "${admin}"   "${target}"`);
  return `${lines.join('\n')}\n`;
}

export function dataMajorMismatch(dataMajor: number, binaryMajor: number): PlatformError {
  return new PlatformError(
    `数据目录是 PostgreSQL ${dataMajor} 的格式，当前二进制是 PostgreSQL ${binaryMajor}，不启动`,
    `大版本升级要导出再导入：1) 用带 PostgreSQL ${dataMajor} 二进制的旧发布运行 circle-hub backup；` +
      `2) 把 ${DATA_ROOT_VARIABLE} 指向一个新的空数据根，用新发布运行 circle-hub restore <备份目录>；` +
      '3) 确认新数据根运行正常后再处理旧数据根',
  );
}

export function createPostgres(options: PostgresOptions): PostgresControl {
  const layout = options.layout;
  const runner = options.runner ?? runCommand;
  const admin = options.admin ?? currentUser();
  const role = options.role ?? APPLICATION_ROLE;
  for (const name of [admin, role]) {
    if (!ROLE_NAME.test(name)) throw new PlatformError(`数据库角色名只能含字母、数字、点、下划线、$ 和连字符：${name}`);
  }
  const port = options.port ?? DATABASE_PORT;
  const database = options.database ?? DATABASE_NAME;
  if (!DATABASE_NAME_RULE.test(database)) throw new PlatformError(`数据库名只能含字母、数字、下划线、$ 和连字符：${database}`);
  const target: DatabaseTarget = { socketDir: layout.run, port, user: admin, database };
  const application: DatabaseTarget = { ...target, user: role };
  const connector = options.connector ?? socketConnector(target);
  const applicationConnector = socketConnector(application);
  const timeout = options.startTimeoutSeconds ?? 60;
  const env = toolEnvironment();
  let resolved: Promise<PostgresBinaries> | undefined = options.binaries ? Promise.resolve(options.binaries) : undefined;
  const binaries = () => (resolved ??= resolveBinaries(options.binariesRoot));
  let version: Promise<{ text: string; major: number }> | undefined;
  const binaryVersion = () => (version ??= binaries().then((bins) => toolVersion(bins.postgres, runner)));
  const versionFile = join(layout.db, 'PG_VERSION');

  const dataMajor = async (): Promise<number | undefined> => {
    let text: string;
    try {
      text = await readFile(versionFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const major = Number(text.trim());
    if (!Number.isInteger(major) || major <= 0) throw new PlatformError(`看不懂 ${versionFile} 的内容`);
    return major;
  };

  const writeManagedFiles = async (): Promise<void> => {
    await writeFile(join(layout.db, MANAGED_CONF), managedConf(layout, port), { mode: 0o600 });
    await writeFile(join(layout.db, 'pg_hba.conf'), managedHba(admin, role, database), { mode: 0o600 });
    await writeFile(join(layout.db, 'pg_ident.conf'), managedIdent(admin, role), { mode: 0o600 });
  };

  const prepareDirectories = async (): Promise<void> => {
    for (const dir of [layout.run, layout.logs, join(layout.logs, 'postgres')]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
  };

  const status = async (): Promise<PostgresStatus> => {
    const { text, major: binaryMajor } = await binaryVersion();
    const major = await dataMajor();
    const base = { binaryMajor, binaryVersion: text, socketDir: layout.run };
    if (major === undefined) return { initialised: false, running: false, ...base };
    const result = await runner((await binaries()).pg_ctl, ['status', '-D', layout.db], { env, timeoutMs: 30_000 });
    if (result.code === 0) {
      const pid = /PID:\s*(\d+)/.exec(result.stdout);
      return { initialised: true, running: true, dataMajor: major, ...base, ...(pid ? { pid: Number(pid[1]) } : {}) };
    }
    if (result.code === 3 || result.code === 4) return { initialised: true, running: false, dataMajor: major, ...base };
    throw new PlatformError(`pg_ctl status 失败（退出码 ${result.code}）：${tailLines(result.stderr || result.stdout)}`);
  };

  return {
    layout,
    target,
    application,
    connector,
    applicationConnector,
    binaries,
    binaryVersion,
    status,

    async initialise() {
      assertSocketPath(layout, port);
      if ((await dataMajor()) !== undefined) return false;
      if (!(await isMissingOrEmpty(layout.db))) {
        throw new PlatformError(`数据目录 ${layout.db} 不是空的，却没有 PG_VERSION：不初始化，免得覆盖`, '手动检查这个目录');
      }
      await mkdir(layout.db, { recursive: true, mode: 0o700 });
      await prepareDirectories();
      const result = await runner(
        (await binaries()).initdb,
        [`--pgdata=${layout.db}`, `--username=${admin}`, '--auth-local=peer', '--auth-host=reject', '--encoding=UTF8', '--locale=C', '--no-instructions'],
        { env, timeoutMs: 300_000 },
      );
      if (result.code !== 0) throw new PlatformError(`initdb 失败（退出码 ${result.code}）：${tailLines(result.stderr || result.stdout)}`);
      await appendFile(join(layout.db, 'postgresql.conf'), `\n# circle-hub managed settings\ninclude '${MANAGED_CONF}'\n`);
      await writeManagedFiles();
      return true;
    },

    async start() {
      assertSocketPath(layout, port);
      const current = await status();
      if (!current.initialised) throw new PlatformError('数据库还没初始化', '先运行 circle-hub init');
      if (current.dataMajor !== current.binaryMajor) throw dataMajorMismatch(current.dataMajor!, current.binaryMajor);
      if (current.running) return false;
      await prepareDirectories();
      await chmod(layout.db, 0o700);
      await writeManagedFiles();
      const startLog = join(layout.logs, 'postgres-start.log');
      const result = await runner(
        (await binaries()).pg_ctl,
        ['start', '-D', layout.db, '-l', startLog, '-w', '-t', String(timeout), '-s'],
        { env, timeoutMs: (timeout + 30) * 1000 },
      );
      if (result.code !== 0) {
        const log = await readFile(startLog, 'utf8').catch(() => '');
        throw new PlatformError(`PostgreSQL 没有启动（pg_ctl 退出码 ${result.code}）：${tailLines(log || result.stderr || result.stdout)}`);
      }
      return true;
    },

    async stop() {
      if (!(await status()).running) return false;
      const result = await runner((await binaries()).pg_ctl, ['stop', '-D', layout.db, '-m', 'fast', '-w', '-t', '120', '-s'], { env, timeoutMs: 150_000 });
      if (result.code !== 0) throw new PlatformError(`PostgreSQL 没有停下（pg_ctl 退出码 ${result.code}）：${tailLines(result.stderr || result.stdout)}`);
      return true;
    },

    async ensureDatabase() {
      if (role === admin) {
        throw new PlatformError(`应用角色 ${role} 与超级用户角色同名：服务器会以超级用户运行，只追加的约束不成立`, '新数据根在 init 之前用 CIRCLE_HUB_DATABASE_USER 选另一个角色名');
      }
      return withSession(connector, 'postgres', async (session) => {
        const roles = await session.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role]);
        if (roles.length === 0) {
          await session.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        }
        const databases = await session.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [database]);
        if (databases.length > 0) return false;
        // The database belongs to the cluster's superuser role, never to the application role: the owner of a database owns its
        // public schema (pg_database_owner) and may drop the append-only tables, so the application role only connects and
        // gets the grants the records package gives it (README decision 16).
        await session.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
        await session.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
        await session.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(role)}`);
        return true;
      });
    },

    async databaseExists() {
      return withSession(connector, 'postgres', async (session) => {
        const [row] = await session.query(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $2) AS present`,
          [role, database],
        );
        return row?.present === true;
      });
    },
  };
}

/** Owner of the Hub database (pg_database.datdba), or undefined when there is no such database. The server must be running. */
export async function databaseOwner(control: PostgresControl): Promise<string | undefined> {
  const rows = await withSession(control.connector, 'postgres', (session) =>
    session.query('SELECT pg_catalog.pg_get_userbyid(datdba)::text AS owner FROM pg_catalog.pg_database WHERE datname = $1', [control.target.database]),
  );
  return rows[0] === undefined ? undefined : String(rows[0].owner);
}

/**
 * Starts an initialised cluster when needed; never initialises one. The Hub database must already exist: only init and
 * restore create it (`create: true`), so a mistyped database name can never produce an empty database that looks fine.
 */
export async function ensureDatabaseRunning(control: PostgresControl, options: { create?: boolean } = {}): Promise<{ started: boolean; created: boolean }> {
  const started = await control.start();
  if (options.create === true) return { started, created: await control.ensureDatabase() };
  if (!(await control.databaseExists())) {
    throw new PlatformError(
      `数据库 ${control.target.database}（或它的角色 ${control.application.user}）不存在，不新建`,
      '新的数据根先运行 circle-hub init；数据被移开时用 circle-hub restore 恢复；检查部署设置里的数据库名',
    );
  }
  return { started, created: false };
}
