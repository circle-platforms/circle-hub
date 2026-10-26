// SQL over the cluster's unix socket, and per-table row counts and digests used to prove a restore complete.
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
