// Source artifacts (B02): content-addressed bytes plus a `source_artifact@1` record with provenance, author, capture time,
// provenance type, read tier, visibility and the credential scan conclusion. An upload with a credential hit is refused
// whole (B02 R[4]); a read or generated artifact with a hit is kept at read tier retain_only. Readers get bytes only through
// source(), which applies the read tier (B02 F[5]): retain_only bytes are never handed out, function_bytes_only bytes only
// to functions. Every read re-reads the account, and a share covers the one record it names (B04 R[3]).
import { PackId, RunId, UserId } from '../../contracts/src/common.ts';
import { ExternalObjectId } from '../../contracts/src/reference.ts';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { isProducerKind, isProvenanceType, isReadTier, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { PermissionRole, ProducerKind, ReadTier } from '../../contracts/generated/vocabulary.ts';
import type {
  ActionBody,
  ArtifactAuthor,
  ArtifactOrigin,
  ArtifactSource,
  ArtifactText,
  Artifacts,
  Authorizations,
  CredentialScan,
  IndexEntry,
  IngestInput,
  ObjectStore,
  Page,
  Principal,
  RecordStore,
  SourceArtifact,
  SourceArtifactBody,
  Visibility,
} from './api.ts';
import { RECORD_SCHEMAS, artifactShareKey } from './constants.ts';
import { normalizeTime } from './db.ts';
import type { Database } from './db.ts';
import { digestOf, isSha256, sha256Hex } from './digest.ts';
import { IntegrityError, LimitError, RecordsError } from './errors.ts';
import { isMediaType } from './objects.ts';
import { scanForCredentials } from './scan.ts';
import { MAX_INDEX_VALUE_BYTES, validateIndex } from './store.ts';
import { textPreview } from './text.ts';

const VERSIONED = /^[a-z][a-z0-9_.-]*@[0-9]+$/;
const SHORT = /^[\x21-\x7e]{1,200}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;
/** Named readers and packs per artifact; with the other entries this stays inside the store's 200 index entries. */
const MAX_AUDIENCE = 64;
/** Namespace of the per-content advisory locks that make a repeated ingest return the first record. */
const INGEST_LOCK_SPACE = 730_157;
const MODEL_READABLE: ReadTier = 'model_readable';
const FUNCTION_BYTES_ONLY: ReadTier = 'function_bytes_only';
const RETAIN_ONLY: ReadTier = 'retain_only';
const ADMIN: PermissionRole = 'admin';
const MODEL: ProducerKind = 'model';
const FUNCTION: ProducerKind = 'function';

function text(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Cc}/u.test(value) || !value.isWellFormed()) {
    throw new TypeError(`${field} must be 1 to ${max} characters without control characters`);
  }
  return value;
}

function short(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SHORT.test(value)) throw new TypeError(`${field} must be printable ASCII, at most 200 characters`);
  return value;
}

function validOrigin(origin: ArtifactOrigin): ArtifactOrigin {
  const members = typeof origin === 'object' && origin !== null ? Object.keys(origin) : [];
  if (members.length !== 1) throw new TypeError('origin must have exactly one of read, upload or generated');
  if ('read' in origin) {
    const read = origin.read;
    if (!ExternalObjectId.safeParse(read?.object).success) throw new TypeError('origin.read.object must be system:type:id[@revision]');
    // The object id is an index value (artifact.object).
    if (Buffer.byteLength(read.object, 'utf8') > MAX_INDEX_VALUE_BYTES) throw new TypeError(`origin.read.object is at most ${MAX_INDEX_VALUE_BYTES} bytes`);
    const action = read.action ?? null;
    if (action !== null && !isSha256(action)) throw new TypeError('origin.read.action must be a record digest');
    return { read: { object: read.object, resource: short(read.resource, 'origin.read.resource'), action } };
  }
  if ('upload' in origin) {
    const upload = origin.upload;
    return { upload: { session: short(upload?.session, 'origin.upload.session'), message: short(upload?.message, 'origin.upload.message') } };
  }
  if ('generated' in origin) {
    const generated = origin.generated;
    if (typeof generated?.generator !== 'string' || !VERSIONED.test(generated.generator)) throw new TypeError('origin.generated.generator must be name@major');
    if (!Array.isArray(generated.inputs) || generated.inputs.length > 200 || generated.inputs.some((input) => typeof input !== 'string' || input.length === 0 || input.length > 600)) {
      throw new TypeError('origin.generated.inputs must be references');
    }
    const readBack = generated.read_back ?? null;
    if (readBack !== null && !isSha256(readBack)) throw new TypeError('origin.generated.read_back must be a digest');
    return { generated: { generator: generated.generator, inputs: [...generated.inputs], read_back: readBack } };
  }
  throw new TypeError('origin must have exactly one of read, upload or generated');
}

function validAuthor(author: ArtifactAuthor): ArtifactAuthor {
  const user = author?.user ?? null;
  if (user !== null && !UserId.safeParse(user).success) throw new TypeError('author.user must be a user id');
  return { user, declared: text(author?.declared, 'author.declared', 200) };
}

function validVisibility(visibility: Visibility, origin: ArtifactOrigin): Visibility {
  const readers = visibility?.readers;
  const packs = visibility?.packs;
  if (!Array.isArray(readers) || readers.length > MAX_AUDIENCE || readers.some((reader) => !UserId.safeParse(reader).success)) {
    throw new TypeError(`visibility.readers must be at most ${MAX_AUDIENCE} user ids`);
  }
  if (!Array.isArray(packs) || packs.length > MAX_AUDIENCE || packs.some((pack) => !PackId.safeParse(pack).success)) {
    throw new TypeError(`visibility.packs must be at most ${MAX_AUDIENCE} pack ids`);
  }
  if (typeof visibility.admins !== 'boolean' || typeof visibility.shareable !== 'boolean') throw new TypeError('visibility.admins and visibility.shareable are booleans');
  // B04 R[3]: what a connector read can never be shared; and nothing admins may not read can be shared by them.
  if (visibility.shareable && 'read' in origin) throw new TypeError('artifacts read through a connector are never shareable');
  if (visibility.shareable && !visibility.admins) throw new TypeError('only artifacts admins may read can be shareable');
  return { readers: [...new Set(readers)].sort(), admins: visibility.admins, packs: [...new Set(packs)].sort(), shareable: visibility.shareable };
}

/** How much a tier lets a reader have: model_readable, then function_bytes_only, then retain_only. */
function openness(tier: ReadTier): number {
  if (tier === MODEL_READABLE) return 2;
  return tier === FUNCTION_BYTES_ONLY ? 1 : 0;
}

function scannerVersion(scan: CredentialScan): number {
  const match = /@([0-9]+)$/.exec(scan.scanner);
  return match === null ? 0 : Number(match[1]);
}

/** Credential hits belong to the bytes: the newest scanner version among the records of these bytes decides (B02 R[4]). */
function credentialHit(records: readonly SourceArtifact[]): boolean {
  let newest = -1;
  let hit = false;
  for (const record of records) {
    const version = scannerVersion(record.body.scan);
    const found = record.body.scan.findings.length > 0;
    if (version > newest) {
      newest = version;
      hit = found;
    } else if (version === newest && found) {
      hit = true;
    }
  }
  return hit;
}

interface Viewer {
  id: string;
  role: PermissionRole;
}

interface Choice {
  artifact: SourceArtifact;
  tier: ReadTier;
  credential: boolean;
}

export interface ArtifactsOptions {
  maxBytes: number;
  now: () => Date;
}

export class RecordArtifacts implements Artifacts {
  readonly #db: Database;
  readonly #store: RecordStore;
  readonly #objects: ObjectStore;
  readonly #authorizations: Authorizations;
  readonly #options: ArtifactsOptions;

  constructor(db: Database, store: RecordStore, objects: ObjectStore, authorizations: Authorizations, options: ArtifactsOptions) {
    this.#db = db;
    this.#store = store;
    this.#objects = objects;
    this.#authorizations = authorizations;
    this.#options = options;
  }

  async ingest(input: IngestInput): Promise<SourceArtifact> {
    if (!(input.bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    if (!isMediaType(input.mediaType)) throw new TypeError(`invalid media type ${JSON.stringify(input.mediaType)}`);
    const origin = validOrigin(input.origin);
    const author = validAuthor(input.author);
    if (!isProvenanceType(input.provenanceType)) throw new TypeError('unknown provenance type');
    const requestedTier = input.readTier ?? MODEL_READABLE;
    if (!isReadTier(requestedTier)) throw new TypeError('unknown read tier');
    const visibility = validVisibility(input.visibility, origin);
    const name = text(input.name, 'name', 300);
    const run = input.run ?? null;
    if (run !== null && !RunId.safeParse(run).success) throw new TypeError('run must be a run id');
    const capturedAt = normalizeTime(input.capturedAt ?? this.#options.now(), 'capturedAt');
    const size = input.bytes.byteLength;
    if (size > this.#options.maxBytes) {
      throw new LimitError(`文件 ${size} 字节，超过上限 ${this.#options.maxBytes} 字节；不会截断保存`, { detail: { size, limit: this.#options.maxBytes } });
    }
    const sha256 = sha256Hex(input.bytes);
    const scan = scanForCredentials(input.bytes);
    const hit = scan.findings.length > 0;
    if (hit && 'upload' in origin) await this.#refuseUpload({ sha256, size, mediaType: input.mediaType, origin, author, run, scan });
    const readTier = hit ? RETAIN_ONLY : requestedTier;
    const body: SourceArtifactBody = {
      sha256,
      size,
      media_type: input.mediaType,
      name,
      origin,
      author,
      captured_at: capturedAt,
      provenance_type: input.provenanceType,
      read_tier: readTier,
      visibility,
      scan,
    };
    const dedupe = digestOf({ sha256, media_type: input.mediaType, name, origin, author, provenance_type: input.provenanceType, read_tier: readTier, visibility });
    // Every check that can refuse runs before the bytes are written: objects are never deleted.
    const index = validateIndex([
      { key: 'artifact.sha256', value: sha256 },
      { key: 'artifact.dedupe', value: dedupe },
      ...visibility.readers.map((reader) => ({ key: 'artifact.reader', value: reader })),
      ...visibility.packs.map((pack) => ({ key: 'artifact.pack', value: pack })),
      ...('read' in origin ? [{ key: 'artifact.object', value: origin.read.object }] : []),
      ...(author.user === null ? [] : [{ key: 'artifact.author', value: author.user }]),
    ]);
    await this.#objects.put(input.bytes, input.mediaType);
    return this.#store.withTransaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [INGEST_LOCK_SPACE, dedupe], tx);
      const existing = await this.#store.find<SourceArtifactBody>({ key: 'artifact.dedupe', value: dedupe, kind: 'source_artifact', limit: 1 }, tx);
      if (existing.items[0] !== undefined) return existing.items[0];
      return this.#store.put<SourceArtifactBody>(
        { kind: 'source_artifact', schema: RECORD_SCHEMAS.source_artifact, provenance: input.provenanceType, body, created_at: this.#options.now().toISOString(), index },
        tx,
      );
    });
  }

  async records(sha256: string): Promise<SourceArtifact[]> {
    if (!isSha256(sha256)) return [];
    const out: SourceArtifact[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<SourceArtifact> = await this.#store.find<SourceArtifactBody>({ key: 'artifact.sha256', value: sha256, kind: 'source_artifact', limit: 500, cursor });
      out.push(...page.items);
      cursor = page.next;
    } while (cursor !== null);
    return out;
  }

  async canRead(principal: Principal, artifact: SourceArtifact): Promise<boolean> {
    const viewer = await this.#viewer(principal);
    return viewer !== null && (await this.#mayRead(viewer, artifact));
  }

  async readable(principal: Principal, sha256: string): Promise<SourceArtifact | null> {
    const viewer = await this.#viewer(principal);
    return viewer === null ? null : ((await this.#choose(viewer, sha256))?.artifact ?? null);
  }

  async source(principal: Principal, sha256: string, options: { consumer?: ProducerKind } = {}): Promise<ArtifactSource | null> {
    const consumer = options.consumer ?? MODEL;
    if (!isProducerKind(consumer)) throw new TypeError('consumer must be a producer kind');
    const viewer = await this.#viewer(principal);
    const choice = viewer === null ? null : await this.#choose(viewer, sha256);
    if (choice === null) return null;
    const body = choice.artifact.body;
    const given = choice.tier === MODEL_READABLE || (choice.tier === FUNCTION_BYTES_ONLY && consumer === FUNCTION);
    const base = { artifact: choice.artifact, sha256: body.sha256, size: body.size, mediaType: body.media_type, readTier: choice.tier };
    if (!given) return { ...base, bytes: null, note: this.#note(choice) };
    const bytes = await this.#objects.get(sha256);
    if (bytes === null) throw new IntegrityError('有源文件记录，但原件字节丢失', { detail: { sha256 } });
    return { ...base, bytes };
  }

  async trustedBytes(sha256: string): Promise<Uint8Array | null> {
    return this.#objects.get(sha256);
  }

  async text(principal: Principal, sha256: string, options: { maxBytes?: number } = {}): Promise<ArtifactText | null> {
    const viewer = await this.#viewer(principal);
    const choice = viewer === null ? null : await this.#choose(viewer, sha256);
    if (choice === null) return null;
    if (choice.tier !== MODEL_READABLE) return { artifact: choice.artifact, readable: false, truncated: false, note: this.#note(choice) };
    const bytes = await this.#objects.get(sha256);
    if (bytes === null) throw new IntegrityError('有源文件记录，但原件字节丢失', { detail: { sha256 } });
    const preview = textPreview(bytes, options.maxBytes);
    return { artifact: choice.artifact, readable: true, text: preview.text, truncated: preview.truncated };
  }

  #note(choice: Choice): string {
    return choice.credential ? labelOf('validity_status', 'credential_unreadable') : labelOf('read_tier', choice.tier);
  }

  /** The account as stored now; a disabled or unknown account reads nothing (a Principal may be stale). */
  async #viewer(principal: Principal): Promise<Viewer | null> {
    const id = typeof principal?.id === 'string' && USER_ID.test(principal.id) ? principal.id : null;
    if (id === null) return null;
    const row = (await this.#db.query('SELECT id, role, disabled FROM users WHERE id = $1', [id])).rows[0];
    if (row === undefined || row.disabled === true) return null;
    return { id: String(row.id), role: row.role === ADMIN ? ADMIN : 'user' };
  }

  /** B02 R[3] for one record; a share names this record, not the bytes, so other uploads of the same bytes stay private. */
  async #mayRead(viewer: Viewer, artifact: SourceArtifact): Promise<boolean> {
    const visibility = artifact.body.visibility;
    if (visibility.readers.includes(viewer.id)) return true;
    if (visibility.admins && viewer.role === ADMIN) return true;
    for (const pack of visibility.packs) if (await this.#authorizations.canUse(viewer.id, pack)) return true;
    return visibility.shareable && (await this.#authorizations.isSharedWith(viewer.id, artifactShareKey(artifact)));
  }

  /**
   * The record of these bytes that decides for this reader: of the records the reader may read, the one whose tier lets
   * the most through, the oldest on a tie. A credential hit on the bytes makes the tier retain_only whatever that record says.
   */
  async #choose(viewer: Viewer, sha256: string): Promise<Choice | null> {
    const all = await this.records(sha256);
    let chosen: SourceArtifact | null = null;
    for (const artifact of all) {
      if (chosen !== null && openness(artifact.body.read_tier) <= openness(chosen.body.read_tier)) continue;
      if (await this.#mayRead(viewer, artifact)) chosen = artifact;
    }
    if (chosen === null) return null;
    const credential = credentialHit(all);
    return { artifact: chosen, tier: credential ? RETAIN_ONLY : chosen.body.read_tier, credential };
  }

  /** Keeps only the digest and the scan conclusion in a validate action, then refuses the upload (B02 R[4], B05 R[3]). */
  async #refuseUpload(refused: {
    sha256: string;
    size: number;
    mediaType: string;
    origin: ArtifactOrigin;
    author: ArtifactAuthor;
    run: string | null;
    scan: CredentialScan;
  }): Promise<never> {
    const at = this.#options.now().toISOString();
    const upload = 'upload' in refused.origin ? refused.origin.upload : null;
    const body: ActionBody = {
      action: 'validate',
      run: refused.run,
      item: null,
      inputs: [],
      component: 'records.artifacts@1',
      lease: null,
      started_at: at,
      ended_at: at,
      result: 'completed',
      error_code: null,
      acceptance: 'not_accepted',
      codes: ['CREDENTIAL_IN_UPLOAD'],
      detail: {
        subject: { sha256: refused.sha256, size: refused.size, media_type: refused.mediaType },
        scan: refused.scan,
        upload,
        uploader: refused.author.user,
      },
    };
    const action = await this.#store.put<ActionBody>({
      kind: 'action',
      schema: RECORD_SCHEMAS.action,
      provenance: 'observed',
      body,
      created_at: at,
      index: [
        { key: 'action.kind', value: 'validate' },
        { key: 'artifact.refused', value: refused.sha256 },
        ...(refused.author.user === null ? [] : [{ key: 'action.user', value: refused.author.user }]),
        ...(refused.run === null ? [] : [{ key: 'action.run', value: refused.run }]),
      ],
    });
    const places = refused.scan.findings
      .slice(0, 5)
      .map((finding) => `第 ${finding.line} 行第 ${finding.column} 列（${finding.detector}）`)
      .join('、');
    const more = refused.scan.findings.length > 5 || refused.scan.truncated ? ' 等' : '';
    throw new RecordsError(`${PROTOCOL_CODES.CREDENTIAL_IN_UPLOAD.when}：${places}${more}。上传未受理，原文没有保存`, {
      code: 'CREDENTIAL_IN_UPLOAD',
      detail: {
        sha256: refused.sha256,
        size: refused.size,
        media_type: refused.mediaType,
        findings: refused.scan.findings,
        truncated: refused.scan.truncated,
        action: action.digest,
      },
    });
  }
}
