// Test kit of the system packs: a records kit in a temporary PostgreSQL, an admin and a user, the system packs of this
// package staged exactly as published (pack.json and the files it lists) behind a PacksPort, a captured admin log and the
// real connectors. Reads run the packs' functions in the real sandbox against loopback stubs serving tests/fixtures.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRole } from '../../../contracts/generated/vocabulary.ts';
import { createConnectors, osIsolationAvailable, type Connectors, type ConnectorLogEvent } from '../../../hub/connectors/api.ts';
import { fakePacks, type FakePacks } from '../../../hub/connectors/testing/api.ts';
import { createTestParserRegistry } from '../../../hub/testing/parsers.ts';
import type { PackHandle } from '../../../hub/ports.ts';
import type { Principal } from '../../../hub/records/api.ts';
import { manifestDigest } from '../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { PACK_DIRECTORIES, readManifest, stagePack } from '../../workflow/case-review/packaging.ts';

export interface SystemKit {
  records: TestRecordsKit;
  admin: Principal;
  user: Principal;
  packs: FakePacks;
  handles: Record<string, PackHandle>;
  connectors: Connectors;
  log: ConnectorLogEvent[];
  close(): Promise<void>;
}

/** Stages a pack of this package into `root` and returns its handle (digest of the canonical manifest, as the registry computes it). */
export async function stagedHandle(root: string, id: string): Promise<PackHandle> {
  const directory = await stagePack(PACK_DIRECTORIES[id], join(root, id));
  const manifest = await readManifest(directory);
  return { id: manifest.id, version: manifest.version, digest: manifestDigest(manifest), kind: manifest.kind, directory };
}

export async function openSystemKit(postgres: TemporaryPostgres, ids: readonly string[]): Promise<SystemKit> {
  const records = await openTestRecords({ postgres });
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-system-packs-'));
  try {
    const { user: admin } = await records.principals.bootstrapAdmin('admin');
    const user = await records.principals.createUser(admin, 'reader', 'user');
    const handles: Record<string, PackHandle> = {};
    for (const id of ids) handles[id] = await stagedHandle(root, id);
    const packs = fakePacks(Object.values(handles));
    const log: ConnectorLogEvent[] = [];
    const connectors = createConnectors({
      records,
      packs,
      parsers: createTestParserRegistry(),
      log: (event) => void log.push(event),
      sandbox: { requireOsIsolation: await osIsolationAvailable() },
      resourceCacheMs: 0,
    });
    const principal = (u: { id: string; name: string; role: PermissionRole }): Principal => ({ id: u.id, name: u.name, role: u.role });
    return {
      records,
      admin: principal(admin),
      user: principal(user),
      packs,
      handles,
      connectors,
      log,
      async close() {
        await records.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await records.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** The bytes of an artifact a read returned, read as the admin (system reads are visible to the reader and admins). */
export async function artifactBytes(kit: SystemKit, sha256: string): Promise<Uint8Array> {
  const source = await kit.records.artifacts.source(kit.admin, sha256, { consumer: 'function' });
  if (source === null || source.bytes === null) throw new Error(`artifact ${sha256} is not readable`);
  return source.bytes;
}
