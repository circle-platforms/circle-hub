// Writes a replay bundle from a Hub database: read-only (one REPEATABLE READ READ ONLY transaction) and from PostgreSQL's client
// alone, so that it can run on the host of the Hub next to the Hub's own node and node_modules with nothing else of this
// repository: node scripts/real/replay/export-bundle.ts --pg-host <socket dir> ... (see needs-export.md).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import pg from 'pg';
import { BUNDLE_SCHEMA, EXCLUDED_KINDS, RUN_FAMILY_KINDS, TABLE_POLICY, WITHHELD_TABLES, type BundleManifest, type BundleRow } from './submissions-bundle-format.ts';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface ExportOptions {
  database: DatabaseSettings;
  /** The Hub's object store directory (<ab>/<sha256>). */
  objectsRoot: string;
  out: string;
  /** Export records up to and including this append position. */
  cutoff: number;
  /** The runs the replay is about: their run-family records are exported, and those of the runs they name. */
  runs: readonly string[];
  /** Export the bytes of every object the exported records name, not only those of the scoped runs, the compositions and the packs. */
  allObjects?: boolean;
  /** More record kinds to leave out (named in the manifest): for a kind the dry run shows to be large and the replay does not read. */
  excludeKinds?: readonly string[];
  /** Plan only: count rows and bytes per table and kind, write nothing. */
  dryRun?: boolean;
  source?: string;
  log?: (line: string) => void;
}

const RUN_ID = /run_[0-9a-z]{26}/g;
const HEX64 = /[0-9a-f]{64}/g;
const PAGE = 200;

class JsonLines {
  readonly #stream: WriteStream;
  rows = 0;
  constructor(path: string) {
    this.#stream = createWriteStream(path, { encoding: 'utf8' });
  }
  async write(row: unknown): Promise<void> {
    this.rows += 1;
    if (!this.#stream.write(`${JSON.stringify(row)}\n`)) await new Promise<void>((resolve) => this.#stream.once('drain', resolve));
  }
  end(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stream.once('error', reject);
      this.#stream.end(resolve);
    });
  }
}

export interface DatabaseSettings { host: string; port: number; user: string; database: string; password?: string }

export async function connect(options: DatabaseSettings): Promise<pg.Client> {
  const password = options.password;
  const client = new pg.Client({
    host: options.host,
    port: options.port,
    user: options.user,
    database: options.database,
    ssl: false,
    // pg never falls back to PG* variables or a password file.
    password: async () => {
      if (password === undefined) throw new Error('the database asked for a password it was not given');
      return password;
    },
    application_name: 'circle-hub-replay-export',
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

const objectPath = (root: string, sha: string): string => join(root, sha.slice(0, 2), sha);

/** The runs the scoped runs name (predecessors, inputs, bookings), to a fixpoint; the bodies are the run records' JSON text. */
function runClosure(seed: readonly string[], bodyOf: (run: string) => string | undefined): string[] {
  const seen = new Set(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const text = bodyOf(queue.pop()!);
    if (text === undefined) continue;
    for (const found of text.match(RUN_ID) ?? []) {
      if (!seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return [...seen].sort();
}

/** Exports a bundle from a Hub database (read-only) and its object directory. Returns the manifest (also written, unless dryRun). */
export async function exportBundle(options: ExportOptions): Promise<BundleManifest> {
  const log = options.log ?? (() => {});
  const excluded = [...EXCLUDED_KINDS, ...(options.excludeKinds ?? [])];
  const client = await connect(options.database);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const present = new Set((await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.table_name));
    const notes: string[] = [];
    const withheld: BundleManifest['withheld'] = [];
    for (const table of [...present].sort()) {
      if (Object.hasOwn(TABLE_POLICY, table)) continue;
      withheld.push({ table, reason: WITHHELD_TABLES[table] ?? '没有列入导出策略' });
    }
    // Scope: the requested runs and every run their records name.
    const runBodies = new Map<string, string>();
    const loadRuns = async (ids: readonly string[]): Promise<void> => {
      const todo = ids.filter((id) => !runBodies.has(id));
      if (todo.length === 0) return;
      const found = await client.query<{ run: string; body: string }>("SELECT i.value AS run, r.body FROM record_index i JOIN records r ON r.digest=i.digest WHERE i.key='runs.id' AND r.kind='run' AND r.seq<=$2 AND i.value=ANY($1::text[])", [todo, options.cutoff]);
      for (const row of found.rows) runBodies.set(row.run, row.body);
    };
    let scoped = [...options.runs];
    for (let round = 0; round < 8; round += 1) {
      await loadRuns(scoped);
      const next = runClosure(scoped, (run) => runBodies.get(run));
      if (next.length === scoped.length) break;
      scoped = next;
    }
    const wanted = new Set(scoped);
    if ([...options.runs].some((run) => !runBodies.has(run))) notes.push(`有 ${[...options.runs].filter((run) => !runBodies.has(run)).length} 个要求的运行在库里没有找到运行记录（record_index 键 runs.id）`);
    log(`运行范围 ${wanted.size} 个（要求 ${options.runs.length} 个，其余是它们提到的前序、输入和预订运行）`);

    const manifest: BundleManifest = {
      schema: BUNDLE_SCHEMA,
      created_at: new Date().toISOString(),
      source: options.source ?? '',
      cutoff_seq: options.cutoff,
      runs: [...wanted],
      tables: {},
      kinds: {},
      objects: { count: 0, bytes: 0, missing: [] },
      withheld,
      notes,
    };
    if (options.dryRun !== true) await mkdir(join(options.out, 'tables'), { recursive: true });
    const files = new Map<string, JsonLines>();
    const sink = (table: string): JsonLines | null => {
      if (options.dryRun === true) return null;
      let file = files.get(table);
      if (file === undefined) files.set(table, (file = new JsonLines(join(options.out, 'tables', `${table}.jsonl`))));
      return file;
    };
    const count = (table: string): void => {
      manifest.tables[table] = { rows: (manifest.tables[table]?.rows ?? 0) + 1, file: `tables/${table}.jsonl` };
    };

    // records, in append order, a page at a time (keyset on seq).
    const exportedSeq = new Set<number>();
    const kindSizes = new Map<string, number>();
    // Where the bytes of objects are named: by the bodies of the scoped runs, the compositions and the packs, and through the
    // source artifacts those name (an artifact record's `sha256` is its object).
    const tokens = new Set<string>();
    const artifacts = new Map<string, string>();
    const collect = (text: string): void => {
      for (const token of text.match(HEX64) ?? []) tokens.add(token);
    };
    for (let last = 0; ; ) {
      const page = await client.query<BundleRow & { seq: string; kind: string; body: string; size: number; digest: string }>(
        `SELECT seq, id, digest, kind, schema, provenance, created_at, body, size FROM records WHERE seq>$1 AND seq<=$2 AND kind<>ALL($3::text[]) ORDER BY seq LIMIT ${PAGE}`,
        [last, options.cutoff, excluded],
      );
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        last = Number(row.seq);
        const owner = RUN_FAMILY_KINDS.includes(row.kind) ? ownerRun(row.kind, row.body, row.body.match(RUN_ID)?.[0]) : null;
        if (RUN_FAMILY_KINDS.includes(row.kind) && (owner === null || !wanted.has(owner))) continue;
        exportedSeq.add(last);
        manifest.kinds[row.kind] = (manifest.kinds[row.kind] ?? 0) + 1;
        kindSizes.set(row.kind, (kindSizes.get(row.kind) ?? 0) + row.size);
        count('records');
        await sink('records')?.write({ ...row, seq: last });
        if (row.kind === 'source_artifact') artifacts.set(row.digest, row.body);
        else if (options.allObjects === true || row.kind === 'pack_version' || row.kind === 'tree_root' || row.kind === 'run') collect(row.body);
      }
    }
    const sha256s = new Set<string>();
    for (const token of tokens) {
      sha256s.add(token);
      const artifact = artifacts.get(token);
      if (artifact !== undefined) for (const inner of artifact.match(HEX64) ?? []) sha256s.add(inner);
    }
    if (options.allObjects === true) for (const body of artifacts.values()) for (const inner of body.match(HEX64) ?? []) sha256s.add(inner);
    // The index rows belong to the exported records: keyset on (position, key, value) so no page splits a record's rows.
    for (let after: [number, string, string] = [0, '', '']; ; ) {
      const page = await client.query<BundleRow & { record_seq: string; key: string; value: string }>(
        `SELECT key, value, digest, record_seq FROM record_index WHERE (record_seq, key, value) > ($1::bigint, $2::text, $3::text) AND record_seq<=$4 ORDER BY record_seq, key, value LIMIT ${PAGE * 5}`,
        [after[0], after[1], after[2], options.cutoff],
      );
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        after = [Number(row.record_seq), row.key, row.value];
        if (!exportedSeq.has(after[0])) continue;
        count('record_index');
        await sink('record_index')?.write({ ...row, record_seq: after[0] });
      }
    }
    const digests = new Set<string>();
    for (const digest of (await client.query<{ digest: string }>('SELECT digest FROM records WHERE seq<=$1 AND kind<>ALL($2::text[])', [options.cutoff, excluded])).rows.map((r) => r.digest)) digests.add(digest);
    for (const row of (await client.query<BundleRow & { digest: string }>('SELECT kind, key, digest FROM record_keys ORDER BY kind, key')).rows) {
      if (!digests.has(row.digest)) continue;
      count('record_keys');
      await sink('record_keys')?.write(row);
    }
    // The small tables.
    for (const [table, policy] of Object.entries(TABLE_POLICY)) {
      if (policy.how !== 'full' || !present.has(table)) continue;
      const columns = policy.columns === undefined ? '*' : policy.columns.map((c) => `"${c}"`).join(', ');
      for (const row of (await client.query<BundleRow>(`SELECT ${columns} FROM public."${table}"`)).rows) {
        count(table);
        await sink(table)?.write(row);
      }
    }
    // The objects the exported records name, with their bytes.
    const known = new Map((await client.query<{ sha256: string; size: string; media_type: string; created_at: Date }>('SELECT sha256, size, media_type, created_at FROM objects')).rows.map((r) => [r.sha256, r]));
    for (const sha of [...sha256s].sort()) {
      const row = known.get(sha);
      if (row === undefined) continue;
      count('objects');
      await sink('objects')?.write({ sha256: row.sha256, size: Number(row.size), media_type: row.media_type, created_at: row.created_at.toISOString() });
      manifest.objects.count += 1;
      manifest.objects.bytes += Number(row.size);
      if (options.dryRun === true) continue;
      try {
        const target = join(options.out, 'objects', sha.slice(0, 2), sha);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(objectPath(options.objectsRoot, sha), target);
        if (sha256Hex(await readFile(target)) !== sha) throw new Error('digest');
      } catch {
        manifest.objects.missing.push(sha);
      }
    }
    await client.query('COMMIT');
    if ((options.excludeKinds ?? []).length > 0) manifest.notes.push(`按要求另外不导出的记录种类：${(options.excludeKinds ?? []).join('、')}`);
    manifest.notes.push(`记录类别大小（字节）：${[...kindSizes].sort((a, b) => b[1] - a[1]).map(([kind, size]) => `${kind} ${size}`).join('，')}`);
    for (const file of files.values()) await file.end();
    if (options.dryRun !== true) await writeFile(join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Which run a run-family record belongs to: the `run` of a run record, a validation result, a result summary; the `run` of a submission's arguments. */
export function ownerRun(kind: string, body: string, firstRun: string | undefined): string | null {
  try {
    const parsed = JSON.parse(body) as { run?: unknown; received?: { run?: unknown } };
    if (typeof parsed.run === 'string') return parsed.run;
    if (kind === 'submission' && typeof parsed.received?.run === 'string') return parsed.received.run;
  } catch {
    /* fall through to the first run id in the text */
  }
  return firstRun ?? null;
}

