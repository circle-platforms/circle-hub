// CI check behind scripts/verify-postgres.ts: boot a temporary PostgreSQL through the platform lifecycle (pinned
// binaries, socket only, peer authentication), run SELECT 1 as the application role, confirm there is no TCP listener and
// that the application role owns nothing (the database belongs to the superuser role), stop and clean up. The cluster is
// always stopped before its directory is removed, whatever failed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageOf } from './errors.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { assertApplicationRole } from './roles.ts';
import { withSession } from './sql.ts';

export interface VerifyResult {
  ok: boolean;
  version?: string;
  listen_addresses?: string;
  role?: string;
  message?: string;
}

export async function verifyPostgres(options: { parent?: string; control?: (layout: Layout) => PostgresControl } = {}): Promise<VerifyResult> {
  const root = await mkdtemp(join(options.parent ?? tmpdir(), 'chv-'));
  const layout = layoutAt(root);
  const postgres = (options.control ?? ((at: Layout) => createPostgres({ layout: at })))(layout);
  try {
    await ensureLayout(layout);
    await postgres.initialise();
    await ensureDatabaseRunning(postgres, { create: true });
    const [row] = await withSession(postgres.applicationConnector, postgres.application.database, (session) =>
      session.query("SELECT 1 AS ok, version() AS version, current_setting('listen_addresses') AS listen, current_user AS role"),
    );
    if (row?.ok !== 1) throw new Error('SELECT 1 did not return 1');
    if (row.listen !== '') throw new Error(`listen_addresses should be empty, got ${String(row.listen)}`);
    await assertApplicationRole(postgres);
    return { ok: true, version: String(row.version), listen_addresses: String(row.listen), role: String(row.role) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  } finally {
    // stop() does nothing when no server runs; a server started before the failure must not outlive its directory.
    await postgres.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
