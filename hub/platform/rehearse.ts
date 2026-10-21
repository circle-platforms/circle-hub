// Rehearsal of backup and restore in a throwaway data root: init, write synthetic records and objects, back up, destroy,
// restore, and compare row counts, table digests and file digests. It never touches the real data root.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import { createBackup } from './backup.ts';
import { PlatformError } from './errors.ts';
import { exists, listFiles, removeWithin, sha256File, sha256Text } from './files.ts';
import { ensureLayout, layoutAt, SOCKET_PATH_LIMIT, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { restoreBackup } from './restore.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { compareSummaries, summarizeTables, withSession, type SqlSession } from './sql.ts';

export interface RehearsalOptions {
  /** Directory that receives the throwaway data root; default the system temporary directory. */
  parent?: string;
  libpqBin?: string;
  runner?: CommandRunner;
  binariesRoot?: string;
  records?: number;
  objects?: number;
  /** Keep the throwaway data root for inspection. */
  keep?: boolean;
  now?: () => Date;
}

export interface RehearsalReport {
  root: string;
  kept: boolean;
  backup: string;
  tables: number;
  rows: number;
  objects: number;
  vaultFiles: number;
  ok: boolean;
  differences: string[];
  seconds: number;
}

const MARKER = '.circle-hub-rehearsal';
const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

function syntheticId(): string {
  const bytes = randomBytes(26);
  let out = 'rcd_';
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

async function writeSyntheticRecords(session: SqlSession, count: number): Promise<void> {
  await session.query('BEGIN');
  await session.query(`CREATE TABLE rehearsal_records (
      id text PRIMARY KEY,
      kind text NOT NULL,
      digest text NOT NULL,
      created_at timestamptz NOT NULL,
      body jsonb NOT NULL,
      amount numeric NOT NULL,
      ratio double precision NOT NULL,
      raw bytea NOT NULL)`);
  await session.query(`CREATE TABLE rehearsal_index (
      record_id text NOT NULL REFERENCES rehearsal_records (id),
      key text NOT NULL,
      value text NOT NULL,
      PRIMARY KEY (record_id, key))`);
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let n = 0; n < count; n++) {
    const id = syntheticId();
    const body = { n, text: `合成记录 ${n}：含 "引号"、换行\n与 emoji 🧪`, nested: { list: [n, n * 2, null], flag: n % 2 === 0 } };
    await session.query(
      'INSERT INTO rehearsal_records (id, kind, digest, created_at, body, amount, ratio, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        id,
        RECORD_KINDS[n % RECORD_KINDS.length],
        sha256Text(JSON.stringify(body)),
        new Date(start + n * 1001).toISOString(),
        JSON.stringify(body),
        `${randomInt(1, 2 ** 40)}.${String(n).padStart(9, '0')}`,
        n / 7,
        randomBytes(randomInt(0, 64)),
      ],
    );
    if (n % 3 === 0) {
      await session.query('INSERT INTO rehearsal_index (record_id, key, value) VALUES ($1, $2, $3)', [id, 'kind', RECORD_KINDS[n % RECORD_KINDS.length]]);
    }
  }
  await session.query('COMMIT');
}

/** Content-addressed synthetic objects (objects/<2 hex>/<sha256>) and a few opaque vault files. */
async function writeSyntheticFiles(layout: Layout, objects: number): Promise<{ objects: number; vault: number }> {
  let written = 0;
  for (let n = 0; n < objects; n++) {
    const bytes = randomBytes(randomInt(1, 64 * 1024));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const dir = join(layout.objects, digest.slice(0, 2));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, digest), bytes, { flag: 'wx', mode: 0o600 });
    written++;
  }
  const vault = 3;
  for (let n = 0; n < vault; n++) await writeFile(join(layout.vault, `entry-${n}.bin`), randomBytes(96), { flag: 'wx', mode: 0o600 });
  return { objects: written, vault };
}

async function fileDigests(layout: Layout): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const area of ['objects', 'vault'] as const) {
    for (const path of await listFiles(layout[area])) out.set(`${area}/${path}`, (await sha256File(join(layout[area], path))).sha256);
  }
  return out;
}

function compareFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, digest] of before) {
    const got = after.get(path);
    if (got === undefined) out.push(`缺少文件 ${path}`);
    else if (got !== digest) out.push(`文件 ${path} 内容不同`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`多出文件 ${path}`);
  return out;
}

export async function rehearse(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const started = Date.now();
  const runner = options.runner ?? runCommand;
  const now = options.now ?? (() => new Date());
  // A short prefix keeps the socket path under the 103-byte limit; a very long temporary directory falls back to /tmp.
  const longest = (parent: string) => Buffer.byteLength(join(parent, 'chr-XXXXXX', 'run', '.s.PGSQL.65535'));
  const parent = options.parent ?? (longest(tmpdir()) <= SOCKET_PATH_LIMIT ? tmpdir() : '/tmp');
  const root = await mkdtemp(join(parent, 'chr-'));
  await writeFile(join(root, MARKER), 'circle-hub rehearsal data root; safe to delete\n', { mode: 0o600 });
  const layout = layoutAt(root);
  const control = (): PostgresControl => createPostgres({ layout, runner, ...(options.binariesRoot ? { binariesRoot: options.binariesRoot } : {}) });
  let running: PostgresControl | undefined;
  try {
    await ensureLayout(layout);
    await writeSettingsFile(layout, newSettingsFile({ environment: 'test' }));
    running = control();
    await running.initialise();
    await ensureDatabaseRunning(running, { create: true });
    const database = running.target.database;
    // Written as the application role, like the server's own tables.
    await withSession(running.applicationConnector, database, (session) => writeSyntheticRecords(session, options.records ?? 200));
    const written = await writeSyntheticFiles(layout, options.objects ?? 20);
    const tablesBefore = await withSession(running.connector, database, summarizeTables);
    const filesBefore = await fileDigests(layout);
    const { dir: backup } = await createBackup({ layout, postgres: running, runner, now, label: 'rehearsal', ...(options.libpqBin ? { libpqBin: options.libpqBin } : {}) });

    await running.stop();
    running = undefined;
    for (const area of ['db', 'objects', 'vault'] as const) await removeWithin(root, layout[area]);

    running = control();
    await restoreBackup({ layout, backupDir: backup, postgres: running, runner, now, ...(options.libpqBin ? { libpqBin: options.libpqBin } : {}) });
    const tablesAfter = await withSession(running.connector, database, summarizeTables);
    const filesAfter = await fileDigests(layout);
    const differences = [...compareSummaries(tablesBefore, tablesAfter), ...compareFiles(filesBefore, filesAfter)];
    return {
      root,
      kept: options.keep === true,
      backup,
      tables: tablesAfter.length,
      rows: tablesAfter.reduce((sum, table) => sum + table.rows, 0),
      objects: written.objects,
      vaultFiles: written.vault,
      ok: differences.length === 0,
      differences,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    if (running) await running.stop().catch(() => {});
    if (!options.keep) {
      if (!(await exists(join(root, MARKER)))) throw new PlatformError(`演练数据根缺少标记文件，不删除：${root}`);
      await rm(root, { recursive: true, force: true });
    }
  }
}
