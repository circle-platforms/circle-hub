// Public surface of the records package (B01 B02 B04 B05 B08, R01, R02). Other packages code against this file only.
// Field names of stored bodies are snake_case like the contracts; enumerations come from the generated vocabulary.
import type {
  Acceptance,
  ActionKind,
  ActionResult,
  CallResult,
  PermissionKind,
  PermissionRole,
  ProducerKind,
  ProvenanceType,
  ReadTier,
  ShareAudience,
} from '../../contracts/generated/vocabulary.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import type { HubConfig } from '../config/index.ts';

export type { HubConfig, DatabaseConfig, Limits } from '../config/index.ts';
export type { RecordKind } from '../../contracts/generated/protocol.ts';

export { RecordVariables, VariableError, secretForms, validateChangeReason } from './variables.ts';
export type { NamedVersion, VariableSnapshot, SecretWrite, SecretMaterial, PreparedSecrets } from './variables.ts';
export { recordIntegrityNotes, type RecordIntegrityNote } from './integrity-notes.ts';
export { createRecordStore, type StoreOptions } from './store.ts';
export { parseStrictJson } from './strict-json.ts';
export { canonicalize, canonicalBytes, canonicalByteLength, createCanonicalEncoder, CanonicalizationError } from './canonical.ts';
export { sha256Hex, digestOf, recordDigest, isSha256, SHA256_PATTERN } from './digest.ts';
export { newId, ulid, idTime, isId } from './ids.ts';
export { RecordsError, IntegrityError, LimitError, AccessError, ConflictError, MigrationError, VaultError } from './errors.ts';
export { scanForCredentials, scanDigest, CREDENTIAL_SCANNER, CREDENTIAL_FINDING_LIMIT, MAX_ADMIN_FINDINGS, CREDENTIAL_DETECTORS } from './scan.ts';
export { textPreview, stripNul } from './text.ts';
export { maskedForDisplay, FileKeyProvider } from './vault.ts';
export { sharedWith, runIsSharedWith, productionShareKey, productionShareBinding } from './authorizations.ts';
export { WHOLE_HUB, RECORD_SCHEMAS, artifactShareKey, scanAcceptanceKey } from './constants.ts';

// ---------------------------------------------------------------- identity

/** An authenticated Hub account (R01). Disabled accounts never authenticate. */
export interface Principal {
  id: string;
  name: string;
  role: PermissionRole;
}

export interface User extends Principal {
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

/** One snapshot of a user row after a change: who changed it and when (role changes are recorded this way). */
export interface UserChange {
  user: string;
  name: string;
  role: PermissionRole;
  disabled: boolean;
  changed_by: string | null;
  changed_at: string;
}

/** A newly issued token. `token` is shown once and never stored; only its SHA-256 is. */
export interface IssuedToken {
  id: string;
  user: string;
  token: string;
  label: string;
  created_at: string;
}

export interface TokenInfo {
  id: string;
  user: string;
  label: string;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface Principals {
  /** Creates the first admin and its token. Refused (ConflictError) once any admin exists. */
  bootstrapAdmin(name: string): Promise<{ user: User; token: IssuedToken }>;
  createUser(by: Principal, name: string, role?: PermissionRole): Promise<User>;
  setRole(by: Principal, userId: string, role: PermissionRole): Promise<User>;
  setDisabled(by: Principal, userId: string, disabled: boolean): Promise<User>;
  get(userId: string): Promise<User | null>;
  findByName(name: string): Promise<User | null>;
  list(): Promise<User[]>;
  history(userId: string): Promise<UserChange[]>;
  /** Admins issue tokens for anyone; a user only for themselves. */
  issueToken(by: Principal, userId: string, label?: string): Promise<IssuedToken>;
  /** Admins revoke any token; a user only their own. False when the token does not exist or was already revoked. */
  revokeToken(by: Principal, tokenId: string): Promise<boolean>;
  tokens(userId: string): Promise<TokenInfo[]>;
  /** `Authorization` header value (`Bearer <token>`). Null for anything that is not a live token of an enabled user. */
  authenticate(authorization: string | null | undefined): Promise<Principal | null>;
}

// ---------------------------------------------------------------- records

/** Opaque handle from RecordStore.withTransaction; pass it back to take part in the same transaction. */
export interface Transaction {
  readonly transactionId: number;
}

export interface IndexEntry {
  /** Namespaced by the writer, for example `artifact.sha256` or `run.user`: `^[a-z][a-z0-9_.-]{0,99}$`. */
  key: string;
  /** At most 1000 bytes of UTF-8 (a btree row holds 2704 bytes), well-formed, no NUL. */
  value: string;
}

export interface RecordInput<B = unknown> {
  kind: RecordKind;
  /**
   * `name@major` as contracts SchemaId (`^[a-z][a-z0-9_-]*@(0|[1-9][0-9]*)$`: lowercase letters, digits, `_` and `-`, no
   * leading-zero major), for example `source_artifact@1`, `check-outcome@1` or `run-summary@1`. Checked on put and on every read.
   */
  schema: string;
  provenance: ProvenanceType;
  body: B;
  /** ISO 8601 UTC with milliseconds (`Date.prototype.toISOString`). Defaults to now; give it to make a put repeatable. */
  created_at?: string;
  index?: IndexEntry[];
  /** Atomic first-writer key within this record kind. A duplicate returns the original verified record, unchanged. */
  unique_key?: string;
}

/** A stored record (contracts RecordEnvelope). Its digest is verified every time it is read. */
export interface StoredRecord<B = unknown> {
  /** Unsealed read diagnostic; never part of the historical body or digest. */
  integrity_note?: string;
  id: string;
  kind: RecordKind;
  schema: string;
  digest: string;
  provenance: ProvenanceType;
  created_at: string;
  body: B;
}

export interface PutResult<B = unknown> extends StoredRecord<B> {
  /** False when a record with the same digest already existed (the put was idempotent). */
  created: boolean;
}

export interface Page<T> {
  items: T[];
  /** Cursor for the next page, or null when this page is the last. */
  next: string | null;
}

export interface PageQuery {
  /** 1 to 500, default 50. */
  limit?: number;
  cursor?: string | null;
  /** Default false: oldest first, in insertion order. */
  newestFirst?: boolean;
}

export interface FindQuery extends PageQuery {
  key: string;
  value: string;
  kind?: RecordKind;
}

export interface ListQuery extends PageQuery {
  kind: RecordKind;
}

export interface RecordStore {
  /** Internal append-log position; never part of a record digest. Snapshot horizons may contain gaps. */
  position?(digest:string,tx?:Transaction):Promise<number|null>;
  watermark?(tx?:Transaction):Promise<number>;
  getByKey<B = unknown>(kind: RecordKind, key: string, tx?: Transaction): Promise<StoredRecord<B> | null>;

  /** Holds a typed business-key advisory lock until the given transaction commits or rolls back. */
  lock(key: string, tx: Transaction): Promise<void>;
  /** Session lock that dies with the connection. Null means a live holder already has this key. */
  tryHold(key: string): Promise<(() => Promise<void>) | null>;
  /** Appends a record; an identical digest returns the existing record with `created: false`. */
  put<B>(input: RecordInput<B>, tx?: Transaction): Promise<PutResult<B>>;
  get<B = unknown>(digest: string, tx?: Transaction): Promise<StoredRecord<B> | null>;
  /** Verified envelope/body text for streaming consumers; the consumer must validate JSON syntax and its body schema. */
  getText(digest: string, tx?: Transaction): Promise<(Omit<StoredRecord, 'body'> & { bodyText: string ;}) | null>;
  getTexts(digests: readonly string[], tx?: Transaction): Promise<Map<string, Omit<StoredRecord, 'body'> & { bodyText: string ;}>>;
  /** Batched verified reads; missing/invalid digests are absent from the map. */
  getMany<B = unknown>(digests: readonly string[], tx?: Transaction): Promise<Map<string, StoredRecord<B>>>;
  /** All indexed records for these values in insertion order, in one query (no per-value query or truncation). */
  findMany<B = unknown>(query: {key: string; values: readonly string[]; kind?: RecordKind}, tx?: Transaction): Promise<StoredRecord<B>[]>;
  /** Oldest matching record per index value, verified, in one query; equivalent to find({limit:1}) per value. */
  findFirstMany<B = unknown>(query: { key: string; values: readonly string[]; kind?: RecordKind ;}, tx?: Transaction): Promise<Map<string, StoredRecord<B>>>;
  getById<B = unknown>(id: string, tx?: Transaction): Promise<StoredRecord<B> | null>;
  find<B = unknown>(query: FindQuery, tx?: Transaction): Promise<Page<StoredRecord<B>>>;
  list<B = unknown>(query: ListQuery, tx?: Transaction): Promise<Page<StoredRecord<B>>>;
  /** Runs `fn` in one transaction; with `outer`, joins that transaction instead of opening a new one. */
  withTransaction<T>(fn: (tx: Transaction) => Promise<T>, outer?: Transaction): Promise<T>;
}

// ---------------------------------------------------------------- objects

export interface ObjectInfo {
  sha256: string;
  size: number;
  /** Media type given when the bytes were first stored; the source artifact record is authoritative. */
  media_type: string;
  created_at: string;
}

/** Content-addressed bytes under <data>/objects/ab/<sha256>: written atomically, verified on every read, never overwritten or deleted. */
export interface ObjectStore {
  put(bytes: Uint8Array, mediaType: string): Promise<ObjectInfo & { created: boolean }>;
  /**
   * Null when absent. Throws IntegrityError when the stored bytes no longer hash to their name or when a registered object's
   * file is missing. No read-tier check: for trusted callers; readers go through Artifacts.source().
   */
  get(sha256: string): Promise<Uint8Array | null>;
  stat(sha256: string): Promise<ObjectInfo | null>;
  has(sha256: string): Promise<boolean>;
}

// ---------------------------------------------------------------- source artifacts (B02)

/**
 * Where the bytes came from (B02 F[1]); exactly one member is present.
 * read: a read action on an external object `system:type:id@revision`; upload: an upload (session observed from the
 * request header, message id declared by the client); generated: a generator run over input references.
 */
export type ArtifactOrigin =
  | { read: { object: string; resource?: string | null; action?: string | null } }
  | { upload: { session: string | null; message?: string | null } }
  | { generated: { generator: string; inputs: string[]; read_back?: string | null } };

/** B02 F[2]: the observed Hub account, and an author name that is only declared (file metadata or what the uploader said). */
export interface ArtifactAuthor {
  user: string | null;
  declared?: string | null;
}

/**
 * Who may read (B02 R[3], R02). `readers` are named accounts (uploader, the person whose own credential read it);
 * `admins` lets admins read; `packs` lets every user who may use one of the packs read; `shareable` lets an admin
 * share this record further (B04 share, object `artifactShareKey(record)`). Connector reads are never shareable, and only
 * what admins may read can be shared. At most 64 readers and 64 packs.
 */
export interface Visibility {
  readers: string[];
  admins: boolean;
  packs: string[];
  shareable: boolean;
}

export interface CredentialFinding {
  /** Detector id from CREDENTIAL_DETECTORS (pending a contracts vocabulary axis for credential kinds; see the README). */
  detector: string;
  /** Byte offset in the original bytes; for a hit inside an escaped quoted string, the offset of its opening quote. */
  offset: number;
  /** 1-based line and column (column in characters of the decoded text the hit was found in). */
  line: number;
  column: number;
}

/**
 * An admin's acceptance that the findings of a scan are no credentials (for example example URLs in a product manual):
 * the resource configuration `scanAcceptanceKey(sha256)` bound to `scanDigest(scan)` (B04; README decision 18).
 */
export interface ScanAcceptance {
  /** User id of the admin who decided. */
  by: string;
  /** When the decision was made (its `decided_at`). */
  at: string;
  /** Digest of the authorization record (the resource configuration) that covers this scan. */
  authorization: string;
}

/** Safe proof: references to source bytes, their deciding records and the admin decisions, never finding text or hashes. */
export interface DerivedScanAcceptance {
  /** Target scan identity: metadata digest only, never a hash of matched text. Older receipts bind it through their record. */
  scanner?: string;
  scan_digest?: string;
  sources: Array<{ sha256: string; record: string; acceptances: ScanAcceptance[] }>;
}
export type EffectiveScanAcceptance =
  | { kind: 'direct'; acceptance: ScanAcceptance }
  | { kind: 'derived'; acceptance: DerivedScanAcceptance };
/** Opaque, operation-scoped matcher. Exact source matches stay inside records and are never returned. */
export interface DerivedCoverage {
  assess(bytes: Uint8Array): {scan: CredentialScan; derived: DerivedScanAcceptance | null};
}
export type DerivedCoverageInput = Omit<DerivedScanInput, 'bytes'>;
export interface DerivedScanInput {
  bytes: Uint8Array;
  origin: ArtifactOrigin;
  author: ArtifactAuthor;
  /** Only actual inputs may be offered; records verifies origin links, provenance and current acceptances. */
  derivedSources: readonly string[];
}

/** Scan conclusion: positions and detector ids only, never the matched text. */
export interface CredentialScan {
  scanner: string;
  /** False when the bytes are not text the scanner can read (compressed or image containers, other binary): no conclusion. */
  inspected: boolean;
  /** True only when the bytes were inspected and nothing was found. A credential hit is `findings.length > 0`. */
  clean: boolean;
  findings: CredentialFinding[];
  /** True when more findings existed than were kept. Truncated evidence alone cannot establish acceptance; an administrator may rescan all findings by detector class. */
  truncated: boolean;
  /**
   * Present only on a read or generated artifact the Hub read or made (no person as author), stored while an admin's
   * acceptance covered exactly these bytes and this finding set; the findings stay as found. Reads check again that the
   * acceptance is still in force (README decision 18).
   */
  accepted?: ScanAcceptance;
  /** The accepted sources that covered all findings at ingest; revalidated at every read. */
  derived?: DerivedScanAcceptance;
}

/** Body of a `source_artifact@1` record. */
export interface SourceArtifactBody {
  sha256: string;
  size: number;
  media_type: string;
  name: string | null;
  origin: ArtifactOrigin;
  author: ArtifactAuthor;
  captured_at: string;
  provenance_type: ProvenanceType;
  read_tier: ReadTier;
  /** Requested policy before credential holding; absent on historical records. */
  requested_read_tier?: ReadTier;
  visibility: Visibility;
  scan: CredentialScan;
}

export type SourceArtifact = StoredRecord<SourceArtifactBody>;

export interface IngestInput {
  /** An opaque matcher prepared for exactly this origin/author; revalidated before admission. */
  derivedCoverage?: DerivedCoverage;
  /** Source byte digests for a Hub-generated derivative; never a global pool of accepted text. */
  derivedSources?: readonly string[];
  bytes: Uint8Array;
  mediaType: string;
  origin: ArtifactOrigin;
  author: ArtifactAuthor;
  provenanceType: ProvenanceType;
  visibility: Visibility;
  /**
   * Default model_readable. A credential hit on a read or generated artifact forces retain_only, unless an admin accepted
   * exactly these findings of exactly these bytes (acceptFindings), or all findings have verified derived coverage.
   * Only entirely Hub-owned ancestry qualifies; an upload with a hit is refused whatever was accepted, and a record
   * with a person as author keeps retain_only.
   */
  readTier?: ReadTier;
  name?: string | null;
  capturedAt?: string;
  /** Run the upload or generation belongs to, recorded on the refusal action when an upload is refused. */
  run?: string | null;
}

export interface ArtifactText {
  artifact: SourceArtifact;
  /** False when the read tier does not let a model read the text; `note` then says why. */
  readable: boolean;
  text?: string;
  truncated: boolean;
  note?: string;
}

/** A by-reference read of stored bytes for one reader (the shape hub/refs' SourceReader asks for, plus the deciding record). */
export interface ArtifactSource {
  /** Current coverage, rechecked for this record; the immutable stored scan remains historical. */
  acceptance?: EffectiveScanAcceptance;
  /** The record that decides for this reader (same rule as text() and readable()). */
  artifact: SourceArtifact;
  sha256: string;
  size: number;
  mediaType: string;
  /** Effective tier: retain_only whenever the bytes have a credential hit that no acceptance in force covers for this record. */
  readTier: ReadTier;
  /** The verified original, or null when the tier withholds it from this consumer; `note` then says why. */
  bytes: Uint8Array | null;
  note?: string;
}

/** What acceptFindings decided: the configuration record and the fresh scan it covers (positions and detector ids only). */
export interface CredentialFindingsPage {scanner:string;findings:CredentialFinding[];next:string|null;total:number;detectors:Record<string,number>}
export interface FindingsAcceptance {
  detectors?:string[];
  complete?:boolean;
  /** resource_config, subject WHOLE_HUB, object `scanAcceptanceKey(sha256)`, bound `scanDigest(scan)`. */
  authorization: AuthorizationRecord;
  scan: CredentialScan;
}

export interface Artifacts {
  /**
   * Stores the bytes and a source_artifact record. An upload with a credential hit is refused with a RecordsError coded
   * CREDENTIAL_IN_UPLOAD: no bytes are stored, only a validate action with the digest and the scan conclusion (B02 R[4]).
   * A read or generated artifact with a hit is stored at retain_only, unless an acceptance in force covers these bytes and
   * this finding set, or verified accepted inputs cover all derived findings: it keeps the requested tier and its scan
   * names direct acceptance (`scan.accepted`) or source/decision-only derived coverage (`scan.derived`).
   * Bytes the scanner cannot read as text are stored with `scan.inspected: false`. Repeating the same ingest (same bytes,
   * origin, author, visibility, tier, name, acceptance) returns the existing record. Every check runs before any byte is
   * written.
   */
  ingest(input: IngestInput): Promise<SourceArtifact>;
  /** Consumes whole transferable buffers by detaching every caller alias; other buffers are snapshotted. Do not reuse the input. */
  ingestTransferred(input: IngestInput): Promise<SourceArtifact>;
  /** In-memory check for Hub-generated parts (for example entries of a view). No bytes or finding text are persisted or returned. */
  /** Resolve and verify the entire input graph once, select current accepted sources in bulk and scan only those bytes once. */
  prepareDerived(input: DerivedCoverageInput): Promise<DerivedCoverage>;
  coverDerived(input: DerivedScanInput): Promise<DerivedScanAcceptance | null>;
  /** Every source_artifact record of these bytes, oldest first. No access check: for trusted callers only. */
  records(sha256: string): Promise<SourceArtifact[]>;
  /** B02 R[3] for one record. The account is re-read: a disabled or demoted account loses access at once. */
  canRead(principal: Principal, artifact: SourceArtifact): Promise<boolean>;
  /**
   * The record of these bytes that decides for this reader (README decision 6): the newest record the reader may read,
   * except that a record another person supplied (their upload, or a record with them as author) never outranks one the
   * Hub read or made or one of the reader's own; it decides only when the reader may read nothing else of these bytes.
   * Absent and forbidden: null. text() and source() use the same record unless they are pinned to one (`record`).
   */
  readable(principal: Principal, sha256: string): Promise<SourceArtifact | null>;
  /**
   * Tier-aware read by reference (B02 F[5], R[4]): null when absent or forbidden; the bytes only when the effective tier
   * allows them to this consumer (default model): model_readable to anyone, function_bytes_only to `function` only,
   * retain_only (every credential hit no acceptance in force covers) to no one. Throws IntegrityError when a recorded
   * object's bytes are missing. `record` (the digest of one source_artifact record of these bytes, for example the record a
   * connector read returned) pins the read: that record decides instead of the rule of readable(), or null when it is not
   * a record of these bytes or the reader may not read it; the credential rule applies to it all the same.
   */
  source(principal: Principal, sha256: string, options?: { consumer?: ProducerKind; record?: string }): Promise<ArtifactSource | null>;
  /** Generated, run-bound evidence only; verifies run visibility and current read tier without changing source ACLs. */
  sourceForRun(principal: Principal, sha256: string, run: string, options?: { consumer?: ProducerKind; record?:string }): Promise<ArtifactSource | null>;
  /**
   * Verified bytes whatever the read tier, for trusted maintenance only: backup verification and re-scanning with a newer
   * scanner. Never for pack functions, parsers, projections or anything whose output can reach a model or a reader.
   */
  trustedBytes(sha256: string): Promise<Uint8Array | null>;
  /** Text for a reader: null when absent or forbidden; NUL stripped; the stored bytes are untouched. `record` pins it as for source(). */
  text(principal: Principal, sha256: string, options?: { maxBytes?: number; record?: string }): Promise<ArtifactText | null>;
  /**
   * An admin decides that the credential findings of these exact bytes are no credentials (README decision 18): the stored
   * bytes are scanned again with the current scanner and a resource configuration `scanAcceptanceKey(sha256)` bound to
   * `scanDigest` of that scan is recorded (B04, append-only). AccessError for anyone but an enabled admin; ConflictError
   * when the bytes are not stored (a refused upload keeps none), when no record of them was read or made by the Hub (only
   * uploads or records with a person as author), when the scan finds nothing, or when it found more than it keeps
   * (`truncated`) without an explicit detector-class rescan. scanFindings pages positions only; selected classes add
   * decisions, and effective access is lifted only when every actual class of the complete scan is covered. A note the credential scanner flags, or one that copies six or more consecutive characters from the
   * lines carrying a finding, is refused (RecordsError) before anything is recorded. It takes effect for read and
   * generated artifacts' effective reads, including a historical scan-imposed hold, never for what a person supplied.
   * The stored tier stays historical; explicit requested retention is preserved. Other bytes, scanner versions or
   * finding sets are not covered.
   */
  scanFindings(by:Principal,sha256:string,options?:{after?:string|null;limit?:number}):Promise<CredentialFindingsPage>;
  acceptFindings(by: Principal, sha256: string, note?: string | null, options?:{detectors?:readonly string[];automatic?:boolean}): Promise<FindingsAcceptance>;
  /**
   * Withdraws an acceptance: a new decision in the same chain (the earlier ones stay). Admin only (AccessError); the note
   * rule of acceptFindings applies. From then on the bytes read as retain_only again and new ingests are stored at
   * retain_only.
   */
  revokeFindings(by: Principal, sha256: string, note?: string | null): Promise<AuthorizationRecord>;
}

// ---------------------------------------------------------------- vault

/** Supplies the 32-byte vault key. The platform provides a macOS Keychain implementation; tests use FileKeyProvider. */
export interface KeyProvider {
  /** Throws VaultError when no key exists. Never creates one. */
  getKey(): Promise<Uint8Array>;
  /** Creates a key when none exists; refuses to replace an existing one. */
  initKey?(): Promise<void>;
}

/** Counts only: never exposes a key, entry name, value or filesystem error. */
export interface VaultVerification {
  checked: number;
  failed: number;
  /** No entry could be verified or a required verification fact was unavailable. */
  unknown: boolean;
}

/** AES-256-GCM sealed entries under <data>/vault, the entry name bound as associated data. Values never leave except by get. */
export interface Vault {
  /** Explicit key creation through the key provider. The vault never creates a key on its own. */
  initKey(): Promise<void>;
  put(name: string, value: string | Uint8Array): Promise<void>;
  /** Null when there is no entry of that name. Throws VaultError when the key is wrong or the entry was altered or renamed. */
  get(name: string): Promise<Uint8Array | null>;
  getText(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
  /** Entry write time only; no decrypted bytes or master-key access. */
  stat(name: string): Promise<{ written_at: string } | null>;
  /** Names only, sorted. */
  list(): Promise<string[]>;
  remove(name: string): Promise<boolean>;
  /** Read-only authenticated check of every entry, when the provider supports it. */
  verify?(): Promise<VaultVerification>;
}

/**
 * Checks that the vault's master key is available and opens this vault, and returns nothing a vault holds: every read takes
 * the key from the provider and checks it (the key-check file, or an existing entry) before it looks for a file, and no entry
 * has the name read here. Throws what the provider throws for a missing key, or VaultError for a key of another vault.
 */
export async function checkVaultKey(vault: Pick<Vault, 'get'>): Promise<void> {
  await vault.get('hub.vault-key-check-probe');
}

// ---------------------------------------------------------------- authorizations (B04)

/** Body of an `authorization@1` record. The latest record per (permission, subject, object) wins. */
export type PackShareAudience = { kind: Extract<ShareAudience, 'pack_users'>; pack: string };
export type ShareAudienceInput = string[] | PackShareAudience;

export interface AuthorizationBody {
  /** Absent on legacy user shares; pack audience subjects are pack_users:<pack>. */
  share_audience?: ShareAudience;
  permission: PermissionKind;
  /** Usually a user id; WHOLE_HUB for a resource configuration. */
  subject: string;
  /** Pack id, `pack@version`, resource id, shared object key, or WHOLE_HUB. */
  object: string;
  /** True when this record withdraws the permission (unassign, revoke, unshare, withdraw a publication). */
  revoked: boolean;
  /** Digest of the exact content the permission covers (B04 F[1]); required for a publication and a resource configuration. */
  bound: string | null;
  decided_by: string;
  decided_at: string;
  expires_at: string | null;
  note: string | null;
  /** Digest of the decision this one follows for the same (permission, subject, object), null for the first: the chain of decisions. */
  supersedes: string | null;
}

export type AuthorizationRecord = StoredRecord<AuthorizationBody>;

export interface AuthorizationInput {
  shareAudience?: ShareAudience;
  permission: PermissionKind;
  subject: string;
  object: string;
  bound?: string | null;
  expiresAt?: string | null;
  note?: string | null;
}

export interface Authorizations {
  /**
   * Records a decision; each one is a new record that names the one it follows. publish (object `pack-id@x.y.z`, `bound` the
   * SHA-256 of the exact pack content): only the decider for themselves, with an active publish right, and only the owner of
   * the pack id (the subject of its first publication); a version once published keeps its content. Withdrawing a
   * publication is the owner or an admin. Every other permission is decided by an admin.
   */
  grant(by: Principal, input: AuthorizationInput, tx?: Transaction): Promise<AuthorizationRecord>;
  revoke(by: Principal, input: Omit<AuthorizationInput, 'bound' | 'expiresAt'>): Promise<AuthorizationRecord>;
  /** Latest record for the triple, revoked or not. */
  latest(permission: PermissionKind, subject: string, object: string): Promise<AuthorizationRecord | null>;
  /** True when the latest record is a grant that has not expired. */
  isActive(permission: PermissionKind, subject: string, object: string): Promise<boolean>;
  history(query: { permission?: PermissionKind; subject?: string; object?: string } & PageQuery): Promise<Page<AuthorizationRecord>>;

  assign(by: Principal, userId: string, packId: string, options?: { expiresAt?: string | null; note?: string | null }): Promise<AuthorizationRecord>;
  unassign(by: Principal, userId: string, packId: string, note?: string | null): Promise<AuthorizationRecord>;
  grantPublishRight(by: Principal, userId: string, note?: string | null): Promise<AuthorizationRecord>;
  revokePublishRight(by: Principal, userId: string, note?: string | null): Promise<AuthorizationRecord>;
  /** Resource configuration (deployment instance, environment class, source-to-tree mapping, freeze release), bound to a content digest. */
  configureResource(by: Principal, resourceId: string, bound: string, note?: string | null, tx?: Transaction): Promise<AuthorizationRecord>;
  /** Appends a resource decision inside the caller's transaction; the ordinary authorization checks still apply. */
  configureResourceInTransaction(by: Principal, object: string, bound: string | null, note: string, tx: Transaction, revoked?: boolean): Promise<AuthorizationRecord>;
  /** Latest active configuration of a resource, or null. */
  resourceConfig(resourceId: string): Promise<AuthorizationRecord | null>;
  /** Latest active decisions in one verified query; missing/revoked/expired entries are absent. */
  resourceConfigs(resourceIds: readonly string[]): Promise<Map<string, AuthorizationRecord>>;
  /** One share record per audience member. `object` is the key a reader check uses, for example `src:<sha256>` or a run id. */
  share(by: Principal, object: string, audience: ShareAudienceInput, note?: string | null): Promise<AuthorizationRecord[]>;
  unshare(by: Principal, object: string, userId: string | PackShareAudience, note?: string | null): Promise<AuthorizationRecord>;

  /** Current active shares; only an enabled administrator can list them. */
  shares(by: Principal, object?: string): Promise<AuthorizationRecord[]>;

  packsFor(userId: string): Promise<string[]>;
  canUse(userId: string, packId: string): Promise<boolean>;
  canPublish(userId: string): Promise<boolean>;
  usersOf(packId: string): Promise<string[]>;
  isSharedWith(userId: string, object: string): Promise<boolean>;

  /** Owner of a pack id: the subject of its first publication, or null when it was never published. */
  ownerOf(packId: string): Promise<string | null>;
  /** The owner's active publication of `pack-id@x.y.z` (with its bound digest), or null when unpublished, withdrawn or expired. */
  publication(packVersion: string): Promise<AuthorizationRecord | null>;
  /** True when publication() is non-null and, when `bound` is given, binds exactly that digest (B04 R[1], R[2]). */
  isPublished(packVersion: string, bound?: string): Promise<boolean>;
}

// ---------------------------------------------------------------- actions (B05) and pointers

/** Body of an `action@1` record: one immutable action the Hub performed itself. */
export interface ActionBody {
  action: ActionKind;
  run: string | null;
  item: string | null;
  /** Input references (reference URIs or record digests). */
  inputs: string[];
  /** component@version that performed the action. */
  component: string;
  /** Lease and fencing token; milestone 1 actions carry none. */
  lease: { lease: string; fencing: number } | null;
  started_at: string;
  ended_at: string;
  result: ActionResult;
  error_code: string | null;
  /** Receipt of a boundary validation (submissions and uploads); null for other actions. */
  acceptance: Acceptance | null;
  /** Every not-accepted code of a boundary validation, first cause first. */
  codes: string[];
  detail: Record<string, unknown>;
}

export interface PointerState {
  name: string;
  target: string;
  /** Number of moves so far, starting at 1. */
  version: number;
  moved_at: string;
  /** Digest of the move_root action record of the latest move. */
  action: string;
}

export interface MoveInput {
  name: string;
  /** Explicit metadata refresh without changing the target, guarded by the previous move. */
  refresh?: boolean;
  expected_action?: string | null;
  /** Expected current target; null when the pointer must not exist yet. */
  expected: string | null;
  next: string;
  /** Account that triggered the move, when a person did. */
  by?: Principal | null;
  /** Production run that triggered the move (B05 R[4]). */
  run?: string | null;
  /** component@version that decided the move, default records.pointers@1. */
  component?: string;
  note?: string | null;
}

export type MoveResult =
  | { moved: true; pointer: PointerState; action: StoredRecord<ActionBody> }
  | { moved: false; current: PointerState | null };

/** Named compare-and-set pointers (the current knowledge roots). Every move writes a move_root action in the same transaction. */
export interface Pointers {
  get(name: string, tx?: Transaction): Promise<PointerState | null>;
  move(input: MoveInput, tx?: Transaction): Promise<MoveResult>;
  /** Every pointer whose name starts with `prefix`, ordered by name. Read-only. */
  list(prefix: string): Promise<PointerState[]>;
  /** The move_root actions of one pointer, newest first by default. */
  history(name: string, query?: PageQuery): Promise<Page<StoredRecord<ActionBody>>>;
}

// ---------------------------------------------------------------- call log (B08)

export interface CallLogInput {
  /** Default now. */
  at?: Date | string;
  /** W3C trace-id: 32 lowercase hex characters, not all zero. */
  traceId: string;
  /**
   * The Hub's W3C span id for this call (16 lowercase hex characters, not all zero); generated when absent. Two calls with
   * equal fields stay two lines because their span ids differ; give the same span id when retrying a failed append.
   */
  spanId?: string;
  userId: string | null;
  /** Client session id from the Circle-Session-Id header (client declared). */
  sessionId: string | null;
  /** Tool name or protocol method. */
  tool: string;
  runId: string | null;
  /** The call arguments. Only their digest and size are kept; the content is never stored. */
  arguments: unknown;
  /**
   * B08 F[7]: at most 1024 bytes of the arguments after the server redacted them by the tool's input schema (every free-text,
   * secret or private field removed). Optional; not kept when the credential scanner flags it. See the README (decision 11).
   */
  argsPreview?: string | null;
  callResult: CallResult;
  acceptance?: Acceptance | null;
  errorCode?: string | null;
  durationMs: number;
  /** The real reason behind a neutral answer such as SOURCE_UNAVAILABLE. Kept outside the record; shown to admins only. */
  adminNote?: string | null;
  /** Full private reasons, individually stored outside the public record and JSONL. */
  adminReasons?:readonly string[];
}

/** Body of a `call_log@1` record: one MCP call (B08). The admin note is not part of it. */
export interface CallLogEntry {
  at: string;
  trace_id: string;
  span_id: string;
  user: string | null;
  session: string | null;
  tool: string;
  run: string | null;
  args_digest: string;
  args_size: number;
  args_preview: string | null;
  call_result: CallResult;
  acceptance: Acceptance | null;
  error_code: string | null;
  duration_ms: number;
}

/** A queried call-log line; JSONL stores its receipt fields only and omits private database metadata. */
export interface CallLogLine extends CallLogEntry {
  /** Digest of the call_log record; it does not cover the admin note. */
  digest: string;
  /** The real reason behind a neutral answer; present for admins and in append's result, never in JSONL. */
  admin_note?: string | null;
  /** Full reasons returned only by administrator queries; absent from JSONL and ordinary reader queries. */
  admin_reasons?:string[];
}

export interface CallLogQuery extends PageQuery {
  userId?: string;
  tool?: string;
  runId?: string;
  /** Inclusive lower and exclusive upper bound on `at`. */
  from?: string;
  to?: string;
}

export interface CallLog {
  /**
   * Records one call (database first, then the JSONL line). When the file write fails the call is still recorded and a
   * RecordsError says so; repeating append with the same input and span id writes the missing line.
   */
  append(input: CallLogInput): Promise<CallLogLine>;
  /**
   * Admins see every call with admin notes; a user sees only their own calls, without admin notes. The account is re-read
   * on every query (a disabled account sees nothing, a demoted admin only their own calls). Newest first by default.
   */
  query(principal: Principal, query?: CallLogQuery): Promise<Page<CallLogLine>>;
  /** Appends to the JSONL files every call logged in [from, to) that its file is missing (after a crash). Returns the lines written. */
  repairFiles(range: { from: string; to: string }): Promise<number>;
}

// ---------------------------------------------------------------- the kit

export interface RecordsKit {
  config: Pick<HubConfig, 'dataDir' | 'logDir' | 'limits'>;
  store: RecordStore;
  objects: ObjectStore;
  artifacts: Artifacts;
  vault: Vault;
  variables: import('./variables.ts').RecordVariables;
  principals: Principals;
  authorizations: Authorizations;
  pointers: Pointers;
  callLog: CallLog;
  close(): Promise<void>;
}

export interface OpenRecordsOptions {
  /** Optional instrumentation: credential-scanner byte counts only, never bytes or matched values. */
  onCredentialScan?: (byteLength: number) => void;
  /**
   * Default true: apply pending migrations (the connection's role then owns the tables). False for the runtime role, which
   * may only read and append: the schema must already be migrated by the owner (migrateRecords), else MigrationError.
   */
  migrate?: boolean;
  /** Supplies the vault key; without one every vault operation fails with VaultError. */
  keyProvider?: KeyProvider;
  /** Clock for created_at, expiry and the call log; default the system clock. */
  now?: () => Date;
  /** Connection pool size, default 10. */
  maxConnections?: number;
}

export type RecordsConfig = Pick<HubConfig, 'dataDir' | 'logDir' | 'database' | 'limits'>;
