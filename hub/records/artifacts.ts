// Source artifacts (B02): content-addressed bytes plus a `source_artifact@1` record with provenance, author, capture time,
// provenance type, read tier, visibility and the credential scan conclusion. An upload with a credential hit is refused
// whole (B02 R[4]); a read or generated artifact with a hit is kept at read tier retain_only, unless an admin accepted
// exactly these findings of exactly these bytes (a resource configuration, README decision 18), which lifts only bytes
// the Hub read or made, never what a person supplied. Readers get bytes only through source(), which applies the read tier
// (B02 F[5]): retain_only bytes are never handed out, function_bytes_only bytes only to functions. Every read re-reads the
// account, and a share covers the one record it names (B04 R[3]).
import { PackId, RunId, UserId, Versioned } from '../../contracts/src/common.ts';
import { ExternalObjectId } from '../../contracts/src/reference.ts';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { isProducerKind, isProvenanceType, isReadTier, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { PermissionKind, PermissionRole, ProducerKind, ReadTier } from '../../contracts/generated/vocabulary.ts';
import type {
  ActionBody,
  ArtifactAuthor,
  ArtifactOrigin,
  ArtifactSource,
  ArtifactText,
  Artifacts,
  AuthorizationRecord,
  Authorizations,
  CredentialScan,
  FindingsAcceptance,
  IndexEntry,
  IngestInput,
  ObjectStore,
  Page,
  Principal,
  RecordStore,
  ScanAcceptance,
  SourceArtifact,
  SourceArtifactBody,
  Visibility,
} from './api.ts';
import { validNote } from './authorizations.ts';
import { RECORD_SCHEMAS, WHOLE_HUB, artifactShareKey, scanAcceptanceKey } from './constants.ts';
import { normalizeTime } from './db.ts';
import type { Database } from './db.ts';
import { digestOf, isSha256, sha256Hex } from './digest.ts';
import { AccessError, ConflictError, IntegrityError, LimitError, RecordsError } from './errors.ts';
import { isMediaType } from './objects.ts';
import { scanDigest, scanForCredentials, scanWithContexts } from './scan.ts';
import { MAX_INDEX_VALUE_BYTES, validateIndex } from './store.ts';
import { textPreview } from './text.ts';

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
const RESOURCE_CONFIG: PermissionKind = 'resource_config';
/** A note may not share this many consecutive characters (without white space) with the text around a finding. */
const COPIED_RUN = 6;

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
    if (!Versioned.safeParse(generated?.generator).success) throw new TypeError('origin.generated.generator must be name@major (contracts Versioned)');
    if (!Array.isArray(generated.inputs) || generated.inputs.length > 200 || generated.inputs.some((input) => typeof input !== 'string' || input.length === 0 || input.length > 600)) {
      throw new TypeError('origin.generated.inputs must be references');
    }
    const readBack = generated.read_back ?? null;
    if (readBack !== null && !isSha256(readBack)) throw new TypeError('origin.generated.read_back must be a digest');
    return { generated: { generator: generated.generator, inputs: [...generated.inputs], read_back: readBack } };
  }
  throw new TypeError('origin must have exactly one of read, upload or generated');
}

/** True when the note shares COPIED_RUN consecutive characters without white space with one of the contexts. */
function copiesContext(note: string, contexts: readonly string[]): boolean {
  const windows = new Set<string>();
  for (const run of note.split(/\s+/u)) for (let start = 0; start + COPIED_RUN <= run.length; start++) windows.add(run.slice(start, start + COPIED_RUN));
  if (windows.size === 0) return false;
  for (const context of contexts) {
    for (let start = 0; start + COPIED_RUN <= context.length; start++) if (windows.has(context.slice(start, start + COPIED_RUN))) return true;
  }
  return false;
}

/**
 * A note on a findings decision must not carry what the findings are: one the credential scanner flags, or one that copies
 * a run of COPIED_RUN characters from the text around a finding (`contexts`, from scanWithContexts), is refused.
 */
function findingsNote(note: string | null | undefined, contexts: readonly string[]): string | null {
  const checked = validNote(note);
  if (checked === null) return null;
  if (scanForCredentials(Buffer.from(checked, 'utf8')).findings.length > 0) {
    throw new RecordsError('说明里有像凭据的内容，这个决定没有记录；说明里不要抄写命中处的原文');
  }
  if (copiesContext(checked, contexts)) {
    throw new RecordsError(`说明里抄写了命中处的原文（与命中所在的行有连续 ${COPIED_RUN} 个字符相同），这个决定没有记录；请用自己的话写说明`);
  }
  return checked;
}

/** Bytes the Hub read or made: not an upload, and no person as author (B02 F[2]). Everything else a person supplied. */
function fromHub(origin: ArtifactOrigin, author: ArtifactAuthor | undefined): boolean {
  return !('upload' in origin) && author?.user === null;
}

/** A source_artifact record of bytes a person supplied: an upload, or a record with a person as author. */
function personSupplied(artifact: SourceArtifact): boolean {
  return !fromHub(artifact.body.origin, artifact.body.author);
}

/** The record a read is pinned to (`options.record`), or null. */
function pinned(record: unknown): string | null {
  if (record === undefined || record === null) return null;
  if (!isSha256(record)) throw new TypeError('record must be the digest of a source_artifact record');
  return record;
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

function scannerVersion(scan: CredentialScan): number {
  const match = /@([0-9]+)$/.exec(scan.scanner);
  return match === null ? 0 : Number(match[1]);
}

/** Credential hits belong to the bytes: the scans of the newest scanner version among their records decide (B02 R[4]). */
function newestHits(records: readonly SourceArtifact[]): SourceArtifact[] {
  let newest = -1;
  for (const record of records) newest = Math.max(newest, scannerVersion(record.body.scan));
  return records.filter((record) => scannerVersion(record.body.scan) === newest && record.body.scan.findings.length > 0);
}

interface Viewer {
  id: string;
  role: PermissionRole;
}

interface Choice {
  artifact: SourceArtifact;
  tier: ReadTier;
  /** The tier is retain_only because of a credential hit no acceptance in force lifts for this record. */
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
    // Acceptance is for what the Hub reads or makes, never for what a person supplies (B02 R[4]): an upload with a hit is
    // refused whatever an admin accepted, and a record with a person as author keeps retain_only.
    if (hit && 'upload' in origin) await this.#refuseUpload({ sha256, size, mediaType: input.mediaType, origin, author, run, scan });
    const accepted = hit && fromHub(origin, author) ? await this.#acceptanceOf(sha256, scan) : null;
    const readTier = hit && accepted === null ? RETAIN_ONLY : requestedTier;
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
      scan: accepted === null ? scan : { ...scan, accepted },
    };
    // The acceptance takes part only when there is one, so the dedupe key of every other ingest is what it always was.
    const dedupe = digestOf({
      sha256,
      media_type: input.mediaType,
      name,
      origin,
      author,
      provenance_type: input.provenanceType,
      read_tier: readTier,
      visibility,
      accepted: accepted?.authorization,
    });
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
    return viewer === null ? null : ((await this.#choose(viewer, sha256, null))?.artifact ?? null);
  }

  async source(principal: Principal, sha256: string, options: { consumer?: ProducerKind; record?: string } = {}): Promise<ArtifactSource | null> {
    const consumer = options.consumer ?? MODEL;
    if (!isProducerKind(consumer)) throw new TypeError('consumer must be a producer kind');
    const record = pinned(options.record);
    const viewer = await this.#viewer(principal);
    const choice = viewer === null ? null : await this.#choose(viewer, sha256, record);
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

  async text(principal: Principal, sha256: string, options: { maxBytes?: number; record?: string } = {}): Promise<ArtifactText | null> {
    const record = pinned(options.record);
    const viewer = await this.#viewer(principal);
    const choice = viewer === null ? null : await this.#choose(viewer, sha256, record);
    if (choice === null) return null;
    if (choice.tier !== MODEL_READABLE) return { artifact: choice.artifact, readable: false, truncated: false, note: this.#note(choice) };
    const bytes = await this.#objects.get(sha256);
    if (bytes === null) throw new IntegrityError('有源文件记录，但原件字节丢失', { detail: { sha256 } });
    const preview = textPreview(bytes, options.maxBytes);
    return { artifact: choice.artifact, readable: true, text: preview.text, truncated: preview.truncated };
  }

  async acceptFindings(by: Principal, sha256: string, note?: string | null): Promise<FindingsAcceptance> {
    if (!isSha256(sha256)) throw new TypeError('sha256 must be a lowercase hex SHA-256');
    await this.#requireAdmin(by, '只有管理员可以接受凭据扫描的命中');
    validNote(note);
    const bytes = await this.#objects.get(sha256);
    if (bytes === null) {
      const refused = await this.#store.find({ key: 'artifact.refused', value: sha256, kind: 'action', limit: 1 });
      throw new ConflictError(
        refused.items.length > 0
          ? '这份字节是一次因含凭据被拒绝的上传，Hub 没有保存原文，没有可接受的扫描结果；含凭据的上传在任何情况下都不受理'
          : 'Hub 没有保存这份字节，没有可接受的扫描结果',
        { detail: { sha256 } },
      );
    }
    // An acceptance lifts only bytes the Hub read or made (B02 R[4]); what a person supplied it never lifts.
    const all = await this.records(sha256);
    if (!all.some((artifact) => !personSupplied(artifact))) {
      throw new ConflictError(
        all.length === 0
          ? 'Hub 没有这份字节的源文件记录，没有可接受的扫描结果'
          : '这份字节只来自个人提供的内容（上传，或以个人为作者的记录）；接受只对 Hub 读取或生成的字节生效，个人提供的内容含凭据时不能接受',
        { detail: { sha256 } },
      );
    }
    // The decision covers the current scanner's findings of the stored bytes, never a finding list someone hands in.
    const { scan, contexts } = scanWithContexts(bytes);
    if (scan.findings.length === 0) throw new ConflictError('当前的凭据扫描在这份字节里没有命中，不需要接受', { detail: { sha256, scanner: scan.scanner } });
    // A truncated scan binds only the positions it kept: the rest were never shown, and past a pattern's cap never looked for.
    if (scan.truncated) {
      throw new ConflictError(`命中超过可列出的上限（列出了 ${scan.findings.length} 处，还有更多），管理员无法逐处核对，不能接受`, {
        detail: { sha256, scanner: scan.scanner, kept: scan.findings.length },
      });
    }
    const reason = findingsNote(note, contexts);
    const authorization = await this.#authorizations.configureResource(by, scanAcceptanceKey(sha256), scanDigest(scan), reason);
    return { authorization, scan };
  }

  async revokeFindings(by: Principal, sha256: string, note?: string | null): Promise<AuthorizationRecord> {
    if (!isSha256(sha256)) throw new TypeError('sha256 must be a lowercase hex SHA-256');
    await this.#requireAdmin(by, '只有管理员可以撤回对凭据扫描命中的接受');
    const contexts = validNote(note) === null ? [] : await this.#findingContexts(sha256);
    return this.#authorizations.revoke(by, { permission: RESOURCE_CONFIG, subject: WHOLE_HUB, object: scanAcceptanceKey(sha256), note: findingsNote(note, contexts) });
  }

  /** The text around each finding of the stored bytes, for the note check only (never stored). */
  async #findingContexts(sha256: string): Promise<string[]> {
    const bytes = await this.#objects.get(sha256);
    return bytes === null ? [] : scanWithContexts(bytes).contexts;
  }

  /** The acceptance in force that covers exactly this scan of these bytes, as recorded on an ingested artifact; else null. */
  async #acceptanceOf(sha256: string, scan: CredentialScan): Promise<ScanAcceptance | null> {
    // A truncated scan is never covered: its digest binds only the findings it kept.
    if (scan.truncated) return null;
    const configuration = await this.#authorizations.resourceConfig(scanAcceptanceKey(sha256));
    if (configuration === null || configuration.body.bound !== scanDigest(scan)) return null;
    return { by: configuration.body.decided_by, at: configuration.body.decided_at, authorization: configuration.digest };
  }

  /**
   * Whether the credential hit of some bytes is lifted now: an acceptance in force covers every scan of the newest scanner
   * version that found something, none of them truncated (B04 R[1]: checked again at every use, so a withdrawal takes
   * effect at once).
   */
  async #hitAccepted(sha256: string, hits: readonly SourceArtifact[]): Promise<boolean> {
    if (hits.some((record) => record.body.scan.truncated)) return false;
    const configuration = await this.#authorizations.resourceConfig(scanAcceptanceKey(sha256));
    return configuration !== null && hits.every((record) => scanDigest(record.body.scan) === configuration.body.bound);
  }

  async #requireAdmin(by: Principal, message: string): Promise<void> {
    const viewer = await this.#viewer(by);
    if (viewer === null || viewer.role !== ADMIN) throw new AccessError(message);
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
   * The record of these bytes that decides for this reader: the pinned record when the read names one (and the reader may
   * read it), else the newest record the reader may read, except that a record another person supplied never outranks one
   * the Hub read or made or one of the reader's own; it decides only when the reader may read nothing else. A credential
   * hit on the bytes makes the tier retain_only whatever that record says, unless an acceptance in force lifts it; it never
   * lifts what a person supplied (B02 R[4]).
   */
  async #choose(viewer: Viewer, sha256: string, record: string | null): Promise<Choice | null> {
    const all = await this.records(sha256);
    const chosen = record === null ? await this.#deciding(viewer, all) : await this.#pinned(viewer, all, record);
    if (chosen === null) return null;
    const hits = newestHits(all);
    const lifted = hits.length > 0 && !personSupplied(chosen) && (await this.#hitAccepted(sha256, hits));
    const credential = hits.length > 0 && !lifted;
    return { artifact: chosen, tier: credential ? RETAIN_ONLY : chosen.body.read_tier, credential };
  }

  /** Newest first; another person's upload or record is only the fallback, so no user changes what governs someone else's reads. */
  async #deciding(viewer: Viewer, all: readonly SourceArtifact[]): Promise<SourceArtifact | null> {
    let fallback: SourceArtifact | null = null;
    for (let index = all.length - 1; index >= 0; index--) {
      const artifact = all[index];
      const others = personSupplied(artifact) && artifact.body.author?.user !== viewer.id;
      if (others && fallback !== null) continue;
      if (!(await this.#mayRead(viewer, artifact))) continue;
      if (!others) return artifact;
      fallback = artifact;
    }
    return fallback;
  }

  async #pinned(viewer: Viewer, all: readonly SourceArtifact[], record: string): Promise<SourceArtifact | null> {
    const named = all.find((artifact) => artifact.digest === record);
    return named !== undefined && (await this.#mayRead(viewer, named)) ? named : null;
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
