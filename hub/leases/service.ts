// The lease service (D04 R[0], core step C2). One row per key in the `leases` table: the unique constraint makes
// acquisition atomic (two acquirers of one key cannot both win), an expired or released row is taken over in place
// with the fencing token incremented, and one clock decides expiry everywhere (the service's `now`: the database
// clock by default, injectable for tests — a caller never brings its own moment). Every change appends its lease
// action record (B05, action kind `lease`) in the same transaction. Keys are sorted before they are touched, so two
// acquires of the same key set in opposite orders cannot deadlock. The vocabulary stays neutral: keys are strings
// under a prefix; this module names no device, bench or product.
import { isId, newId } from '../records/ids.ts';
import { createRecordStore, type RecordStore, type ActionBody, type Page, type StoredRecord } from '../records/api.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { RECORD_SCHEMAS } from '../records/constants.ts';
import type { Database, PgTransaction } from '../records/db.ts';
import type { LeaseOp } from '../../contracts/generated/vocabulary.ts';
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
  | { ok: false; code: 'LEASE_UNAVAILABLE' | 'LEASE_EXPIRED' | 'LEASE_TTL' | 'LEASE_NO_ROW'; message: string };

/** Read-only current row for trusted callers enforcing fences. Never sent to a model or client. */
export interface HolderSnapshot {
  key: string;
  lease: string;
  fencing: number;
  user: string;
  run: string;
  released: boolean;
  expires_at: string;
}

export interface ServiceOptions {
  /** The clock the service reads (never Date.now of the process); default: the database clock. */
  now?: () => Promise<Date>;
  /** The configured records store, sharing the lease transaction; defaults to the standard record limit. */
  records?: RecordStore;
}

const KEY = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;

/** A refusal thrown inside the transaction so the whole acquire rolls back (all or nothing). */
class RefusedLease extends Error {
  readonly outcome: { ok: false; code: string; message: string; earliestFree?: string };
  constructor(outcome: { ok: false; code: string; message: string; earliestFree?: string }) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

interface Row {
  key: string;
  lease_id: string;
  run_id: string;
  user_id: string;
  token: bigint;
  acquired_at: Date;
  expires_at: Date;
  released_at: Date | null;
  [column: string]: unknown;
}

/** A lease service over one database; state lives in the table only, so a new object sees the same state. */
export class LeaseService {
  readonly #db: Database;
  readonly #now: () => Promise<Date>;
  readonly #records: RecordStore;

  constructor(db: Database, options: ServiceOptions = {}) {
    this.#db = db;
    this.#records = options.records ?? createRecordStore(db, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
    this.#now = options.now ?? (async () => (await db.query<{ now: Date }>('SELECT now()::timestamptz AS now')).rows[0]!.now);
  }

  /** Acquires every key under one lease (all or nothing) for the holder; refusal carries the earliest free moment. */
  async acquire(input: { keys: string[]; ttlSeconds: number; holder: Holder; prefix: string; maxTtlSeconds: number }): Promise<AcquireOutcome> {
    // The holder's ids are real ids (the action record's LeaseDetail demands them).
    if (!isId('usr', input.holder.user) || !isId('run', input.holder.run)) {
      return { ok: false, code: 'LEASE_UNAVAILABLE', message: '持有者要写成真实的用户号和运行号' };
    }
    const problems = this.#validate(input.keys, input.prefix, input.ttlSeconds, input.maxTtlSeconds);
    if (problems !== null) return problems;
    // One order for everyone: two acquires of the same key set, given in opposite orders, cannot deadlock.
    const keys = [...input.keys].sort();
    return this.#db
      .transaction(async (tx) => {
        const now = await this.#nowIn(tx);
        const until = new Date(now.getTime() + input.ttlSeconds * 1000);
        const lease = newId('lse');
        const rows: Array<{ key: string; token: number }> = [];
        for (const key of keys) {
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
          // ON CONFLICT DO NOTHING keeps the transaction usable after a lost race (an errored-out transaction can
          // run no further statement); the loser reads the row it collided with for the earliest-free moment.
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
        await this.#appendAction(tx, 'acquire', lease, keys, input.holder, until.toISOString(), token);
        const granted: AcquireOutcome = { ok: true, lease, keys, until: until.toISOString(), token };
        return granted;
      })
      .catch((error: unknown): AcquireOutcome => {
        if (error instanceof RefusedLease) return error.outcome as AcquireOutcome;
        throw error;
      });
  }

  /** Extends the lease of every key for its holder by ttlSeconds from the service's own clock, inside the cumulative cap. */
  async extend(input: { keys: string[]; holder: Holder; ttlSeconds: number; maxTtlSeconds?: number }): Promise<ChangeOutcome> {
    return this.#change(input.keys, input.holder, 'extend', input.ttlSeconds, input.maxTtlSeconds);
  }

  /** Releases the keys for their holder (D04 R[0]: delivery, cancel or expiry). */
  async release(input: { keys: string[]; holder: Holder }): Promise<ChangeOutcome> {
    return this.#change(input.keys, input.holder, 'release', 0, undefined);
  }

  /** An admin frees keys regardless of the holder, with a reason that lands in the action record. */
  async forceRelease(input: { keys: string[]; by: string; reason: string }): Promise<ChangeOutcome> {
    return this.#db.transaction(async (tx) => {
      // Rows are read FOR UPDATE so a concurrent extend of the same key waits, and every row is present.
      const rows = await this.#rowsLocked(input.keys, tx);
      // Only a row that still holds (unreleased, unexpired) may be force-released; a released or expired one answers
      // LEASE_NO_ROW, so a repeated release cannot succeed and cannot mint an action record.
      const now = await this.#nowIn(tx);
      const holding = rows.filter((row) => row.released_at === null && row.expires_at.getTime() > now.getTime());
      if (holding.length === 0) return { ok: false, code: 'LEASE_NO_ROW', message: '这些键上没有租约行' };
      const lease = holding[0]!.lease_id;
      const holder: Holder = { user: holding[0]!.user_id, run: holding[0]!.run_id };
      const token = holding.reduce((max, row) => Math.max(max, Number(row.token)), 0) + 1;
      const until = holding[0]!.expires_at.toISOString();
      for (const key of input.keys) {
        await this.#db.query(`UPDATE leases SET released_at = $2, token = token + 1 WHERE key = $1 AND released_at IS NULL`, [key, now], tx);
      }
      await this.#appendAction(tx, 'force_release', lease, input.keys, holder, until, token, { by: input.by, reason: input.reason });
      return { ok: true, lease, until, token };
    });
  }

  /** The rows of the given keys as they stand (holder user and run, released, expiry), for the lineage check of
   * extend and release (the caller decides whether this run's user and lineage hold them). */
  async holders(keys: string[]): Promise<Array<{ key: string; user: string; run: string; released: boolean; expires_at: string }>> {
    const rows = await this.#db.query<Row & { released_at: Date | null }>(
      `SELECT key, user_id, run_id, expires_at, released_at FROM leases WHERE key = ANY($1)`,
      [[...keys].sort()],
    );
    return rows.rows.map((row) => ({ key: row.key, user: row.user_id, run: row.run_id, released: row.released_at !== null, expires_at: row.expires_at.toISOString() }));
  }

  async holderSnapshot(keys: readonly string[]): Promise<HolderSnapshot[]> {
    const rows = await this.#db.query<Row>('SELECT key, lease_id, token, user_id, run_id, expires_at, released_at FROM leases WHERE key = ANY($1) ORDER BY key', [[...new Set(keys)].sort()]);
    return rows.rows.map(row => {
      const fencing = Number(row.token);
      if (!Number.isSafeInteger(fencing) || fencing < 1) throw new Error('租约围栏不能安全表示，请管理员核对');
      return { key: row.key, lease: row.lease_id, fencing, user: row.user_id, run: row.run_id, released: row.released_at !== null, expires_at: row.expires_at.toISOString() };
    });
  }

  /** The unexpired, unreleased rows under a prefix, for the run context (no tokens, no holders). */
  async view(prefix: string): Promise<{ entries: Array<{ key: string; until: string }> }>;
  /** The same rows with the holder's run (an administrator's view; the run context never asks for it). */
  async view(prefix: string, withHolder: true): Promise<{ entries: Array<{ key: string; until: string; run: string }> }>;
  async view(prefix: string, withHolder?: boolean): Promise<{ entries: Array<{ key: string; until: string; run?: string }> }> {
    // starts_with, not LIKE: a key may hold '_' and '_' is a wildcard in LIKE.
    const rows = await this.#db.query<{ key: string; expires_at: Date; run_id: string }>(
      `SELECT key, expires_at, run_id FROM leases WHERE starts_with(key, $1) AND released_at IS NULL AND expires_at > $2 ORDER BY key`,
      [prefix, await this.#now()],
    );
    return {
      entries: rows.rows.map((row) => ({
        key: row.key,
        until: row.expires_at.toISOString(),
        ...(withHolder === true ? { run: row.run_id } : {}),
      })),
    };
  }

  /** Frees rows whose run record no longer exists and that were acquired over 60 seconds ago; returns how many. */
  async reclaimOrphans(): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const now = await this.#nowIn(tx);
      const rows = await this.#db.query<Row>(
        `SELECT key, lease_id, run_id, user_id, token, acquired_at, expires_at, released_at FROM leases
         WHERE released_at IS NULL AND expires_at > $1 AND acquired_at < $1 - interval '60 seconds'
           AND NOT EXISTS (SELECT 1 FROM records r WHERE r.kind = 'run' AND ((r.body)::jsonb ->> 'run') = leases.run_id)`,
        [now],
        tx,
      );
      let reclaimed = 0;
      for (const row of rows.rows) {
        await this.#db.query(`UPDATE leases SET released_at = $2, token = token + 1 WHERE key = $1`, [row.key, now], tx);
        await this.#appendAction(tx, 'take_over', row.lease_id, [row.key], { user: row.user_id, run: row.run_id }, row.expires_at.toISOString(), Number(row.token) + 1, { reason: '孤儿回收：行引用的运行不存在' });
        reclaimed++;
      }
      return reclaimed;
    });
  }

  /** The lease action records of a prefix, oldest first (the audit line B05 keeps). */
  async actionLog(prefix: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord<ActionBody>> = await this.#records.list<ActionBody>({ kind: 'action', limit: 500, ...(cursor ? { cursor } : {}) });
      for (const record of page.items) {
        const body = record.body;
        if (body.action !== 'lease') continue;
        const keys = (body.detail?.keys as string[] | undefined) ?? [];
        if (!keys.some(key => key.startsWith(prefix))) continue;
        out.push({ ...(record.integrity_note?{integrity_note:record.integrity_note}:{}),op: body.detail.op, keys, lease: body.detail.lease, until: body.detail.until, token: body.detail.token, reason: body.detail.reason ?? null });
      }
      cursor = page.next;
    } while (cursor);
    return out;
  }

  // ---------------------------------------------------------------- internals

  /** The shared body of extend and release: rows locked FOR UPDATE, every update must affect its row, and the
   * service's own clock decides (no caller-supplied moment: a caller could lie a lease young again). */
  async #change(keys: string[], holder: Holder, op: Extract<LeaseOp, 'extend' | 'release'>, ttlSeconds: number, maxTtlSeconds: number | undefined): Promise<ChangeOutcome> {
    const ordered = [...keys].sort();
    return this.#db.transaction(async (tx) => {
      const now = await this.#nowIn(tx);
      const rows = await this.#rowsLocked(ordered, tx);
      if (rows.length === 0) return { ok: false, code: 'LEASE_NO_ROW', message: `这些键上没有租约行` };
      if (rows.some((row) => row.run_id !== holder.run)) {
        return { ok: false, code: 'LEASE_UNAVAILABLE', message: `键 ${rows.find((row) => row.run_id !== holder.run)!.key} 由别的运行持有` };
      }
      if (rows.some((row) => row.expires_at.getTime() <= now.getTime())) {
        return { ok: false, code: 'LEASE_EXPIRED', message: `键 ${rows.find((row) => row.expires_at.getTime() <= now.getTime())!.key} 的租约已过到期时刻` };
      }
      if (rows.some((row) => row.released_at !== null)) {
        return { ok: false, code: 'LEASE_EXPIRED', message: `键 ${rows.find((row) => row.released_at !== null)!.key} 的租约已释放` };
      }
      const lease = rows[0]!.lease_id;
      const acquired = rows.reduce((max, row) => Math.max(max, row.acquired_at.getTime()), 0);
      let until = rows[0]!.expires_at.toISOString();
      let token = rows.reduce((max, row) => Math.max(max, Number(row.token)), 0);
      if (op === 'extend') {
        // Never shorten: the end moves to the later of the current end and now + ttl (a shorter ttl is a no-op on the
        // moment; the token still grows and the action is still written). The cumulative cap is unchanged.
        const next = new Date(now.getTime() + ttlSeconds * 1000);
        const capMs = acquired + (maxTtlSeconds ?? 2_592_000) * 1000;
        if (next.getTime() > capMs) return { ok: false, code: 'LEASE_TTL', message: '续期超过累计上限' };
        until = next.getTime() > Date.parse(until) ? next.toISOString() : until;
      }
      for (const key of ordered) {
        const changed = await this.#db.query(
          op === 'extend'
            ? `UPDATE leases SET expires_at = $2, token = token + 1 WHERE key = $1 AND run_id = $3 AND expires_at > $4 AND released_at IS NULL`
            : `UPDATE leases SET released_at = $2, token = token + 1 WHERE key = $1 AND run_id = $3 AND expires_at > $4 AND released_at IS NULL`,
          [key, op === 'extend' ? new Date(until) : now, holder.run, now],
          tx,
        );
        if (changed.rowCount !== 1) {
          // The row was taken over or released between the lock and the update: nothing is written, not even an action record.
          return { ok: false, code: op === 'extend' ? 'LEASE_EXPIRED' : 'LEASE_UNAVAILABLE', message: `键 ${key} 的租约已不在持有之下` };
        }
        token += 1;
      }
      await this.#appendAction(tx, op, lease, ordered, holder, until, token);
      return { ok: true, lease, until, token };
    });
  }

  #validate(keys: string[], prefix: string, ttlSeconds: number, maxTtlSeconds: number): { ok: false; code: 'LEASE_PREFIX' | 'LEASE_TTL'; message: string } | null {
    if (!keys.every((key) => KEY.test(key) && key.startsWith(prefix))) {
      return { ok: false, code: 'LEASE_PREFIX', message: `键不在声明的前缀 ${prefix} 下` };
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > maxTtlSeconds) {
      return { ok: false, code: 'LEASE_TTL', message: `期限要在 1 到 ${maxTtlSeconds} 秒之间` };
    }
    return null;
  }

  async #nowIn(tx: PgTransaction): Promise<Date> {
    return this.#now();
  }

  async #rowsLocked(keys: string[], tx: PgTransaction): Promise<Row[]> {
    const rows = await this.#db.query<Row>(
      `SELECT key, lease_id, run_id, user_id, token, acquired_at, expires_at, released_at FROM leases WHERE key = ANY($1) ORDER BY key FOR UPDATE`,
      [keys],
      tx,
    );
    return rows.rows;
  }

  async #earliestFree(key: string, tx: PgTransaction): Promise<string | null> {
    const row = await this.#db.query<{ expires_at: Date }>(`SELECT expires_at FROM leases WHERE key = $1 AND released_at IS NULL`, [key], tx);
    return row.rows[0]?.expires_at.toISOString() ?? null;
  }

  async #appendAction(tx: PgTransaction, op: LeaseOp, lease: string, keys: string[], holder: Holder, until: string, token: number, extra: Record<string, unknown> = {}): Promise<void> {
    const detail = LeaseDetail.parse({ op, lease, keys, holder, until, token });
    const startedAt = new Date().toISOString();
    const body: ActionBody = {
      action: 'lease',
      run: holder.run,
      item: null,
      inputs: keys,
      component: 'leases@1',
      lease: { lease, fencing: token },
      started_at: startedAt,
      ended_at: startedAt,
      result: 'completed',
      error_code: null,
      acceptance: null,
      codes: [],
      detail: { ...(detail as unknown as Record<string, unknown>), ...extra },
    };
    await this.#records.put<ActionBody>({ kind: 'action', schema: RECORD_SCHEMAS.action, provenance: 'observed', created_at: startedAt, body,
      index: [{ key: 'action.kind', value: 'lease' }, { key: 'action.run', value: holder.run }, { key: 'lease.id', value: lease }] }, tx);
  }
}
