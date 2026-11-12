// A ready RecordsKit for tests: a fresh database (in a given temporary cluster, or in its own), a temp data directory and a
// FileKeyProvider whose key is created explicitly. close() removes all of it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { DatabaseConfig, Limits } from '../config/index.ts';
import { FileKeyProvider, openRecords } from '../records/index.ts';
import type { RecordsKit } from '../records/index.ts';
import { CREDENTIAL_SCANNER, RECORD_SCHEMAS, digestOf, scanAcceptanceKey, scanDigest, scanForCredentials, sha256Hex } from '../records/api.ts';
import type { AuthorizationRecord, Principal, SourceArtifact, SourceArtifactBody, Visibility } from '../records/api.ts';
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

/** A business-system read as an older Hub stored it, for the tests of how such records are still read (issue 194). */
export interface LegacyReadInput {
  bytes: Uint8Array;
  mediaType: string;
  /** The business-system object the answer was read from. */
  object: string;
  visibility: Visibility;
  capturedAt?: string;
}

/**
 * A read an older Hub held: before decisions 154 and 161 the detectors of credential-scan@3 scanned every answer, and an
 * answer they flagged was stored retain_only although model_readable was asked for. No running Hub writes such a record
 * any more; it is written here as one more append-only record, with the stored object and the index entries ingest gave
 * it. The bytes must be ones those detectors flag.
 */
export async function storeLegacyHeld(kit: RecordsKit, input: LegacyReadInput): Promise<SourceArtifact> {
  const bytes = Uint8Array.from(input.bytes), sha256 = sha256Hex(bytes), scan = scanForCredentials(bytes);
  if (scan.scanner !== CREDENTIAL_SCANNER || scan.findings.length === 0) throw new TypeError('a held legacy read needs bytes the detectors of credential-scan@3 flag');
  const origin = { read: { object: input.object } }, author = { user: null };
  const body: SourceArtifactBody = {
    sha256, size: bytes.byteLength, media_type: input.mediaType, name: null, origin, author,
    captured_at: input.capturedAt ?? '2026-11-01T00:00:00.000Z', provenance_type: 'observed',
    read_tier: 'retain_only', requested_read_tier: 'model_readable', visibility: input.visibility, scan,
  };
  const dedupe = digestOf({ sha256, media_type: input.mediaType, name: null, origin, author, provenance_type: 'observed', read_tier: 'retain_only', visibility: input.visibility });
  await kit.objects.put(bytes, input.mediaType);
  return kit.store.put<SourceArtifactBody>({
    kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: 'observed', body, created_at: body.captured_at,
    index: [
      { key: 'artifact.sha256', value: sha256 },
      { key: 'artifact.dedupe', value: dedupe },
      ...input.visibility.readers.map((reader) => ({ key: 'artifact.reader', value: reader })),
      ...input.visibility.packs.map((pack) => ({ key: 'artifact.pack', value: pack })),
      { key: 'artifact.object', value: input.object },
    ],
  });
}

/**
 * The acceptance an older Hub recorded when an administrator accepted the findings of held bytes (README decision 18):
 * the resource setting `scan:<sha256>` bound to the digest of their scan. Reads still honour it (decision 161).
 */
export function storeLegacyAcceptance(kit: RecordsKit, admin: Principal, held: SourceArtifact): Promise<AuthorizationRecord> {
  return kit.authorizations.configureResource(admin, scanAcceptanceKey(held.body.sha256), scanDigest(held.body.scan), '合成：旧版本接受的误报');
}
