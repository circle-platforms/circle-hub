import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { normalizeTime, recordDigest, sha256Hex } from '../../../hub/records/api.ts';
import { BUNDLE_SCHEMA, TABLE_POLICY, type BundleManifest, type BundleRow } from './submissions-bundle-format.ts';
import { connect, type DatabaseSettings } from './submissions-export.ts';

export * from './submissions-bundle-format.ts';
export { exportBundle } from './submissions-export.ts';

const objectPath = (root: string, sha: string): string => join(root, sha.slice(0, 2), sha);

export interface Bundle {
  dir: string;
  manifest: BundleManifest;
  rows(table: string): AsyncGenerator<BundleRow>;
  objectFile(sha256: string): Promise<string | null>;
}

export async function openBundle(dir: string): Promise<Bundle> {
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
  } catch {
    throw new Error(`数据包 ${dir} 里没有读得出的 manifest.json`);
  }
  if (manifest.schema !== BUNDLE_SCHEMA) throw new Error(`数据包 ${dir} 的格式 ${String(manifest.schema)} 不是 ${BUNDLE_SCHEMA}`);
  return {
    dir,
    manifest,
    async *rows(table) {
      if (manifest.tables[table] === undefined) return;
      const input = createInterface({ input: createReadStream(join(dir, 'tables', `${table}.jsonl`), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of input) if (line !== '') yield JSON.parse(line) as BundleRow;
    },
    async objectFile(sha256) {
      const path = join(dir, 'objects', sha256.slice(0, 2), sha256);
      return (await stat(path).catch(() => null)) === null ? null : path;
    },
  };
}

export interface LoadReport {
  records: number;
  rewritten: number;
  digestMismatches: Array<{ seq: number; kind: string; digest: string }>;
  personalMarkers: number;
}

type Connection = pg.Client | pg.Pool;

const BATCH_BYTES = 8 * 1024 * 1024;

async function insertRows(db: Connection, table: string, rows: BundleRow[], identity: boolean): Promise<void> {
  if (rows.length === 0) return;
  await db.query(`INSERT INTO public."${table}" ${identity ? 'OVERRIDING SYSTEM VALUE ' : ''}SELECT * FROM jsonb_populate_recordset(NULL::public."${table}", $1::jsonb)`, [JSON.stringify(rows)]);
}

async function hasIdentity(db: Connection, table: string): Promise<boolean> {
  const found = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_identity='YES'", [table]);
  return found.rows.length > 0;
}

export async function withLoadSession<T>(config: DatabaseSettings, run: (db: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(config);
  try {
    await client.query("SET session_replication_role = 'replica'");
    return await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

class PositionCursor {
  readonly #rows: AsyncGenerator<BundleRow>;
  readonly #field: 'seq' | 'record_seq';
  #pending: BundleRow | null = null;
  constructor(bundle: Bundle, table: string, field: 'seq' | 'record_seq') {
    this.#rows = bundle.rows(table);
    this.#field = field;
  }
  async below(limit: number): Promise<BundleRow[]> {
    const taken: BundleRow[] = [];
    for (;;) {
      if (this.#pending === null) {
        const next = await this.#rows.next();
        if (next.done === true) break;
        this.#pending = next.value;
      }
      if (Number(this.#pending[this.#field]) >= limit) break;
      taken.push(this.#pending);
      this.#pending = null;
    }
    return taken;
  }
}

export class RecordLoader {
  readonly #records: PositionCursor;
  readonly #index: PositionCursor;
  readonly #bundle: Bundle;
  #keyRows: Map<string, BundleRow[]> | null = null;
  #identity: boolean | null = null;

  constructor(bundle: Bundle) {
    this.#bundle = bundle;
    this.#records = new PositionCursor(bundle, 'records', 'seq');
    this.#index = new PositionCursor(bundle, 'record_index', 'record_seq');
  }

  async load(db: pg.Client, to: number, rewrite?: (row: BundleRow) => BundleRow | null): Promise<LoadReport> {
    const report: LoadReport = { records: 0, rewritten: 0, digestMismatches: [], personalMarkers: 0 };
    this.#identity ??= await hasIdentity(db, 'records');
    if (this.#keyRows === null) {
      this.#keyRows = new Map();
      for await (const row of this.#bundle.rows('record_keys')) {
        const list = this.#keyRows.get(String(row.digest)) ?? [];
        list.push(row);
        this.#keyRows.set(String(row.digest), list);
      }
    }
    const digestMap = new Map<string, string>();
    const loaded: string[] = [];
    let batch: BundleRow[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      await insertRows(db, 'records', batch, this.#identity === true);
      batch = [];
      bytes = 0;
    };
    for (const original of await this.#records.below(to)) {
      const row = rewrite?.(original) ?? original;
      if (row !== original) {
        report.rewritten += 1;
        digestMap.set(String(original.digest), String(row.digest));
      } else {
        const body = JSON.parse(String(row.body)) as unknown;
        const expected = recordDigest({ kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: normalizeTime(new Date(String(row.created_at)).toISOString(), 'created_at'), body });
        if (expected !== row.digest) {
          const marker = body as { personal_payload?: unknown; record?: unknown } | null;
          if (typeof marker?.personal_payload === 'string' && marker.record === row.digest) report.personalMarkers += 1;
          else report.digestMismatches.push({ seq: Number(row.seq), kind: String(row.kind), digest: String(row.digest) });
        }
      }
      loaded.push(String(original.digest));
      batch.push(row);
      bytes += String(row.body).length + 200;
      report.records += 1;
      if (bytes > BATCH_BYTES) await flush();
    }
    await flush();
    const mapped = (digest: unknown): string => digestMap.get(String(digest)) ?? String(digest);
    let indexBatch: BundleRow[] = [];
    for (const row of await this.#index.below(to)) {
      indexBatch.push({ ...row, digest: mapped(row.digest) });
      if (indexBatch.length >= 2000) {
        await insertRows(db, 'record_index', indexBatch, false);
        indexBatch = [];
      }
    }
    await insertRows(db, 'record_index', indexBatch, false);
    const keys = loaded.flatMap((digest) => (this.#keyRows!.get(digest) ?? []).map((row) => ({ ...row, digest: mapped(row.digest) })));
    await insertRows(db, 'record_keys', keys, false);
    return report;
  }
}

export async function loadStatic(db: pg.Client, bundle: Bundle, objectsRoot: string): Promise<{ objects: number; missingBytes: string[]; tables: Record<string, number> }> {
  const tables: Record<string, number> = {};
  for (const [table, policy] of Object.entries(TABLE_POLICY)) {
    if (policy.how !== 'full' || bundle.manifest.tables[table] === undefined) continue;
    const rows: BundleRow[] = [];
    for await (const row of bundle.rows(table)) rows.push(row);
    await insertRows(db, table, rows, await hasIdentity(db, table));
    tables[table] = rows.length;
  }
  const missingBytes: string[] = [];
  let objects = 0;
  let batch: BundleRow[] = [];
  for await (const row of bundle.rows('objects')) {
    const sha = String(row.sha256);
    const from = await bundle.objectFile(sha);
    if (from === null) {
      missingBytes.push(sha);
      continue;
    }
    const to = objectPath(objectsRoot, sha);
    await mkdir(dirname(to), { recursive: true });
    const bytes = await readFile(from);
    if (sha256Hex(bytes) !== sha) throw new Error(`数据包里的对象 ${sha} 的字节与名字对不上`);
    await copyFile(from, to, constants.COPYFILE_FICLONE);
    batch.push(row);
    objects += 1;
    if (batch.length >= 500) {
      await insertRows(db, 'objects', batch, false);
      batch = [];
    }
  }
  await insertRows(db, 'objects', batch, false);
  return { objects, missingBytes, tables };
}
