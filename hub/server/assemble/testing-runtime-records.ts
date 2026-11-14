// A production assembly receives a real least-privilege records connection, never its migration owner's connection.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Database, createPool, migrateRecords, openRecords, type RecordsKit } from '../../records/api.ts';
import { openTestRecords, type TestRecordsKit, type TestRecordsOptions } from '../../testing/records.ts';

export async function openAssemblyRuntimeRecords(options: TestRecordsOptions): Promise<TestRecordsKit> {
  const ownerKit = await openTestRecords(options);
  let runtimeKit: RecordsKit | undefined;
  try {
    const role = 'assembly_runtime_' + randomBytes(5).toString('hex');
    const owner = new Database(createPool(ownerKit.database, 1));
    try {
      await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER`);
      if (ownerKit.database.password !== undefined) {
        const statement = (await owner.query<{ statement: string }>("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS statement", [role, ownerKit.database.password])).rows[0].statement;
        await owner.query(statement);
      }
      const revoke = (await owner.query<{ statement: string }>("SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',$1::text) AS statement", [ownerKit.database.database])).rows[0].statement;
      await owner.query(revoke);
      await migrateRecords({ database: ownerKit.database }, { runtimeRole: role });
    } finally { await owner.end(); }
    const database = { ...ownerKit.database, user: role };
    runtimeKit = await openRecords({ dataDir: ownerKit.dataDir, logDir: join(ownerKit.dataDir, 'logs'), database, limits: { ...ownerKit.config.limits } }, { migrate: false, keyProvider: ownerKit.keyProvider, ...(options.now ? { now: options.now } : {}) });
    const opened = runtimeKit;
    let closing: Promise<void> | undefined;
    return {
      ...opened, dataDir: ownerKit.dataDir, database, keyProvider: ownerKit.keyProvider, postgres: ownerKit.postgres,
      close: () => closing ??= (async () => { try { await opened.close(); } finally { await ownerKit.close(); } })(),
    };
  } catch (error) {
    try { await runtimeKit?.close(); } finally { await ownerKit.close(); }
    throw error;
  }
}
