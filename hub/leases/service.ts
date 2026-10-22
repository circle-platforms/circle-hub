// The lease service (D04 R[0], core step C2). One row per key in the `leases` table: the unique constraint makes
// acquisition atomic (two acquirers of one key cannot both win), an expired or released row is taken over in place
// with the fencing token incremented, and expiry is always decided by the database clock (SQL now()), never by the
// process clock. Every change appends its lease action record (B05, action kind `lease`) in the same transaction.
// The vocabulary stays neutral: keys are strings under a prefix; this module names no device, bench or product.
import { randomUUID } from 'node:crypto';
import type { Database, PgTransaction } from '../records/db.ts';
import type { ActionBody } from '../records/api.ts';
import { RECORD_SCHEMAS } from '../records/constants.ts';
import { recordDigest } from '../records/digest.ts';
import { LeaseDetail } from '../../contracts/src/records.ts';

/** The holder of a lease: the user and the run (a lease is held by a run, D04 R[0]). */
export interface Holder {
  user: string;
  run: string;
}

export type AcquireOutcome =
  | {
      ok: true;
      lease: string;
      keys: string[];
      until: string;
      /** The fencing token after this operation: monotonic per key row, 1 on a fresh acquire. */
      token: number;
    }
  | { ok: false; code: 'LEASE_UNAVAILABLE' | 'LEASE_PREFIX' | 'LEASE_TTL' | 'LEASE_EXPIRED'; message: string; earliestFree?: string };

export type ChangeOutcome =
  | { ok: true; lease: string; until: string; token: number }
  | { ok: false; code: 'LEASE_UNAVAILABLE' | 'LEASE_EXPIRED' | 'LEASE_TTL'; message: string };

export interface LeaseRow {
  key: string;
  lease: string;
  until: string;
  token: number;
}

export interface ServiceOptions {
  /** The clock the service itself reads (never Date.now of the process); default: the database clock. */
  now?: () => Promise<Date>;
}

const KEY = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const ALPHABET = '0123456789abcdefghjkmnpqrstv'; // Crockford base32, 32 characters, no i, l, o, u
const RUN = /^run_[0-9a-z]{26}$/;
const USER = /^usr_[0-9a-z]{26}$/;

const newId = (): string => {
  let out = '';
  for (let i = 0; i < 26; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
};

const newLeaseId = (): string => `lse_${newId()}`;


/** A refusal thrown inside the transaction so the whole acquire rolls back (all or nothing). */
class RefusedLease extends Error {
  readonly outcome: { ok: false; code: string; message: string; earliestFree?: string };
  constructor(outcome: { ok: false; code: string; message: string; earliestFree?: string }) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

/** A lease service over one database; state lives in the table only, so a new object sees the same state. */
export class LeaseService {
  readonly #db: Database;
  readonly #now: () => Promise<Date>;

  constructor(db: Database, options: ServiceOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (async () => (await db.query<{ now: Date }>('SELECT now()::timestamptz AS now')).rows[0]!.now);
  }

  /** Acquires every key under one lease (all or nothing) for the holder; refusal carries the earliest free moment. */
  async acquire(input: { keys: string[]; ttlSeconds: number; holder: Holder; prefix: string; maxTtlSeconds: number }): Promise<AcquireOutcome> {
    const problems = this.#validate(input.keys, input.prefix, input.ttlSeconds, input.maxTtlSeconds);
    if (problems !== null) return problems;
    return this.#db.transaction(async (tx) => {
      try {
      const now = await this.#nowIn();
      const until = new Date(now.getTime() + input.ttlSeconds * 1000);
      const lease = newLeaseId();
      const rows: Array<{ key: string; token: number }> = [];
      // Take over expired or released rows in place first (atomic per key), then insert the rest.
      for (const key of input.keys) {
        const taken = await this.#db.query<{ token: bigint }>(
          `UPDATE leases SET lease_id = $2, run_id = $3, user_id = $4, token = token + 1, acquired_at = $6, expires_at = $5, released_at = NULL
           WHERE key = $1 AND (expires_at <= $6 OR released_at IS NOT NULL) RETURNING token`,
          [key, lease, input.holder.run, input.holder.user, until, now],
          tx,
        );
        if (taken.rows.length > 0) {
          rows.push({ key, token: Number(taken.rows[0].token) });
          continue;
        }
        // ON CONFLICT DO NOTHING keeps the transaction usable after a lost race (an aborted transaction cannot
        // even read the busy row for the earliest-free moment); the loser reads the row it collided with.
        const inserted = await this.#db.query<{ token: bigint }>(
          `INSERT INTO leases (key, lease_id, run_id, user_id, token, acquired_at, expires_at, released_at)
           VALUES ($1, $2, $3, $4, 1, $6, $5, NULL)
           ON CONFLICT (key) DO NOTHING RETURNING token`,
          [key, lease, input.holder.run, input.holder.user, until, now],
          tx,
        );
        if (inserted.rows.length === 0) {
          const busy = await this.#earliestFree(key, tx);
          throw new RefusedLease({ ok: false, code: 'LEASE_UNAVAILABLE', message: `键 ${key} 上有未到期的占用`, ...(busy === null ? {} : { earliestFree: busy }) });
        }
        rows.push({ key, token: Number(inserted.rows[0].token) });
      }
      const token = Math.max(...rows.map((r) => r.token));
      await this.#appendAction(tx, 'acquire', lease, input.keys, input.holder, until.toISOString(), token);
      const granted: AcquireOutcome = { ok: true, lease, keys: input.keys, until: until.toISOString(), token };
      return granted;
      } catch (error) {
        throw error; // a refusal aborts the transaction: the rows taken over or inserted so far vanish
      }
    }).catch((error: unknown) => {
      if (error instanceof RefusedLease) return error.outcome as AcquireOutcome;
      throw error;
    });
  }

  /** Extends the lease of every key for its holder by ttlSeconds from `at`, inside the cumulative cap. */
  async extend(input: { keys: string[]; holder: Holder; ttlSeconds: number; at: string; maxTtlSeconds?: number }): Promise<ChangeOutcome> {
    return this.#db.transaction(async (tx) => {
      const at = new Date(input.at);
      const rows = await this.#rowsOf(input.keys, tx);
      const held = rows.find((row) => row.run_id !== input.holder.run);
      if (held !== undefined) return { ok: false, code: 'LEASE_UNAVAILABLE', message: `键 ${held.key} 由别的运行持有` };
      const expiredRow = rows.find((row) => row.expires_at.getTime() <= at.getTime());
      if (expiredRow !== undefined) return { ok: false, code: 'LEASE_EXPIRED', message: `键 ${expiredRow.key} 的租约已过到期时刻` };
      const capMs = rows.reduce((max, row) => Math.max(max, row.acquired_at.getTime()), 0) + (input.maxTtlSeconds ?? 2_592_000) * 1000;
      const until = new Date(at.getTime() + input.ttlSeconds * 1000);
      if (until.getTime() > capMs) return { ok: false, code: 'LEASE_TTL', message: '续期超过累计上限' };
      const lease = rows[0]!.lease_id;
      const token = rows.reduce((max, row) => Math.max(max, Number(row.token)), 0) + 1;
      for (const key of input.keys) {
        await this.#db.query(
          `UPDATE leases SET expires_at = $2, token = token + 1 WHERE key = $1 AND run_id = $3 AND expires_at > $4`,
          [key, until, input.holder.run, at],
          tx,
        );
      }
      await this.#appendAction(tx, 'extend', lease, input.keys, input.holder, until.toISOString(), token);
      return { ok: true, lease, until: until.toISOString(), token };
    });
  }

  /** Releases the keys for their holder (D04 R[0]: delivery, cancel or expiry). */
  async release(input: { keys: string[]; holder: Holder }): Promise<ChangeOutcome> {
    return this.#db.transaction(async (tx) => {
      const rows = await this.#rowsOf(input.keys, tx);
      const held = rows.find((row) => row.run_id !== input.holder.run);
      if (held !== undefined) return { ok: false, code: 'LEASE_UNAVAILABLE', message: `键 ${held.key} 由别的运行持有` };
      const lease = rows[0]!.lease_id;
      const token = rows.reduce((max, row) => Math.max(max, Number(row.token)), 0) + 1;
      const until = rows[0]!.expires_at.toISOString();
      for (const key of input.keys) {
        await this.#db.query(`UPDATE leases SET released_at = now(), token = token + 1 WHERE key = $1 AND run_id = $2`, [key, input.holder.run], tx);
      }
      await this.#appendAction(tx, 'release', lease, input.keys, input.holder, until, token);
      return { ok: true, lease, until, token };
    });
  }

  /** An admin frees keys regardless of the holder, with a reason that lands in the action record. */
  async forceRelease(input: { keys: string[]; by: string; reason: string }): Promise<ChangeOutcome> {
    return this.#db.transaction(async (tx) => {
      const rows = await this.#rowsOf(input.keys, tx);
      const lease = rows[0]?.lease_id ?? '';
      const token = rows.reduce((max, row) => Math.max(max, Number(row.token)), 0) + 1;
      const holder: Holder = { user: rows[0]?.user_id ?? '', run: rows[0]?.run_id ?? '' };
      const until = rows[0]?.expires_at.toISOString() ?? new Date(0).toISOString();
      for (const key of input.keys) {
        await this.#db.query(`UPDATE leases SET released_at = now(), token = token + 1 WHERE key = $1`, [key], tx);
      }
      await this.#appendAction(tx, 'force_release', lease, input.keys, holder, until, token, { by: input.by, reason: input.reason });
      return { ok: true, lease, until, token };
    });
  }

  /** The unexpired, unreleased rows under a prefix, for the run context (no tokens, no holders). */
  async view(prefix: string): Promise<{ entries: Array<{ key: string; until: string }> }> {
    const rows = await this.#db.query<{ key: string; expires_at: Date }>(
      `SELECT key, expires_at FROM leases WHERE key LIKE $1 AND released_at IS NULL AND expires_at > $2 ORDER BY key`,
      [`${prefix}%`, await this.#now()],
    );
    return { entries: rows.rows.map((row) => ({ key: row.key, until: row.expires_at.toISOString() })) };
  }

  /** Frees rows whose run record no longer exists and that were acquired over 60 seconds ago; returns how many. */
  async reclaimOrphans(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const rows = await this.#db.query<{ key: string; lease_id: string; run_id: string; user_id: string; token: bigint; expires_at: Date }>(
        `SELECT key, lease_id, run_id, user_id, token, expires_at FROM leases
         WHERE released_at IS NULL AND expires_at > $1 AND acquired_at < $1 - interval '60 seconds'
           AND NOT EXISTS (SELECT 1 FROM records r WHERE r.kind = 'run' AND ((r.body)::jsonb ->> 'run') = leases.run_id)`,
        [await this.#now()],
        tx,
      );
      let reclaimed = 0;
      for (const row of rows.rows) {
        await this.#db.query(`UPDATE leases SET released_at = now(), token = token + 1 WHERE key = $1`, [row.key], tx);
        await this.#appendAction(tx, 'take_over', row.lease_id, [row.key], { user: row.user_id, run: row.run_id }, row.expires_at.toISOString(), Number(row.token) + 1, { reason: '孤儿回收：行引用的运行不存在' });
        reclaimed++;
      }
      return reclaimed;
    });
  }

  /** The lease action records of a prefix, oldest first (the audit line B05 keeps). */
  async actionLog(prefix: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.#db.query<{ body: string }>(
      `SELECT body FROM records WHERE kind = 'action' AND schema = 'action@1' AND ((body)::jsonb -> 'detail' ->> 'op') IS NOT NULL ORDER BY seq`,
      [],
    );
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows.rows) {
      const body = JSON.parse(row.body) as { action?: string; detail?: Record<string, unknown> };
      if (body.action !== 'lease') continue;
      const keys = (body.detail?.keys as string[] | undefined) ?? [];
      if (!keys.some((key) => key.startsWith(prefix))) continue;
      out.push({ op: body.detail?.op, keys, lease: body.detail?.lease, until: body.detail?.until, token: body.detail?.token });
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  #validate(keys: string[], prefix: string, ttlSeconds: number, maxTtlSeconds: number): { ok: false; code: 'LEASE_PREFIX' | 'LEASE_TTL'; message: string } | null {
    if (!keys.every((key) => KEY.test(key) && key.startsWith(prefix))) {
      return { ok: false, code: 'LEASE_PREFIX', message: `键不在声明的前缀 ${prefix} 下` };
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > maxTtlSeconds) {
      return { ok: false, code: 'LEASE_TTL', message: `期限要在 1 到 ${maxTtlSeconds} 秒之间` };
    }
    return null;
  }

  async #nowIn(): Promise<Date> {
    return this.#now();
  }

  async #rowsOf(keys: string[], tx: PgTransaction): Promise<Array<{ key: string; lease_id: string; run_id: string; user_id: string; token: bigint; acquired_at: Date; expires_at: Date }>> {
    const rows = await this.#db.query<{ key: string; lease_id: string; run_id: string; user_id: string; token: bigint; acquired_at: Date; expires_at: Date }>(
      `SELECT key, lease_id, run_id, user_id, token, acquired_at, expires_at FROM leases WHERE key = ANY($1)`,
      [keys],
      tx,
    );
    return rows.rows;
  }

  async #earliestFree(key: string, tx: PgTransaction): Promise<string | null> {
    const row = await this.#db.query<{ expires_at: Date }>(`SELECT expires_at FROM leases WHERE key = $1 AND released_at IS NULL`, [key], tx);
    return row.rows[0]?.expires_at.toISOString() ?? null;
  }

  async #appendAction(tx: PgTransaction, op: 'acquire' | 'extend' | 'release' | 'force_release' | 'take_over', lease: string, keys: string[], holder: Holder, until: string, token: number, extra: Record<string, unknown> = {}): Promise<void> {
    const detail = LeaseDetail.parse({ op, lease, keys, holder, until, token });
    const body: ActionBody = {
      action: 'lease',
      run: holder.run,
      item: null,
      inputs: keys,
      component: 'leases@1',
      lease: { lease, fencing: token },
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: { ...(detail as unknown as Record<string, unknown>), ...extra },
    };
    const createdAt = new Date().toISOString();
    const id = `rcd_${newId()}`;
    const digest = recordDigest({ kind: 'action', schema: RECORD_SCHEMAS.action, provenance: 'observed', created_at: createdAt, body });
    const bodyText = JSON.stringify(body);
    await this.#db.query(
      `INSERT INTO records (id, digest, kind, schema, provenance, created_at, body, size) VALUES ($1, $2, 'action', $3, 'observed', $4, $5, $6)`,
      [id, digest, RECORD_SCHEMAS.action, createdAt, bodyText, bodyText.length],
      tx,
    );
  }
}

