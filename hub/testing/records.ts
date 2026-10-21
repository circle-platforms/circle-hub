// A ready RecordsKit for tests: a fresh database (in a given temporary cluster, or in its own), a temp data directory and a
// FileKeyProvider whose key is created explicitly. close() removes all of it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { DatabaseConfig, Limits } from '../config/index.ts';
import { FileKeyProvider, openRecords } from '../records/index.ts';
import type { RecordsKit } from '../records/index.ts';
import { startPostgres } from './postgres.ts';
import type { TemporaryPostgres } from './postgres.ts';

export interface TestRecordsOptions {
  /** Cluster to create the database in; without one, the kit starts and stops its own. */
  postgres?: TemporaryPostgres;
  now?: () => Date;
  limits?: Partial<Limits>;
  /** Create the vault key (default true). */
  initKey?: boolean;
}

export interface TestRecordsKit extends RecordsKit {
  dataDir: string;
  database: DatabaseConfig;
  keyProvider: FileKeyProvider;
  postgres: TemporaryPostgres;
}

export async function openTestRecords(options: TestRecordsOptions = {}): Promise<TestRecordsKit> {
  const owned = options.postgres === undefined;
  const postgres = options.postgres ?? (await startPostgres());
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-records-'));
  let database: DatabaseConfig | undefined;
  try {
    database = await postgres.createDatabase();
    const keyProvider = new FileKeyProvider(join(dataDir, 'test-vault.key'));
    if (options.initKey !== false) await keyProvider.initKey();
    const kit = await openRecords(
      { dataDir, logDir: join(dataDir, 'logs'), database, limits: { ...DEFAULT_LIMITS, ...options.limits } },
      { keyProvider, now: options.now },
    );
    const created = database;
    let closing: Promise<void> | undefined;
    return {
      ...kit,
      dataDir,
      database: created,
      keyProvider,
      postgres,
      close: () =>
        (closing ??= (async () => {
          await kit.close();
          await postgres.dropDatabase(created.database).catch(() => {});
          if (owned) await postgres.stop();
          await rm(dataDir, { recursive: true, force: true });
        })()),
    };
  } catch (error) {
    if (database !== undefined) await postgres.dropDatabase(database.database).catch(() => {});
    if (owned) await postgres.stop();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
