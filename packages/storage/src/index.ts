import pg from 'pg';
import type { PoolClient } from 'pg';
import { sha256 } from '../../contracts/src/index.ts';

export type Transaction = PoolClient;
export interface Migration { version: number; name: string; sql: string }
export class Store {
  pool: pg.Pool;
  constructor(config: pg.PoolConfig) { this.pool = new pg.Pool(config); }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try { await tx.query('BEGIN'); const value = await fn(tx); await tx.query('COMMIT'); return value; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  async migrate(migrations: Migration[]): Promise<void> {
    await this.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(962001)');
      // Only the journal bootstrap is conditional; business DDL is versioned and checksummed.
      await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = (await tx.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      if (applied.some(row => !migrations.some(migration => migration.version === row.version))) throw new Error('Database has an unsupported migration');
      for (const migration of migrations) {
        const digest = sha256(migration.sql); const old = applied.find(row => row.version === migration.version);
        if (old) { if (old.sha256 !== digest || old.name !== migration.name) throw new Error('Applied migration checksum mismatch'); continue; }
        await tx.query(migration.sql);
        await tx.query('INSERT INTO schema_migrations(version,name,sha256) VALUES($1,$2,$3)', [migration.version, migration.name, digest]);
      }
    });
  }
}
