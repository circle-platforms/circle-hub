import {verifiedReadValue} from './read-scope.ts';
import {PgPersonalPayloads,personalRecordOwner,isPersonalPackRecord,captureRecordOwner} from './personal-payloads.ts';
import { RecordsError } from './errors.ts';
// Append-only logical records over PostgreSQL. Canonical text preserves every accepted JSON value, including U+0000.
// Personal bodies use removable scoped payloads; immutable capsules retain their original logical digests.
// Reads reconstruct and verify active records. Noncanonical input stays an object instead (README).
import { noteNoncanonical, NONCANONICAL_EXPLANATION } from './integrity-notes.ts';
import { parseStrictJson } from './strict-json.ts';
export { recordIntegrityNotes, type RecordIntegrityNote } from './integrity-notes.ts';
import { SchemaId,IsoTime } from '../../contracts/src/common.ts';
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
  readonly personalPayloads:PgPersonalPayloads;
  readonly #options: StoreOptions;

  constructor(db: Database, options: StoreOptions) {
    this.#db = db;
    this.#options = options;
    this.personalPayloads=new PgPersonalPayloads(db,(key,tx)=>this.lock(key,tx));
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
      const capturedOwner=kind.data==='source_artifact'?captureRecordOwner(input.body):null;
      const registered=capturedOwner?(await this.#db.query('SELECT id FROM users WHERE id=$1',[capturedOwner],t)).rows[0]:null;
      const personalOwner=input.personalOwner??personalRecordOwner(kind.data,input.body)??(registered?capturedOwner:null);
      const accountOwned=input.accountOwned||isPersonalPackRecord(kind.data)||!!(registered&&!(input.body as {personal_scope?:unknown})?.personal_scope&&input.personalOwner===undefined);
      const storedBody=personalOwner?await this.personalPayloads.bind(await (accountOwned?this.personalPayloads.account(personalOwner,t):this.personalPayloads.scope(personalOwner,t)),digest,meta,body,t):body;
      const inserted = await this.#db.query<{ seq: string; id: string }>(
        `INSERT INTO records (id, digest, kind, schema, provenance, created_at, body, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (digest) DO NOTHING RETURNING seq, id`,
        [newId('rcd'), digest, meta.kind, meta.schema, meta.provenance, createdAt, storedBody, size],
        t,
      );
      let row = inserted.rows[0];
      const created = row !== undefined;
      if (row === undefined) {
        const existing = await this.#db.query<{ seq: string; id: string }>('SELECT seq, id FROM hub_read_records() WHERE digest = $1', [digest], t);
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
    if(!record&&await this.personalPayloads.inspect(found.rows[0].digest,tx))return null;
    if (!record || record.kind !== kind) throw new IntegrityError('唯一业务键没有对应的完整记录');
    return record;
  }

  async get<B = unknown>(digest: string, tx?: Transaction): Promise<StoredRecord<B> | null> {
    if (!isSha256(digest)) return null;
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM hub_read_records() WHERE digest = $1`, [digest], tx);
    if(result.rows[0]===undefined){await this.personalPayloads.inspect(digest,tx);return null;}
    return verifiedRecord<B>(result.rows[0],tx);
  }

  async getText(digest: string, tx?: Transaction): Promise<(Omit<StoredRecord, 'body'> & { bodyText: string ;}) | null> {
    return (await this.getTexts([digest], tx)).get(digest) ?? null;
  }

  async getTexts(digests: readonly string[], tx?: Transaction): Promise<Map<string, Omit<StoredRecord, 'body'> & { bodyText: string ;}>> {
    const wanted = [...new Set(digests.filter(isSha256))]; if (!wanted.length) return new Map();
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM hub_read_records() WHERE digest=ANY($1::text[])`, [wanted], tx);
    return new Map(result.rows.map(row => { const record = verifiedRecordText(row,tx); return [record.digest, record]; }));
  }

  async getMany<B = unknown>(digests: readonly string[], tx?: Transaction): Promise<Map<string, StoredRecord<B>>> {
    const wanted = [...new Set(digests.filter(isSha256))];
    if (!wanted.length) return new Map();
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM hub_read_records() WHERE digest = ANY($1::text[])`,[wanted],tx);
    return new Map(result.rows.map(row => { const record = verifiedRecord<B>(row,tx); return [record.digest,record]; }));
  }

  async findMany<B = unknown>(query: {key:string;values:readonly string[];kind?: import('./api.ts').RecordKind}, tx?: Transaction): Promise<StoredRecord<B>[]> {
    if (!INDEX_KEY.test(query.key)) throw new TypeError('invalid index key');
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const values = [...new Set(query.values.filter(isIndexValue))];
    if (!values.length) return [];
    const result = await this.#db.query(
      `SELECT DISTINCT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
       FROM record_index i JOIN hub_read_records() r ON r.digest=i.digest
       WHERE i.key=$1 AND i.value=ANY($2::text[]) ${query.kind === undefined ? '' : 'AND r.kind=$3'} ORDER BY r.seq`,
      query.kind === undefined ? [query.key,values] : [query.key,values,query.kind],tx);
    return result.rows.map(row => verifiedRecord<B>(row,tx));
  }

  async addIndex(digest: string, entries: readonly IndexEntry[], tx?: Transaction): Promise<number> {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('a record digest is 64 hexadecimal characters');
    const index = validateIndex(entries);
    if (index.length === 0) return 0;
    return this.#db.transaction(async (t) => {
      const row = (await this.#db.query<{ seq: string }>('SELECT seq FROM hub_read_records() WHERE digest = $1', [digest], t)).rows[0];
      if (row === undefined) return 0;
      const held = Number((await this.#db.query<{ n: string }>('SELECT count(*) AS n FROM record_index WHERE digest = $1', [digest], t)).rows[0].n);
      const fresh = (await this.#db.query<{ key: string; value: string }>(
        `SELECT k AS key, v AS value FROM unnest($1::text[], $2::text[]) AS e(k, v)
          WHERE NOT EXISTS (SELECT 1 FROM record_index i WHERE i.key = e.k AND i.value = e.v AND i.digest = $3)`,
        [index.map((entry) => entry.key), index.map((entry) => entry.value), digest],
        t,
      )).rows;
      if (fresh.length === 0) return 0;
      if (held + fresh.length > 200) throw new TypeError('a record holds at most 200 index entries');
      const inserted = await this.#db.query(
        `INSERT INTO record_index (key, value, digest, record_seq)
         SELECT k, v, $3, $4 FROM unnest($1::text[], $2::text[]) AS e(k, v) ON CONFLICT DO NOTHING`,
        [fresh.map((entry) => entry.key), fresh.map((entry) => entry.value), digest, row.seq],
        t,
      );
      return inserted.rowCount ?? 0;
    }, tx);
  }

  async databaseSize(): Promise<number> {
    const row = (await this.#db.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size')).rows[0];
    return Number(row.size);
  }

  async countIndexed(query: { index: readonly IndexEntry[]; kind?: import('./api.ts').RecordKind; since?: string; cap?: number }, tx?: Transaction): Promise<{ count: number; capped: boolean }> {
    if (!Array.isArray(query.index) || query.index.length > 1000) throw new TypeError('countIndexed takes at most 1000 index entries');
    for (const entry of query.index) if (typeof entry?.key !== 'string' || !INDEX_KEY.test(entry.key)) throw new TypeError('invalid index key');
    if (query.kind !== undefined && !RecordKindSchema.safeParse(query.kind).success) throw new TypeError('unknown record kind');
    const cap = query.cap ?? 10_000;
    if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) throw new TypeError('cap is an integer from 1 to 100000');
    const pairs = query.index.filter((entry) => isIndexValue(entry.value));
    if (pairs.length === 0) return { count: 0, capped: false };
    const since = query.since === undefined ? null : normalizeTime(query.since, 'since');
    const result = await this.#db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT r.digest
           FROM unnest($1::text[], $2::text[]) AS wanted(k, v)
           JOIN record_index i ON i.key = wanted.k AND i.value = wanted.v
           JOIN hub_read_records() r ON r.digest = i.digest
          WHERE ($3::text IS NULL OR r.kind = $3) AND ($4::timestamptz IS NULL OR r.created_at >= $4)
          LIMIT $5
       ) AS found`,
      [pairs.map((entry) => entry.key), pairs.map((entry) => entry.value), query.kind ?? null, since, cap],
      tx,
    );
    const count = Number(result.rows[0]?.n ?? 0);
    return { count, capped: count >= cap };
  }

  async countIndexedBatch(queries:readonly {index:readonly IndexEntry[];kind?:import('./api.ts').RecordKind;since?:string;cap?:number}[],tx?:Transaction):Promise<{count:number;capped:boolean}[]>{
    const input=queries.map((q,n)=>{
      if(!Array.isArray(q.index)||q.index.length>1000)throw new TypeError('countIndexed takes at most 1000 index entries');
      for(const entry of q.index)if(typeof entry?.key!=='string'||!INDEX_KEY.test(entry.key))throw new TypeError('invalid index key');
      if(q.kind!==undefined&&!RecordKindSchema.safeParse(q.kind).success)throw new TypeError('unknown record kind');
      const cap=q.cap??10000;if(!Number.isInteger(cap)||cap<1||cap>100000)throw new TypeError('cap is an integer from 1 to 100000');
      const pairs=q.index.filter(entry=>isIndexValue(entry.value));
      return {n,pairs,kind:q.kind??null,since:pairs.length&&q.since!==undefined?normalizeTime(q.since,'since'):null,cap};
    });
    if(!input.length)return [];
    const result=await this.#db.query<{n:number;count:number}>(`SELECT q.n,(SELECT count(*)::int FROM (
      SELECT DISTINCT r.digest FROM jsonb_to_recordset(q.pairs) AS wanted(key text,value text)
      JOIN record_index i ON i.key=wanted.key AND i.value=wanted.value JOIN hub_read_records() r ON r.digest=i.digest
      WHERE (q.kind IS NULL OR r.kind=q.kind) AND (q.since IS NULL OR r.created_at>=q.since) LIMIT q.cap
    ) found) AS count FROM jsonb_to_recordset($1::jsonb) AS q(n int,pairs jsonb,kind text,since timestamptz,cap int)`,[JSON.stringify(input)],tx);
    const counts=new Map(result.rows.map(row=>[Number(row.n),Number(row.count)]));
    return input.map(q=>{const count=counts.get(q.n)??0;return {count,capped:count>=q.cap};});
  }

  async entryCandidates(query:{digests:readonly string[];spaces?:readonly string[];reader?:string;offset:number;limit:number},tx?:Transaction):Promise<{items:{index:number;at:string}[];total:number}>{
    const limit=pageLimit(query.limit);if(!Number.isSafeInteger(query.offset)||query.offset<0)throw new TypeError('entry offset must be a nonnegative safe integer');
    if(query.spaces&&query.spaces.length!==query.digests.length)throw new TypeError('entry spaces must match candidate digests');
    if(!query.digests.length)return {items:[],total:0};
    const result=await this.#db.query<{items:{index:number;at:string}[];total:string;legacy:string[]}>(`WITH headers AS MATERIALIZED (
      SELECT (wanted.n-1)::int AS n,r.digest,substring(r.body FROM '^[{]"at":"([0-9T:.Z-]+)"') AS at
      FROM unnest($1::text[], $4::text[]) WITH ORDINALITY AS wanted(digest,space,n) JOIN hub_read_records() r ON r.digest=wanted.digest
      WHERE r.kind='knowledge_space_entry' AND (wanted.space IS NULL OR replace(r.body,'\\u0000','\\uFFFD')::json->>'space'=wanted.space
        OR (replace(r.body,'\\u0000','\\uFFFD')::json->>'owner'=wanted.space
          AND replace(r.body,'\\u0000','\\uFFFD')::json->>'record'=r.digest
          AND replace(r.body,'\\u0000','\\uFFFD')::json->>'personal_payload' IS NOT NULL))
        AND ($5::text IS NULL OR replace(r.body,'\\u0000','\\uFFFD')::json->>'space'=$5 OR replace(r.body,'\\u0000','\\uFFFD')::json->>'sync_private' IS DISTINCT FROM 'true')
    ), selected AS (SELECT n,at FROM headers ORDER BY at COLLATE "C" DESC NULLS FIRST,n OFFSET $2 LIMIT $3)
    SELECT (SELECT count(*) FROM headers)::text AS total,
      COALESCE((SELECT json_agg(json_build_object('index',n,'at',at) ORDER BY at COLLATE "C" DESC NULLS FIRST,n) FROM selected),'[]'::json) AS items,
      ARRAY(SELECT digest FROM headers WHERE at IS NULL) AS legacy`,[query.digests.map(d=>isSha256(d)?d:null),query.offset,limit,query.spaces??query.digests.map(()=>null),query.reader??null],tx);
    const row=result.rows[0];
    if(row.legacy.length){
      // An active capsule without its body must reach verified hydration and fail integrity, never look like empty space.
      const times=await this.entryTimes(query.digests,tx);
      const bodies=query.spaces||query.reader?await this.getMany<{space:string;sync_private?:boolean}>(query.digests,tx):null;
      const ordered=query.digests.flatMap((digest,index)=>times.has(digest)&&(!query.spaces||bodies?.get(digest)?.body.space===query.spaces[index])&&(!query.reader||bodies?.get(digest)?.body.space===query.reader||!bodies?.get(digest)?.body.sync_private)?[{index,at:times.get(digest)!}]:[]).sort((a,b)=>b.at.localeCompare(a.at));
      return {items:ordered.slice(query.offset,query.offset+limit),total:ordered.length};
    }
    for(const item of row.items)if(!IsoTime.safeParse(item.at).success)throw new IntegrityError('知识条目时间字段不完整');
    return {items:row.items,total:Number(row.total)};
  }

  async entryTimes(digests:readonly string[],tx?:Transaction):Promise<Map<string,string>>{
    const wanted=[...new Set(digests.filter(isSha256))];if(!wanted.length)return new Map();
    // JCS puts the strict entry body's ASCII `at` header first. Read only that header, including bodies with escaped NUL.
    const rows=await this.#db.query<{digest:string;at:string}>(`SELECT digest,substring(body FROM '^[{]"at":"([0-9T:.Z-]+)"') AS at
      FROM hub_read_records() WHERE kind='knowledge_space_entry' AND digest=ANY($1::text[])`,[wanted],tx);
    const times=new Map<string,string>(),legacy:string[]=[];
    for(const row of rows.rows)if(IsoTime.safeParse(row.at).success)times.set(row.digest,row.at);else legacy.push(row.digest);
    // Equivalent noncanonical JSON has always been readable. Fall back to its original verified parse, never rewrite it.
    if(legacy.length)for(const [digest,record]of await this.getMany<{at:string}>(legacy,tx)){
      if(!IsoTime.safeParse(record.body?.at).success)throw new IntegrityError('知识条目时间字段不完整');times.set(digest,record.body.at);
    }
    return times;
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
         FROM record_index i JOIN hub_read_records() r ON r.digest=i.digest
         WHERE i.key=$1 AND i.value=wanted.value ${query.kind === undefined ? '' : 'AND r.kind=$3'}
         ORDER BY i.record_seq LIMIT 1
       ) AS matched`, query.kind === undefined ? [query.key, values] : [query.key, values, query.kind], tx);
    return new Map(result.rows.map(row => [row.value as string, verifiedRecord<B>(row,tx)]));
  }

  async lastPositions(query: { keys: readonly string[]; values: readonly string[] }, tx?: Transaction): Promise<Map<string, number>> {
    const keys = [...new Set(query.keys)];
    if (keys.some((key) => typeof key !== 'string' || !INDEX_KEY.test(key))) throw new TypeError('invalid index key');
    const values = [...new Set(query.values.filter(isIndexValue))];
    if (!keys.length || !values.length) return new Map();
    const result = await this.#db.query(
      `SELECT value, max(record_seq) AS position FROM record_index WHERE key = ANY($1::text[]) AND value = ANY($2::text[]) GROUP BY value`,
      [keys, values], tx);
    return new Map(result.rows.map((row) => {
      const position = Number(row.position);
      if (!Number.isSafeInteger(position)) throw new LimitError('索引序号超过安全整数范围');
      return [String(row.value), position];
    }));
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
       FROM record_index i JOIN hub_read_records() r ON r.digest=i.digest
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
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM hub_read_records() WHERE id = $1`, [id], tx);
    return result.rows[0] === undefined ? null : verifiedRecord<B>(result.rows[0],tx);
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
         FROM record_index i JOIN hub_read_records() r ON r.digest = i.digest
        WHERE ${where} ORDER BY i.record_seq ${descending ? 'DESC' : 'ASC'} LIMIT $3`,
      values,
      tx,
    );
    return page<B>(result.rows, limit,tx);
  }

  async findBatch<B=unknown>(queries:readonly FindQuery[],tx?:Transaction):Promise<Page<StoredRecord<B>>[]>{
    const input=queries.map((q,n)=>{
      if(typeof q.key!=='string'||!INDEX_KEY.test(q.key))throw new TypeError(`invalid index key ${JSON.stringify(q.key)}`);
      if(!isIndexValue(q.value))return null;
      if(q.kind!==undefined&&!RecordKindSchema.safeParse(q.kind).success)throw new TypeError('unknown record kind');
      return {n,key:q.key,value:q.value,kind:q.kind??null,after:decodeCursor(q.cursor),lim:pageLimit(q.limit),descending:q.newestFirst===true};
    }).filter(q=>q!==null);
    const groups=new Map<number,Row[]>();
    if(input.length){const result=await this.#db.query(`SELECT q.n,r.*
      FROM jsonb_to_recordset($1::jsonb) AS q(n int,key text,value text,kind text,after bigint,lim int,descending boolean)
      CROSS JOIN LATERAL (
        SELECT r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
        FROM record_index i JOIN hub_read_records() r ON r.digest=i.digest
        WHERE i.key=q.key AND i.value=q.value AND (q.kind IS NULL OR r.kind=q.kind)
          AND (q.after IS NULL OR (q.descending AND i.record_seq<q.after) OR (NOT q.descending AND i.record_seq>q.after))
        ORDER BY CASE WHEN q.descending THEN i.record_seq END DESC,CASE WHEN NOT q.descending THEN i.record_seq END ASC
        LIMIT q.lim+1
      ) r ORDER BY q.n`,[JSON.stringify(input)],tx);
      for(const row of result.rows){const n=Number(row.n);const rows=groups.get(n)??[];rows.push(row);groups.set(n,rows);}
    }
    // Lateral rows retain the requested order; the outer group ordering alone is not an SQL order guarantee.
    return queries.map((q,n)=>{if(!isIndexValue(q.value))return {items:[],next:null};const rows=groups.get(n)??[];rows.sort((a,b)=>{const order=BigInt(String(a.seq))-BigInt(String(b.seq));return order===0n?0:(order>0n?1:-1)*(q.newestFirst===true?-1:1);});return page<B>(rows,pageLimit(q.limit),tx);});
  }

  async runCandidates<B=unknown>(query:{after?:readonly [string,string];pack?:string;limit:number},tx?:Transaction):Promise<StoredRecord<B>[]>{
    const limit=pageLimit(query.limit);if(query.pack!==undefined&&!isIndexValue(query.pack))return [];
    // The order lives in record_index, so a page reads the rows it returns: casting every run body to JSON to sort cost 7 to
    // 11 seconds a page on a deployment with 240 MB of runs. A run without the entry (a malformed header, a row from before
    // migration 29 on a data set it could not index) keeps the original statement, which orders it and reports it.
    const unordered=await this.#db.query(`SELECT 1 FROM hub_read_records() r WHERE r.kind='run' AND NOT EXISTS(SELECT 1 FROM record_index o WHERE o.digest=r.digest AND o.key='runs.started') LIMIT 1`,[],tx);
    if(unordered.rows.length===0){
      const values:unknown[]=['run',limit];
      let where=`o.key='runs.started' AND r.kind=$1`;
      // The tuple as stored, not the joined text: an untrusted cursor compares as it always did.
      if(query.after){values.push(...query.after.map(value=>value.replaceAll('\0','\u0001')));where+=` AND (split_part(o.value,' ',1) COLLATE "C",split_part(o.value,' ',2) COLLATE "C")<($3::text COLLATE "C",$4::text COLLATE "C")`;}
      if(query.pack!==undefined){values.push(query.pack);where+=` AND EXISTS(SELECT 1 FROM record_index i WHERE i.digest=r.digest AND i.key='runs.pack' AND i.value=$${values.length})`;}
      const ordered=await this.#db.query(`SELECT ${COLUMNS.split(', ').map(c=>'r.'+c).join(', ')} FROM record_index o JOIN hub_read_records() r ON r.digest=o.digest WHERE ${where}
        ORDER BY o.value COLLATE "C" DESC LIMIT $2`,values,tx);
      return ordered.rows.map(row=>verifiedRecord<B>(row,tx));
    }
    // Only the contract's ASCII headers are ordered. Mask an unrelated escaped NUL in this SQL projection,
    // never in the selected record text: PostgreSQL JSON text extraction otherwise rejects the whole body.
    const values:unknown[]=['run','\\u0000','\\uFFFD',limit];
    const body="replace(r.body,$2::text,$3::text)::json",at=`(${body}->>'started_at')`,id=`(${body}->>'run')`;
    let where='r.kind=$1';
    // Cursor strings are untrusted. Both contract headers are ASCII without controls, so U+0001 has the same
    // ordering against every valid header as an embedded NUL, which PostgreSQL text parameters cannot carry.
    if(query.after){values.push(...query.after.map(value=>value.replaceAll('\0','\u0001')));where+=` AND (${at} COLLATE "C",${id} COLLATE "C")<($5::text COLLATE "C",$6::text COLLATE "C")`;}
    if(query.pack!==undefined){values.push(query.pack);where+=` AND EXISTS(SELECT 1 FROM record_index i WHERE i.digest=r.digest AND i.key='runs.pack' AND i.value=$${values.length})`;}
    const result=await this.#db.query(`SELECT ${COLUMNS.split(', ').map(c=>'r.'+c).join(', ')} FROM hub_read_records() r WHERE ${where}
      ORDER BY ${at} COLLATE "C" DESC NULLS FIRST,${id} COLLATE "C" DESC NULLS FIRST LIMIT $4`,values,tx);
    // Preserve verified malformed records for the engine's diagnostic/fallback path; a business header is not envelope integrity.
    return result.rows.map(row=>verifiedRecord<B>(row,tx));
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
      `SELECT ${COLUMNS} FROM hub_read_records() WHERE ${where} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT $2`,
      values,
      tx,
    );
    return page<B>(result.rows, limit,tx);
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

function page<B>(rows: Row[], limit: number,tx?:Transaction): Page<StoredRecord<B>> {
  const items = rows.slice(0, limit).map((row) => verifiedRecord<B>(row,tx));
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
function verifiedRecordText(row: Row,tx?:Transaction): Omit<StoredRecord, 'body'> & { bodyText: string ;} {
  const record=verifiedRecord(row,tx),{body,...metadata}=record;
  return {...metadata,bodyText:record.integrity_note?canonicalize(body):String(row.body)};
}

export function verifiedRecord<B>(row: Row,tx?:Transaction): StoredRecord<B> {
  if(typeof row.digest!=='string')return verifyRecord<B>(row);
  const normalized={id:String(row.id),digest:row.digest,kind:String(row.kind),schema:String(row.schema),provenance:String(row.provenance),created_at:iso(row.created_at),body:String(row.body)};
  return verifiedReadValue([normalized.digest,normalized.id,normalized.kind,normalized.schema,normalized.provenance,normalized.created_at,normalized.body],()=>verifyRecord<B>(normalized),tx);
}
function verifyRecord<B>(row: Row): StoredRecord<B> {
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
