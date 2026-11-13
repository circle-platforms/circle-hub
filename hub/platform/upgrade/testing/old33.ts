// Test-only schema from b014a713ae, before the single-baseline release.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SqlSession } from '../../sql.ts';

export interface Old33Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const OLD33_MIGRATIONS: readonly Old33Migration[] = Object.freeze(
  (JSON.parse(readFileSync(new URL('./old33-migrations.json', import.meta.url), 'utf8')) as Old33Migration[]).map(migration => Object.freeze(migration)),
);

export function old33Checksum(migration: Old33Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

/** Creates only a fresh synthetic old-release schema; this is never a runtime migrator. */
export async function createOld33Schema(session: Pick<SqlSession, 'query'>): Promise<void> {
  await session.query('BEGIN');
  try {
    await session.query(`CREATE TABLE schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of OLD33_MIGRATIONS) {
      await session.query(migration.sql);
      await session.query('INSERT INTO schema_migrations(version,name,sha256) VALUES($1,$2,$3)',
        [migration.version, migration.name, old33Checksum(migration)]);
    }
    await session.query('COMMIT');
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}
