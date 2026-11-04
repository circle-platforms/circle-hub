// PostgreSQL access over pg: one pool, explicit transactions and the opaque Transaction handle other packages pass back in.
import pg from 'pg';
import type { DatabaseConfig } from '../config/index.ts';
import { recordQuery, tracing } from '../telemetry/usage.ts';
import type { Transaction } from './api.ts';
import { RecordsError } from './errors.ts';

export type Row = Record<string, unknown>;

export class PgTransaction implements Transaction {
  readonly transactionId: number;
  readonly client: pg.PoolClient;
  finished = false;
  constructor(client: pg.PoolClient, transactionId: number) {
    this.client = client;
    this.transactionId = transactionId;
  }
}

/** Connections any pool of this process failed to open, and live connections that failed while idle. */
let connectionFailures = 0;

/** What a pool holds now, and the failures of this process; read by the Hub's resource sampling (hub/health). */
export interface PoolStats {
  /** The most connections it may hold. */
  limit: number;
  total: number;
  idle: number;
  waiting: number;
  connectionFailures: number;
}

type ConnectCallback = ((error: Error) => void) | ((error: null, client: pg.Client) => void);

/** pg.Pool has no event for a connection it could not open; it reports that only to the caller who was waiting. */
class CountedClient extends pg.Client {
  override connect(): Promise<pg.Client>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.Client> | void {
    if (callback === undefined) {
      return super.connect().catch((error: unknown) => {
        connectionFailures += 1;
        throw error;
      });
    }
    super.connect((error: Error | null) => {
      if (error) connectionFailures += 1;
      (callback as (error: Error | null) => void)(error);
    });
  }
}

/**
 * Every connection parameter is explicit so pg never falls back to PG* environment variables, and the password is a
 * function so pg never reads a password file: a server that asks for a password without one configured fails clearly.
 */
export function createPool(config: DatabaseConfig, max = 10): pg.Pool {
  const password = config.password;
  const pool = new pg.Pool({
    Client: CountedClient as unknown as pg.PoolConfig['Client'],
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: async () => {
      if (password === undefined) throw new RecordsError('数据库要求密码，但没有配置密码；密码只经密钥库提供，不从环境变量或密码文件读取');
      return password;
    },
    ssl: false,
    application_name: 'circle-hub',
    client_encoding: 'UTF8',
    options: '-c TimeZone=UTC',
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client that fails is dropped by the pool; the next query reports the failure to its caller.
  pool.on('error', () => {
    connectionFailures += 1;
  });
  return pool;
}

/** `client.query`, with the usage of the current step when there is one (`waitMs`: what getting the connection took). */
async function measured<R extends Row>(client: pg.PoolClient, text: string, values: readonly unknown[], waitMs = 0): Promise<pg.QueryResult<R>> {
  if (!tracing()) return client.query<R>(text, values as unknown[]);
  const started = performance.now();
  let rows: readonly R[] | undefined;
  try {
    const result = await client.query<R>(text, values as unknown[]);
    rows = result.rows;
    return result;
  } finally {
    recordQuery(text, rows, performance.now() - started, waitMs);
  }
}

export class Database {
  readonly pool: pg.Pool;
  #nextTransaction = 1;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async query<R extends Row = Row>(text: string, values: readonly unknown[] = [], tx?: Transaction): Promise<pg.QueryResult<R>> {
    if (tx !== undefined) return measured<R>(clientOf(tx), text, values);
    if (!tracing()) return this.pool.query<R>(text, values as unknown[]);
    return this.#pooled<R>(text, values);
  }

  /**
   * pool.query with the wait for a connection seen apart from the query: the same rule, a connection is dropped when its
   * query fails or it reports an error while it is out of the pool.
   */
  async #pooled<R extends Row>(text: string, values: readonly unknown[]): Promise<pg.QueryResult<R>> {
    const asked = performance.now();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      recordQuery(text, undefined, 0, performance.now() - asked);
      throw error;
    }
    const waited = performance.now() - asked;
    let failure: Error | undefined;
    const lost = (error: Error): void => {
      failure ??= error;
    };
    client.once('error', lost);
    try {
      return await measured<R>(client, text, values, waited);
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error('query failed');
      throw error;
    } finally {
      client.removeListener('error', lost);
      client.release(failure);
    }
  }

  /** Runs `fn` inside BEGIN/COMMIT; rolls back on any error. With `outer`, runs inside that transaction instead. */
  async transaction<T>(fn: (tx: PgTransaction) => Promise<T>, outer?: Transaction): Promise<T> {
    if (outer !== undefined) {
      clientOf(outer);
      return fn(outer as PgTransaction);
    }
    const asked = performance.now();
    const client = await this.pool.connect();
    const tx = new PgTransaction(client, this.#nextTransaction++);
    let broken: Error | undefined;
    try {
      await measured(client, 'BEGIN', [], performance.now() - asked);
      const result = await fn(tx);
      await measured(client, 'COMMIT', []);
      return result;
    } catch (error) {
      try {
        await measured(client, 'ROLLBACK', []);
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
      }
      throw error;
    } finally {
      tx.finished = true;
      client.release(broken);
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  stats(): PoolStats {
    return { limit: this.pool.options.max, total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, connectionFailures };
  }
}

export function clientOf(tx: Transaction): pg.PoolClient {
  if (!(tx instanceof PgTransaction)) throw new TypeError('not a records transaction');
  if (tx.finished) throw new TypeError('the transaction has already finished');
  return tx.client;
}

/** ISO 8601 UTC with milliseconds, as stored. */
export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('not a timestamp');
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** Four-digit years only: timestamptz refuses the extended forms toISOString writes for years above 9999 or below 1. */
const STORED_TIME = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/** Accepts a Date or an exact `toISOString` string with a year from 0001 to 9999 and returns the string; anything else is refused. */
export function normalizeTime(value: Date | string, field: string): string {
  let text: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${field} is not a valid time`);
    text = value.toISOString();
  } else {
    text = value;
  }
  const parsed = typeof text === 'string' ? new Date(text) : new Date(Number.NaN);
  if (typeof text !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text || !STORED_TIME.test(text)) {
    throw new TypeError(`${field} must be ISO 8601 UTC with milliseconds and a year from 0001 to 9999, for example 2026-10-21T08:00:00.000Z`);
  }
  return text;
}

/** Largest value of a bigint column (the insertion sequence numbers). */
const MAX_SEQ = 9_223_372_036_854_775_807n;

/** Opaque page cursor over an insertion sequence number. */
export function encodeCursor(seq: string | number | bigint): string {
  return Buffer.from(`seq:${String(seq)}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): string | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const text = typeof cursor === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const match = /^seq:([0-9]{1,19})$/.exec(text);
  if (match === null || BigInt(match[1]) > MAX_SEQ) throw new RecordsError('继续令牌无效，请从第一页重新读取');
  return match[1];
}

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be an integer from 1 to 500');
  return limit;
}
