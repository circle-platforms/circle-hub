import { RecordsError } from './errors.ts';
// Append-only record store over PostgreSQL. Bodies are stored as their RFC 8785 canonical text, so every value canonicalize
// accepts (JSON data with well-formed strings, U+0000 included, which PostgreSQL text and jsonb reject raw) is kept exactly;
// digests are re-verified on read. Input canonicalize refuses (a lone surrogate) is kept as an object instead (README).
import { noteNoncanonical, NONCANONICAL_EXPLANATION } from './integrity-notes.ts';
import { parseStrictJson } from './strict-json.ts';
export { recordIntegrityNotes, type RecordIntegrityNote } from './integrity-notes.ts';
import { SchemaId } from '../../contracts/src/common.ts';
import { RecordKindSchema } from '../../contracts/src/records.ts';
import { isProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { FindQuery, IndexedCursor, IndexedQuery, IndexedRecord, IndexEntry, ListQuery, Page, PutResult, RecordInput, RecordStore, StoredRecord, Transaction } from './api.ts';
import { canonicalize } from './canonical.ts';
import { decodeCursor, encodeCursor, iso, normalizeTime, pageLimit } from './db.ts';
import type { Database, Row } from './db.ts';
import { envelopeDigest, isSha256 } from './digest.ts';
import { IntegrityError, LimitError } from './errors.ts';
import { newId } from './ids.ts';

/** Dedicated two-key namespace for typed business identities, separate from all other records locks. */
const BUSINESS_LOCK_SPACE = 730_160;
/** Separate namespace for atomically binding a record to its unique business key. */
const UNIQUE_KEY_LOCK_SPACE = 730_161;
/** Session lock for one in-flight job observation. Released when the connection closes, including process death. */
const OBSERVATION_LOCK_SPACE = 730_162;

const INDEX_KEY = /^[a-z][a-z0-9_.-]{0,99}$/;
/** UTF-8 bytes of one index value; with the key and digest this stays well inside a btree index row (2704 bytes). */
export const MAX_INDEX_VALUE_BYTES = 1000;
const RECORD_ID = /^rcd_[0-9a-z]{26}$/;
const COLUMNS = 'seq, id, digest, kind, schema, provenance, created_at, body';

export interface StoreOptions {
  maxRecordBytes: number;
  now: () => Date;
}

export class PgRecordStore implements RecordStore {
  readonly #db: Database;
  readonly #options: StoreOptions;

  constructor(db: Database, options: StoreOptions) {
    this.#db = db;
    this.#options = options;
  }

  async put<B>(input: RecordInput<B>, tx?: Transaction): Promise<PutResult<B>> {
    const kind = RecordKindSchema.safeParse(input.kind);
    if (!kind.success) throw new TypeError(`unknown record kind ${JSON.stringify(input.kind)}`);
    if (!SchemaId.safeParse(input.schema).success) throw new TypeError('schema must be name@major (contracts SchemaId)');
    if (!isProvenanceType(input.provenance)) throw new TypeError(`unknown provenance type ${JSON.stringify(input.provenance)}`);
    const createdAt = normalizeTime(input.created_at ?? this.#options.now(), 'created_at');
    const body = canonicalize(input.body);
    const size = Buffer.byteLength(body, 'utf8');
    if (size > this.#options.maxRecordBytes) {
      throw new LimitError(`记录正文 ${size} 字节，超过上限 ${this.#options.maxRecordBytes} 字节`, {
        detail: { size, limit: this.#options.maxRecordBytes, kind: kind.data },
      });
    }
    const index = validateIndex(input.index ?? []);
    if (input.unique_key !== undefined) validateUniqueKey(input.unique_key);
    const meta = { kind: kind.data, schema: input.schema, provenance: input.provenance, created_at: createdAt };
    const digest = envelopeDigest(meta, body);
    return this.#db.transaction(async (t) => {
      if (input.unique_key !== undefined) {
        await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [UNIQUE_KEY_LOCK_SPACE, `${meta.kind}:${input.unique_key}`], t);
        const existing = await this.getByKey<B>(meta.kind, input.unique_key, t);
        if (existing !== null) return { ...existing, created: false };
      }
      const inserted = await this.#db.query<{ seq: string; id: string }>(
        `INSERT INTO records (id, digest, kind, schema, provenance, created_at, body, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (digest) DO NOTHING RETURNING seq, id`,
        [newId('rcd'), digest, meta.kind, meta.schema, meta.provenance, createdAt, body, size],
        t,
      );
      let row = inserted.rows[0];
      const created = row !== undefined;
      if (row === undefined) {
        const existing = await this.#db.query<{ seq: string; id: string }>('SELECT seq, id FROM records WHERE digest = $1', [digest], t);
        row = existing.rows[0];
        if (row === undefined) throw new IntegrityError('记录写入冲突后找不到同摘要的记录', { detail: { digest } });
      }
      if (index.length > 0) {
        await this.#db.query(
          `INSERT INTO record_index (key, value, digest, record_seq)
           SELECT k, v, $3, $4 FROM unnest($1::text[], $2::text[]) AS e(k, v) ON CONFLICT DO NOTHING`,
          [index.map((entry) => entry.key), index.map((entry) => entry.value), digest, row.seq],
          t,
        );
      }
      if (input.unique_key !== undefined) await this.#db.query('INSERT INTO record_keys (kind, key, digest) VALUES ($1, $2, $3)', [meta.kind, input.unique_key, digest], t);
      return { id: row.id, ...meta, digest, body: JSON.parse(body) as B, created };
    }, tx);
  }

  async getByKey<B = unknown>(kind: import('./api.ts').RecordKind, key: string, tx?: Transaction): Promise<StoredRecord<B> | null> {
    if (!RecordKindSchema.safeParse(kind).success) throw new TypeError('unknown record kind');
    validateUniqueKey(key);
    const found = await this.#db.query<{ digest: string }>('SELECT digest FROM record_keys WHERE kind = $1 AND key = $2', [kind, key], tx);
    if (!found.rows.length) return null;
    const record = await this.get<B>(found.rows[0].digest, tx);
    if (!record || record.kind !== kind) throw new IntegrityError('唯一业务键没有对应的完整记录');
    return record;
  }

  async get<B = unknown>(digest: string, tx?: Transaction): Promise<StoredRecord<B> | null> {
    if (!isSha256(digest)) return null;
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM records WHERE digest = $1`, [digest], tx);
    return result.rows[0] === undefined ? null : verifiedRecord<B>(result.rows[0]);
  }

  async getText(digest: string, tx?: Transaction): Promise<(Omit<StoredRecord, 'body'> & { bodyText: string ;}) | null> {
    return (await this.getTexts([digest], tx)).get(digest) ?? null;
  }

  async getTexts(digests: readonly string[], tx?: Transaction): Promise<Map<string, Omit<StoredRecord, 'body'> & { bodyText: string ;}>> {
    const wanted = [...new Set(digests.filter(isSha256))]; if (!wanted.length) return new Map();
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM records WHERE digest=ANY($1::text[])`, [wanted], tx);
    return new Map(result.rows.map(row => { const record = verifiedRecordText(row); return [record.digest, record]; }));
  }

  async getMany<B = unknown>(digests: readonly string[], tx?: Transaction): Promise<Map<string, StoredRecord<B>>> {
    const wanted = [...new Set(digests.filter(isSha256))];
    if (!wanted.length) return new Map();
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM records WHERE digest = ANY($1::text[])`,[wanted],tx);
    return new Map(result.rows.map(row => { const record = verifiedRecord<B>(row); return [record.digest,record]; }));
  }

  async findMany<B = unknown>(query: {key:string;values:readonly string[];kind?: import('./api.ts').RecordKind}, tx?: Transaction): Promise<StoredRecord<B>[]> {
    if (!INDEX_KEY.test(query.key)) throw new TypeError('invalid index key');
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const values = [...new Set(query.values.filter(isIndexValue))];
    if (!values.length) return [];
    const result = await this.#db.query(
      `SELECT DISTINCT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
       FROM record_index i JOIN records r ON r.digest=i.digest
       WHERE i.key=$1 AND i.value=ANY($2::text[]) ${query.kind === undefined ? '' : 'AND r.kind=$3'} ORDER BY r.seq`,
      query.kind === undefined ? [query.key,values] : [query.key,values,query.kind],tx);
    return result.rows.map(row => verifiedRecord<B>(row));
  }

  async findFirstMany<B = unknown>(query: { key: string; values: readonly string[]; kind?: import('./api.ts').RecordKind ;}, tx?: Transaction): Promise<Map<string, StoredRecord<B>>> {
    if (!INDEX_KEY.test(query.key)) throw new TypeError('invalid index key');
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const values = [...new Set(query.values.filter(isIndexValue))];
    if (!values.length) return new Map();
    const result = await this.#db.query(
      `SELECT wanted.value, matched.* FROM unnest($2::text[]) AS wanted(value)
       CROSS JOIN LATERAL (
         SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
         FROM record_index i JOIN records r ON r.digest=i.digest
         WHERE i.key=$1 AND i.value=wanted.value ${query.kind === undefined ? '' : 'AND r.kind=$3'}
         ORDER BY i.record_seq LIMIT 1
       ) AS matched`, query.kind === undefined ? [query.key, values] : [query.key, values, query.kind], tx);
    return new Map(result.rows.map(row => [row.value as string, verifiedRecord<B>(row)]));
  }

  async findIndexed<B = unknown>(query: IndexedQuery, tx?: Transaction): Promise<{items: IndexedRecord<B>[]; next: IndexedCursor | null}> {
    if (typeof query.key !== 'string' || !INDEX_KEY.test(query.key)) throw new TypeError('invalid index key');
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    if (!Number.isSafeInteger(query.through) || query.through < 0) throw new TypeError('invalid snapshot position');
    const limit = pageLimit(query.limit);
    const cursor = query.cursor;
    if (cursor && (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !isIndexValue(cursor.value))) throw new TypeError('invalid index cursor');
    const wanted = [...new Set(query.values.filter(isIndexValue))];
    if (!wanted.length) return {items: [], next: null};
    const values: unknown[] = [query.key, wanted, query.through, limit + 1];
    let where = 'i.key=$1 AND i.value=ANY($2::text[]) AND r.seq <= $3';
    if (query.kind !== undefined) { values.push(query.kind); where += ` AND r.kind=$${values.length}`; }
    if (cursor) { values.push(cursor.sequence, cursor.value); where += ` AND (i.record_seq,i.value) > ($${values.length - 1},$${values.length})`; }
    const result = await this.#db.query(
      `SELECT i.value, i.record_seq AS index_seq, r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
       FROM record_index i JOIN records r ON r.digest=i.digest
       WHERE ${where} ORDER BY i.record_seq,i.value LIMIT $4`, values, tx);
    const items = result.rows.slice(0, limit).map(row => {
      const position = Number(row.seq);
      if (!Number.isSafeInteger(position)) throw new LimitError('追加序号超过安全整数范围');
      return {value: row.value as string, position, record: verifiedRecord<B>(row)};
    });
    const last = result.rows.length > limit ? result.rows[limit - 1] : undefined;
    const sequence = last === undefined ? null : Number(last.index_seq);
    if (sequence !== null && !Number.isSafeInteger(sequence)) throw new LimitError('索引序号超过安全整数范围');
    return {items, next: last === undefined ? null : {sequence: sequence!, value: last.value as string}};
  }

  async getById<B = unknown>(id: string, tx?: Transaction): Promise<StoredRecord<B> | null> {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) return null;
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM records WHERE id = $1`, [id], tx);
    return result.rows[0] === undefined ? null : verifiedRecord<B>(result.rows[0]);
  }

  async find<B = unknown>(query: FindQuery, tx?: Transaction): Promise<Page<StoredRecord<B>>> {
    if (typeof query.key !== 'string' || !INDEX_KEY.test(query.key)) throw new TypeError(`invalid index key ${JSON.stringify(query.key)}`);
    // A value put() would refuse was never indexed: the answer is an empty page, not an error.
    if (!isIndexValue(query.value)) return { items: [], next: null };
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const limit = pageLimit(query.limit);
    const after = decodeCursor(query.cursor);
    const descending = query.newestFirst === true;
    const values: unknown[] = [query.key, query.value, limit + 1];
    let where = 'i.key = $1 AND i.value = $2';
    if (query.kind !== undefined) {
      values.push(query.kind);
      where += ` AND r.kind = $${values.length}`;
    }
    if (after !== null) {
      values.push(after);
      where += ` AND i.record_seq ${descending ? '<' : '>'} $${values.length}`;
    }
    const result = await this.#db.query(
      `SELECT r.seq, r.id, r.digest, r.kind, r.schema, r.provenance, r.created_at, r.body
         FROM record_index i JOIN records r ON r.digest = i.digest
        WHERE ${where} ORDER BY i.record_seq ${descending ? 'DESC' : 'ASC'} LIMIT $3`,
      values,
      tx,
    );
    return page<B>(result.rows, limit);
  }

  async list<B = unknown>(query: ListQuery, tx?: Transaction): Promise<Page<StoredRecord<B>>> {
    if (!RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const limit = pageLimit(query.limit);
    const after = decodeCursor(query.cursor);
    const descending = query.newestFirst === true;
    const values: unknown[] = [query.kind, limit + 1];
    let where = 'kind = $1';
    if (after !== null) {
      values.push(after);
      where += ` AND seq ${descending ? '<' : '>'} $3`;
    }
    const result = await this.#db.query(
      `SELECT ${COLUMNS} FROM records WHERE ${where} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT $2`,
      values,
      tx,
    );
    return page<B>(result.rows, limit);
  }

  async position(digest:string,tx?:Transaction):Promise<number|null>{const rows=await this.#db.query<{seq:string}>('SELECT seq FROM records WHERE digest=$1',[digest],tx);if(!rows.rows.length)return null;const value=Number(rows.rows[0].seq);if(!Number.isSafeInteger(value))throw new LimitError('追加序号超过安全整数范围');return value;}
  async watermark(tx?:Transaction):Promise<number>{const rows=await this.#db.query<{seq:string}>('SELECT coalesce(max(seq),0)::text AS seq FROM records',[],tx);const value=Number(rows.rows[0].seq);if(!Number.isSafeInteger(value))throw new LimitError('追加序号超过安全整数范围');return value;}

  /** Holds a session advisory lock until the returned function runs. Null means another live connection already holds it. */
  async tryHold(key: string): Promise<(() => Promise<void>) | null> {
    if (typeof key !== 'string' || !key.isWellFormed() || !key.length || key.includes('\0') || Buffer.byteLength(key, 'utf8') > 1000) throw new RecordsError('观察锁需要有效的非空键，至多 1000 UTF-8 字节且不含 NUL');
    const client = await this.#db.pool.connect();
    const name = `dispatch.observation:${key}`;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [OBSERVATION_LOCK_SPACE, name]);
      if (result.rows[0]?.locked !== true) { client.release(); return null; }
    } catch (error) { client.release(); throw error; }
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      try { await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [OBSERVATION_LOCK_SPACE, name]); }
      finally { client.release(); }
    };
  }

  async lock(key: string, tx: Transaction): Promise<void> {
    if (!tx || typeof key !== 'string' || !key.isWellFormed() || !key.length || key.includes('\0') || Buffer.byteLength(key, 'utf8') > 1000) throw new RecordsError('业务锁需要给定事务和有效的非空键，至多 1000 UTF-8 字节且不含 NUL');
    // The dedicated namespace separates business identities from ingestion and authorization decisions.
    await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [BUSINESS_LOCK_SPACE, `record-store.business:${key}`], tx);
  }

  withTransaction<T>(fn: (tx: Transaction) => Promise<T>, outer?: Transaction): Promise<T> {
    return this.#db.transaction(fn, outer);
  }
}

function page<B>(rows: Row[], limit: number): Page<StoredRecord<B>> {
  const items = rows.slice(0, limit).map((row) => verifiedRecord<B>(row));
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { items, next: last === undefined ? null : encodeCursor(String(last.seq)) };
}

export function isIndexValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_INDEX_VALUE_BYTES &&
    !value.includes('\0') &&
    value.isWellFormed() &&
    Buffer.byteLength(value, 'utf8') <= MAX_INDEX_VALUE_BYTES
  );
}

export function validateIndex(entries: readonly IndexEntry[]): IndexEntry[] {
  if (!Array.isArray(entries) || entries.length > 200) throw new TypeError('index must be an array of at most 200 entries');
  return entries.map((entry) => {
    if (typeof entry?.key !== 'string' || !INDEX_KEY.test(entry.key)) throw new TypeError(`invalid index key ${JSON.stringify(entry?.key)}`);
    if (!isIndexValue(entry.value)) throw new TypeError(`invalid index value for ${entry.key}: at most ${MAX_INDEX_VALUE_BYTES} bytes of UTF-8, well-formed, no NUL`);
    return { key: entry.key, value: entry.value };
  });
}

/** Rebuilds a record from its row and refuses it when the stored text no longer hashes to the stored digest. */
function verifiedRecordText(row: Row): Omit<StoredRecord, 'body'> & { bodyText: string ;} {
  const meta = { kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: iso(row.created_at) };
  const bodyText = String(row.body);
  if (envelopeDigest(meta, bodyText) !== row.digest) {
    const { body, ...record } = verifiedRecord(row);
    return { ...record, bodyText: canonicalize(body) };
  }
  const kind = RecordKindSchema.safeParse(meta.kind);
  if (!kind.success || !isProvenanceType(meta.provenance) || !SchemaId.safeParse(meta.schema).success) throw new IntegrityError('记录的种类、来源类型或模式不在合约里');
  return { id: String(row.id), digest: String(row.digest), ...meta, kind: kind.data, provenance: meta.provenance, bodyText };
}

export function verifiedRecord<B>(row: Row): StoredRecord<B> {
  const createdAt = iso(row.created_at);
  const meta = { kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: createdAt };
  const body = String(row.body);
  let parsedFallback: unknown;
  let noncanonical = false;
  if (envelopeDigest(meta, body) !== row.digest) {
    try {
      parsedFallback = parseStrictJson(body);
      const canonicalBody = canonicalize(parsedFallback);
      if (envelopeDigest(meta, canonicalBody) !== row.digest) throw new Error('digest mismatch');
      noncanonical = true;
    } catch {
      throw new IntegrityError('记录内容与它的摘要不符（存储被改动过或正文不能规范化）', { detail: { record: row.id, digest: row.digest } });
    }
  }
  const kind = RecordKindSchema.safeParse(meta.kind);
  if (!kind.success || !isProvenanceType(meta.provenance)) {
    throw new IntegrityError('记录的种类或来源类型不在词表里', { detail: { record: row.id } });
  }
  // The table only checks the shape (migration 1 lets a leading-zero major through); put() and every read apply SchemaId.
  if (!SchemaId.safeParse(meta.schema).success) {
    throw new IntegrityError('记录的模式名不是 name@major（contracts SchemaId）', { detail: { record: row.id } });
  }
  let parsed: B;
  try {
    parsed = noncanonical ? parsedFallback as B : JSON.parse(body) as B;
  } catch (error) {
    throw new IntegrityError('记录正文不是 JSON', { detail: { record: row.id }, cause: error });
  }
  if (noncanonical) noteNoncanonical(String(row.id), String(row.digest));
  return { id: String(row.id), kind: kind.data, schema: meta.schema, digest: String(row.digest), provenance: meta.provenance, created_at: createdAt, body: parsed, ...(noncanonical?{integrity_note:NONCANONICAL_EXPLANATION}:{}) };
}

function validateUniqueKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || !isIndexValue(key)) throw new TypeError('unique key must be 1..1000 UTF-8 bytes, well formed, without NUL');
}

/** Public factory for a store sharing a caller-owned database/transaction boundary. */
export function createRecordStore(db: Database, options: StoreOptions): RecordStore { return new PgRecordStore(db, options); }
