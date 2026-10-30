// SQL over the cluster's unix socket (or, where there is no peer authentication, loopback TCP with SCRAM), and per-table
// row counts and digests used to prove a restore complete.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { PlatformError } from './errors.ts';

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export type SqlConnector = (database: string) => Promise<SqlSession>;

export interface SocketTarget {
  socketDir: string;
  port: number;
  user: string;
}

/**
 * Session settings sent at connect. node-postgres takes any field left empty from the caller's PG* variables
 * (PGOPTIONS, PGSSLNEGOTIATION, PGREPLICATION, PGCLIENTENCODING), so every one of them is given here, non-empty.
 */
export const SESSION_OPTIONS = [
  '-c default_transaction_read_only=off',
  '-c statement_timeout=0',
  '-c lock_timeout=0',
  '-c idle_in_transaction_session_timeout=0',
  '-c client_encoding=UTF8',
].join(' ');

/** The connection settings of a platform session: nothing comes from PG* variables or ~/.pgpass. */
export function sessionConfig(target: SocketTarget, database: string): pg.ClientConfig & { replication: string } {
  return {
    host: target.socketDir,
    port: target.port,
    user: target.user,
    database,
    ssl: false,
    sslnegotiation: 'postgres',
    replication: 'false',
    options: SESSION_OPTIONS,
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 10_000,
    application_name: 'circle-hub-platform',
  };
}

export function socketConnector(target: SocketTarget): SqlConnector {
  return async (database) => {
    const client = new pg.Client(sessionConfig(target, database));
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => {});
      throw new PlatformError(`连不上数据库 ${database}（套接字目录 ${target.socketDir}）：${(error as Error).message}`);
    }
    return {
      async query(text, values) {
        const result = await client.query(text, values);
        return result.rows as Record<string, unknown>[];
      },
      async close() {
        await client.end();
      },
    };
  };
}

/** A database password: the 64 lowercase hexadecimal characters of 32 bytes from the deployment's key store. */
const DATABASE_PASSWORD = /^[0-9a-f]{64}$/;

/** The password of a database role made from 32 key-store bytes; the caller zeroes its bytes. */
export function databasePassword(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new PlatformError('数据库口令必须来自 32 字节的密钥');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function assertDatabasePassword(password: string): void {
  // Never echo the value: a near miss may be a real password.
  if (typeof password !== 'string' || !DATABASE_PASSWORD.test(password)) throw new PlatformError('数据库口令格式不对（要 64 个小写十六进制字符）');
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`,
 * RFC 5802 and 7677). CREATE ROLE ... PASSWORD '<verifier>' stores it as it is, so the plaintext never reaches the server,
 * its statement log or its statistics. Hexadecimal passwords need no SASLprep.
 */
export function scramVerifier(password: string, salt: Uint8Array = randomBytes(16), iterations = 4096): string {
  assertDatabasePassword(password);
  if (!Number.isSafeInteger(iterations) || iterations < 4096) throw new PlatformError('SCRAM 迭代次数至少 4096');
  if (salt.length < 16) throw new PlatformError('SCRAM 盐至少 16 字节');
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${Buffer.from(salt).toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** StoredKey and ServerKey of RFC 5802 for SCRAM-SHA-256 (the client key and salted password are zeroed). */
export function scramKeys(password: string, salt: Uint8Array, iterations: number): { storedKey: Buffer; serverKey: Buffer } {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  try {
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();
    clientKey.fill(0);
    return { storedKey, serverKey: createHmac('sha256', salted).update('Server Key').digest() };
  } finally {
    salted.fill(0);
  }
}

/** A role of a loopback-scram cluster: 127.0.0.1 (LOOPBACK_HOST in postgres.ts), its port, and its password on demand. */
export interface LoopbackTarget {
  port: number;
  user: string;
  /** Read at every connect from the key store; never an environment value or a password file. */
  password: () => Promise<string>;
}

/** sessionConfig for a loopback-scram cluster: TCP to 127.0.0.1, the role's password, nothing from PG* or ~/.pgpass. */
export function loopbackSessionConfig(target: LoopbackTarget, database: string): pg.ClientConfig & { replication: string } {
  return {
    host: '127.0.0.1',
    port: target.port,
    user: target.user,
    password: async () => {
      const password = await target.password();
      assertDatabasePassword(password);
      return password;
    },
    database,
    ssl: false,
    sslnegotiation: 'postgres',
    replication: 'false',
    options: SESSION_OPTIONS,
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 10_000,
    application_name: 'circle-hub-platform',
  };
}

export function loopbackConnector(target: LoopbackTarget): SqlConnector {
  return async (database) => {
    const client = new pg.Client(loopbackSessionConfig(target, database));
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => {});
      const code = (error as { code?: unknown }).code;
      throw Object.assign(new PlatformError(`连不上数据库 ${database}（127.0.0.1:${target.port}，角色 ${target.user}）：${(error as Error).message}`), typeof code === 'string' ? { code } : {});
    }
    return {
      async query(text, values) {
        const result = await client.query(text, values);
        return result.rows as Record<string, unknown>[];
      },
      async close() {
        await client.end();
      },
    };
  };
}

/**
 * A port that answers proves nothing: the cluster on it must be this deployment's. Run as the superuser role, which may
 * read data_directory; Windows compares without regard to case or separator.
 */
export async function assertClusterDirectory(session: SqlSession, expected: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const [row] = await session.query('SHOW data_directory');
  const actual = String(row?.data_directory ?? '');
  const normal = (path: string) => (platform === 'win32' ? path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase() : path.replace(/\/+$/, ''));
  if (actual === '' || normal(actual) !== normal(expected)) {
    throw new PlatformError(`端口上的 PostgreSQL 不是这个数据根的集群（数据目录 ${actual || '未知'}，应为 ${expected}）`, '检查部署设置里的数据库端口，或停掉占用这个端口的其他 PostgreSQL');
  }
}

export async function withSession<T>(connector: SqlConnector, database: string, fn: (session: SqlSession) => Promise<T>): Promise<T> {
  const session = await connector(database);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface TableSummary {
  schema: string;
  table: string;
  rows: number;
  /** See TABLE_DIGEST: independent of physical row order, bounded in memory for any table size. */
  digest: string;
}

/**
 * Definition of a table digest (backup manifests from circle-hub-backup@2 on). h = SHA-256 hex of the row's text ROW(t.*)::text
 * (immune to a column named like the alias) under the pinned rendering settings; rows go into 4096 buckets by the first
 * three hex digits of h; a bucket's digest is SHA-256 of its sorted h concatenated; the table's digest is SHA-256 of
 * the lines `<bucket> <rows> <bucket digest>\n` in bucket order. Each aggregate holds at most one bucket's hashes, so
 * the 1 GB limit of a PostgreSQL string is reached only past about 68 billion rows.
 */
export const TABLE_DIGEST = 'row-sha256-bucket3@1';
export const DIGEST_BUCKET_DIGITS = 3;

// Row text depends on these settings; pin them so a dump and its restore render rows identically.
const RENDERING = [
  "SET TimeZone TO 'UTC'",
  "SET DateStyle TO 'ISO, YMD'",
  "SET IntervalStyle TO 'postgres'",
  'SET extra_float_digits TO 1',
  "SET bytea_output TO 'hex'",
];

/** Row count and digest of every ordinary table outside the system schemas. Run it inside the snapshot being compared. */
export async function summarizeTables(session: SqlSession): Promise<TableSummary[]> {
  for (const statement of RENDERING) await session.query(statement);
  const tables = await session.query(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1, 2`,
  );
  const out: TableSummary[] = [];
  for (const row of tables) {
    const schema = String(row.schema);
    const table = String(row.name);
    const [summary] = await session.query(
      `SELECT coalesce(sum(b.n), 0)::text AS rows,
              encode(sha256(convert_to(coalesce(string_agg(b.k || ' ' || b.n || ' ' || b.d || E'\\n', '' ORDER BY b.k COLLATE "C"), ''), 'UTF8')), 'hex') AS digest
         FROM (SELECT left(s.h, ${DIGEST_BUCKET_DIGITS}) AS k, count(*) AS n,
                      encode(sha256(convert_to(string_agg(s.h, '' ORDER BY s.h COLLATE "C"), 'UTF8')), 'hex') AS d
                 FROM (SELECT encode(sha256(convert_to(ROW(t.*)::text, 'UTF8')), 'hex') AS h
                         FROM ONLY ${quoteIdentifier(schema)}.${quoteIdentifier(table)} AS t) AS s
                GROUP BY 1) AS b`,
    );
    out.push({ schema, table, rows: Number(summary?.rows ?? 0), digest: String(summary?.digest ?? '') });
  }
  return out;
}

/** Differences between two table summaries, in Chinese, empty when they agree. */
export function compareSummaries(expected: readonly TableSummary[], actual: readonly TableSummary[]): string[] {
  const key = (t: TableSummary) => `${t.schema}.${t.table}`;
  const found = new Map(actual.map((t) => [key(t), t]));
  const out: string[] = [];
  for (const want of expected) {
    const got = found.get(key(want));
    if (!got) out.push(`缺少表 ${key(want)}`);
    else if (got.rows !== want.rows) out.push(`表 ${key(want)} 行数 ${got.rows}，应为 ${want.rows}`);
    else if (got.digest !== want.digest) out.push(`表 ${key(want)} 内容摘要不同`);
    found.delete(key(want));
  }
  for (const extra of found.keys()) out.push(`多出表 ${extra}`);
  return out;
}
