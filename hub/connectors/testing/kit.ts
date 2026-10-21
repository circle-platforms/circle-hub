// A ready test setting for the connectors: a fresh records kit in a temporary PostgreSQL, an admin and a user, the synthetic
// system packs written to a temp directory behind a fake PacksPort, a captured admin log, an adjustable clock and a
// connectors instance (more can be made over the same records, as a restarted Hub would).
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../testing/records.ts';
import type { PackHandle } from '../../ports.ts';
import type { User } from '../../records/api.ts';
import { createConnectors, osIsolationAvailable, type Connectors, type ConnectorsOptions } from '../connectors.ts';
import type { ConnectorLogEvent } from '../http.ts';
import {
  AGILE_FUNCTIONS,
  BUILDSITE_FUNCTIONS,
  DOCSTORE_FUNCTIONS,
  PLM_FUNCTIONS,
  agileSystem,
  buildSiteSystem,
  docStoreSystem,
  fakePacks,
  plmSystem,
  writePack,
  type FakePacks,
} from './packs.ts';

export interface Clock {
  now: () => Date;
  advance(ms: number): void;
}

export function clock(start = Date.now()): Clock {
  let offset = 0;
  return { now: () => new Date(start + offset + (Date.now() - start)), advance: (ms) => void (offset += ms) };
}

export interface ConnectorKit {
  records: TestRecordsKit;
  admin: User;
  user: User;
  packs: FakePacks;
  handles: Record<'agile' | 'plm' | 'buildsite' | 'docstore', PackHandle>;
  packRoot: string;
  log: ConnectorLogEvent[];
  clock: Clock;
  connectors: Connectors;
  /** Another connectors instance over the same records (a restarted Hub), with its own options. */
  make(options?: Partial<ConnectorsOptions>): Connectors;
  /** Every stored object's bytes, for secret scans. */
  allObjects(): Promise<Buffer[]>;
  close(): Promise<void>;
}

export async function openConnectorKit(postgres: TemporaryPostgres, options: Partial<ConnectorsOptions> = {}): Promise<ConnectorKit> {
  const records = await openTestRecords({ postgres });
  const packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-connector-packs-'));
  try {
    const { user: admin } = await records.principals.bootstrapAdmin('admin');
    const user = await records.principals.createUser(admin, 'alice', 'user');
    const handles = {
      agile: await writePack(packRoot, { id: 'agile-test', system: agileSystem(), functions: AGILE_FUNCTIONS }),
      plm: await writePack(packRoot, { id: 'plm-test', system: plmSystem(), functions: PLM_FUNCTIONS }),
      buildsite: await writePack(packRoot, { id: 'buildsite-test', system: buildSiteSystem(), functions: BUILDSITE_FUNCTIONS }),
      docstore: await writePack(packRoot, { id: 'docstore-test', system: docStoreSystem(), functions: DOCSTORE_FUNCTIONS }),
    };
    const packs = fakePacks(Object.values(handles));
    const log: ConnectorLogEvent[] = [];
    const time = clock();
    const requireOsIsolation = await osIsolationAvailable();
    const make = (extra: Partial<ConnectorsOptions> = {}): Connectors =>
      createConnectors({
        records,
        packs,
        now: time.now,
        log: (event) => void log.push(event),
        sandbox: { requireOsIsolation },
        resourceCacheMs: 0,
        ...options,
        ...extra,
      });
    return {
      records,
      admin,
      user,
      packs,
      handles,
      packRoot,
      log,
      clock: time,
      connectors: make(),
      make,
      async allObjects() {
        const out: Buffer[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else out.push(await readFile(path));
          }
        };
        await walk(join(records.dataDir, 'objects'));
        return out;
      },
      async close() {
        await records.close();
        await rm(packRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await records.close();
    await rm(packRoot, { recursive: true, force: true });
    throw error;
  }
}
