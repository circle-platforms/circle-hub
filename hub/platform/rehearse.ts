// Rehearsal of backup and restore in a throwaway data root: init, write synthetic records and objects, back up, destroy,
// restore, and compare row counts, table digests and file digests. The synthetic tables are set up as the Hub's are: the
// superuser role creates them (identity column, append-only trigger) and grants the application role SELECT and INSERT,
// and the rows are written as the application role. After the restore the application role must hold the same
// privileges, own nothing and still be refused (42501) every statement that deletes or rewrites history or the tables.
// The root also holds read-only extracted pack trees, as the server's registry leaves them: they must stay out of the
// backup and come through the destroy and the restore untouched. It never touches the real data root.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import { keychainStore, VAULT_KEY_ITEM, OPERATOR_TOKEN_ITEM } from './keychain.ts';
import { createBackup } from './backup.ts';
import { PlatformError } from './errors.ts';
import { exists, listFiles, removeTree, removeWithin, sha256File, sha256Text } from './files.ts';
import { ensureLayout, layoutAt, SOCKET_PATH_LIMIT, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { restoreBackup, setAsideVault } from './restore.ts';
import { comparePrivileges, grantTables, rolePrivileges, roleProblems, tamperingStatements, unrefusedStatements, unrefusedText } from './roles.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { compareSummaries, summarizeTables, withSession, type SqlSession } from './sql.ts';

export interface RehearsalOptions {
  /** Directory that receives the throwaway data root; default the system temporary directory. */
  parent?: string;
  libpqBin?: string;
  /** Override only to exercise an unavailable security tool. */
  security?: string;
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
  /** Files of the synthetic extracted pack trees: never in the backup, untouched by the destroy and the restore. */
  packFiles: number;
  /** The application role and how many privileges it held before and after. */
  role: string;
  privileges: number;
  /** Statements that delete or rewrite history or the tables, refused to the application role after the restore. */
  refused: number;
  ok: boolean;
  differences: string[];
  seconds: number;
  keyLoss: { skipped: boolean; reason?: string; items: number; backupHits: number; remaining: number; setAsideFiles: number };

}

const MARKER = '.circle-hub-rehearsal';
const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';
const TABLES = ['rehearsal_records', 'rehearsal_index'];

function syntheticId(): string {
  const bytes = randomBytes(26);
  let out = 'rcd_';
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

/** As the superuser role, which owns the Hub database: the tables, their append-only triggers and the grants. */
async function createSyntheticTables(session: SqlSession, role: string): Promise<void> {
  await session.query('BEGIN');
  await session.query(`CREATE FUNCTION rehearsal_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP;
    END
    $fn$`);
  await session.query(`CREATE TABLE rehearsal_records (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id text NOT NULL UNIQUE,
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
  for (const table of TABLES) {
    await session.query(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION rehearsal_append_only()`);
  }
  await grantTables(session, role, TABLES);
  await session.query('COMMIT');
}

/** As the application role, like the server: INSERT only. */
async function writeSyntheticRecords(session: SqlSession, count: number): Promise<void> {
  await session.query('BEGIN');
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

/** Writes a read-only tree as the registry does: files 0400, then every directory 0500, deepest first. */
async function readOnlyTree(dir: string, files: Record<string, string>, topMode: number): Promise<number> {
  await mkdir(dir, { mode: 0o700 });
  const directories = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join('/'));
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ...parts), text, { flag: 'wx', mode: 0o400 });
  }
  for (const path of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) await chmod(join(dir, ...path.split('/')), 0o500);
  await chmod(dir, topMode);
  return Object.keys(files).length;
}

/**
 * Synthetic extracted packs in `packs/`, shaped as the server's pack registry leaves them: a verified tree per pack
 * digest (directories 0500, files 0400), a tree it moved to `.quarantine` (top directory made writable to move it) and a
 * tree still being built under `.tmp-`. Returns the number of files.
 */
export async function writeSyntheticPacks(layout: Layout): Promise<number> {
  const manifest = `${JSON.stringify({ name: 'rehearsal-pack', version: '1.0.0', note: '合成的解包目录，只用于演练' })}\n`;
  const digest = sha256Text(manifest);
  const files = { 'pack.json': manifest, 'functions/identity.ts': 'export default function (input: unknown): unknown {\n  return input;\n}\n' };
  await mkdir(layout.packs, { recursive: true, mode: 0o700 });
  let written = await readOnlyTree(join(layout.packs, digest), files, 0o500);
  await mkdir(join(layout.packs, '.quarantine'), { mode: 0o700 });
  written += await readOnlyTree(join(layout.packs, '.quarantine', `${digest}-1767225600000-${randomBytes(4).toString('hex')}`), files, 0o700);
  written += await readOnlyTree(join(layout.packs, `.tmp-${digest}-${randomBytes(6).toString('hex')}`), { 'pack.json': manifest }, 0o700);
  return written;
}

/** Every entry under `dir` with its kind, mode and, for files, SHA-256; links are not followed. */
export async function treeEntries(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current === dir) return;
      throw error;
    }
    for (const name of names.sort()) {
      const path = join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8).padStart(4, '0');
      if (info.isDirectory()) {
        out.set(relative, `目录 ${mode}`);
        await walk(path, relative);
      } else {
        out.set(relative, info.isFile() ? `文件 ${mode} ${(await sha256File(path)).sha256}` : `其他 ${mode}`);
      }
    }
  };
  await walk(dir, '');
  return out;
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

/** Differences of the extracted pack trees (treeEntries) before the backup and after the restore. */
function compareEntries(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, entry] of before) {
    const got = after.get(path);
    if (got === undefined) out.push(`解包目录少了 ${path}`);
    else if (got !== entry) out.push(`解包目录的 ${path} 变了（原来是${entry}，现在是${got}）`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`解包目录多了 ${path}`);
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
  const security = options.security ?? '/usr/bin/security';
  const keychain = join(root, 'synthetic.keychain-db');
  const available = await access(security).then(() => true, () => false);
  const keyLoss: RehearsalReport['keyLoss'] = { skipped: !available, ...(!available ? { reason: '跳过，不算通过：security 不可用' } : {}), items: 0, backupHits: 0, remaining: 0, setAsideFiles: 0 };
  // No security invocation can reach a default keychain, even on failure or cleanup.
  const guarded: CommandRunner = async (command, args, options = {}) => {
    if (command !== security || !(args.at(-1) === keychain || (args[0] === '-i' && (options.input ?? '').trimEnd().endsWith(`"${keychain}"`)))) throw new PlatformError('演练拒绝未指定临时钥匙串文件的调用');
    const result = await runner(command, args, options);
    if (result.code !== 0 && result.code !== 44) throw new PlatformError('临时钥匙串调用失败');
    return result;
  };
  const service = `circle-hub-rehearsal-${randomBytes(12).toString('hex')}`;
  const stores = [VAULT_KEY_ITEM, OPERATOR_TOKEN_ITEM].map((item, i) => keychainStore({ runner: guarded, security, keychain, service, account: i === 0 ? 'vault-master-key' : 'operator-token', item }));
  const secretBytes: Uint8Array[] = [];

  try {
    await ensureLayout(layout);
    await writeSettingsFile(layout, newSettingsFile({ environment: 'test' }));
    running = control();
    await running.initialise();
    await ensureDatabaseRunning(running, { create: true });
    const database = running.target.database;
    const role = running.application.user;
    await withSession(running.connector, database, (session) => createSyntheticTables(session, role));
    await withSession(running.applicationConnector, database, (session) => writeSyntheticRecords(session, options.records ?? 200));
    const written = await writeSyntheticFiles(layout, options.objects ?? 20);
    const packFiles = await writeSyntheticPacks(layout);
    if (available) {
      const password = randomBytes(24).toString('hex');
      for (const args of [['create-keychain', '-p', password, keychain], ['unlock-keychain', '-p', password, keychain], ['set-keychain-settings', keychain]]) await guarded(security, args);
      for (const store of stores) { await store.init(); secretBytes.push(await store.read()); }
      keyLoss.items = stores.length;
    }
    const before = await withSession(running.connector, database, async (session) => ({ tables: await summarizeTables(session), privileges: await rolePrivileges(session, role) }));
    const filesBefore = await fileDigests(layout);
    const packsBefore = await treeEntries(layout.packs);
    const { dir: backup, manifest } = await createBackup({ layout, postgres: running, runner, now, label: 'rehearsal', ...(options.libpqBin ? { libpqBin: options.libpqBin } : {}) });
    const keyDifferences: string[] = [];
    if (available) {
      for (const path of await listFiles(backup)) {
        const bytes = await readFile(join(backup, path));
        for (const value of secretBytes) {
          const hex = Buffer.from(value).toString('hex');
          for (const encoding of [Buffer.from(value), Buffer.from(hex), Buffer.from(hex.toUpperCase())]) {
            let from = 0;
            while ((from = bytes.indexOf(encoding, from)) >= 0) { keyLoss.backupHits++; keyDifferences.push('备份文件含钥匙串项的值，不能采用'); from += encoding.length; }
          }
        }
      }
    }
    const packsInBackup = manifest.files.filter((file) => file.path.startsWith('packs/')).map((file) => `备份里不该有解包目录的文件 ${file.path}`);

    await running.stop();
    running = undefined;
    if (available) for (const store of stores) await store.delete();
    // packs/ stays, as after a failed deploy sets the data aside: derived data that a restore leaves as it is.
    for (const area of ['db', 'objects', 'vault'] as const) await removeWithin(root, layout[area]);

    running = control();
    await restoreBackup({ layout, backupDir: backup, postgres: running, runner, now, ...(options.libpqBin ? { libpqBin: options.libpqBin } : {}) });
    const after = await withSession(running.connector, database, async (session) => ({
      tables: await summarizeTables(session),
      privileges: await rolePrivileges(session, role),
      problems: await roleProblems(session, role),
    }));
    const filesAfter = await fileDigests(layout);
    const packsAfter = await treeEntries(layout.packs);
    const statements = [...new Set(TABLES.flatMap((table) => tamperingStatements(table)))];
    const unrefused = await withSession(running.applicationConnector, database, (session) => unrefusedStatements(session, statements));
    if (available) {
      for (const store of stores) if ((await store.status()).present) keyLoss.remaining++;
      if (keyLoss.remaining > 0) keyDifferences.push('丢失后仍找到钥匙串项');
      keyLoss.setAsideFiles = (await setAsideVault(layout,now())).files;
      await stores[0].init();
    }
    const differences = [
      ...keyDifferences,
      ...compareSummaries(before.tables, after.tables),
      ...compareFiles(filesBefore, filesAfter),
      ...packsInBackup,
      ...compareEntries(packsBefore, packsAfter),
      ...comparePrivileges(before.privileges, after.privileges).map((line) => `应用角色 ${role} 的权限${line}`),
      ...after.problems.map((problem) => `应用角色 ${role} ${problem}`),
      ...unrefusedText(unrefused),
    ];
    return {
      root,
      keyLoss,
      kept: options.keep === true,
      backup,
      tables: after.tables.length,
      rows: after.tables.reduce((sum, table) => sum + table.rows, 0),
      objects: written.objects,
      vaultFiles: written.vault,
      packFiles,
      role,
      privileges: after.privileges.length,
      refused: statements.length - unrefused.length,
      ok: differences.length === 0,
      differences,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    for (const bytes of secretBytes) bytes.fill(0);
    let cleanupFailed = false;
    if (available) {
      try { await guarded(security, ['delete-keychain', keychain]); }
      catch { cleanupFailed = true; }
      finally { await rm(keychain, { force: true }); }
    }
    if (running) await running.stop().catch(() => {});
    if (!options.keep) {
      if (!(await exists(join(root, MARKER)))) throw new PlatformError(`演练数据根缺少标记文件，不删除：${root}`);
      // The extracted pack trees are read-only: their directories are made writable first.
      await removeTree(root);
    }
    if (cleanupFailed) throw new PlatformError('临时钥匙串清理失败，文件已删除');
  }
}
