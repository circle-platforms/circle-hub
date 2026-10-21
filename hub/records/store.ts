// Append-only record store over PostgreSQL. Bodies are stored as their RFC 8785 canonical text, so every value canonicalize
// accepts (JSON data with well-formed strings, U+0000 included, which PostgreSQL text and jsonb reject raw) is kept exactly;
// digests are re-verified on read. Input canonicalize refuses (a lone surrogate) is kept as an object instead (README).
import { SchemaId } from '../../contracts/src/common.ts';
import { RecordKindSchema } from '../../contracts/src/records.ts';
import { isProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { FindQuery, IndexEntry, ListQuery, Page, PutResult, RecordInput, RecordStore, StoredRecord, Transaction } from './api.ts';
import { canonicalize } from './canonical.ts';
import { decodeCursor, encodeCursor, iso, normalizeTime, pageLimit } from './db.ts';
import type { Database, Row } from './db.ts';
import { envelopeCanonical, isSha256, sha256Hex } from './digest.ts';
import { IntegrityError, LimitError } from './errors.ts';
import { newId } from './ids.ts';

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
    const meta = { kind: kind.data, schema: input.schema, provenance: input.provenance, created_at: createdAt };
    const digest = sha256Hex(envelopeCanonical(meta, body));
    return this.#db.transaction(async (t) => {
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
      return { id: row.id, ...meta, digest, body: JSON.parse(body) as B, created };
    }, tx);
  }

  async get<B = unknown>(digest: string, tx?: Transaction): Promise<StoredRecord<B> | null> {
    if (!isSha256(digest)) return null;
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM records WHERE digest = $1`, [digest], tx);
    return result.rows[0] === undefined ? null : verifiedRecord<B>(result.rows[0]);
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
export function verifiedRecord<B>(row: Row): StoredRecord<B> {
  const createdAt = iso(row.created_at);
  const meta = { kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: createdAt };
  const body = String(row.body);
  if (sha256Hex(envelopeCanonical(meta, body)) !== row.digest) {
    throw new IntegrityError('记录内容与它的摘要不符（存储被改动过）', { detail: { record: row.id, digest: row.digest } });
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
    parsed = JSON.parse(body) as B;
  } catch (error) {
    throw new IntegrityError('记录正文不是 JSON', { detail: { record: row.id }, cause: error });
  }
  return { id: String(row.id), kind: kind.data, schema: meta.schema, digest: String(row.digest), provenance: meta.provenance, created_at: createdAt, body: parsed };
}
