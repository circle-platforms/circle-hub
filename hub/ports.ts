import type {ProtocolCode} from '../contracts/generated/protocol.ts';
import type {SourceAbsent} from '../contracts/src/resources.ts';
// Interfaces between packages that are built at the same time. A package that provides a port exports a factory returning it
// from its api.ts; a package that needs one takes it as an argument and imports nothing else of the provider. Tests use fakes.
// A port answers only what its consumers need; whatever else a provider offers stays in the provider's own api.ts.
import type { z } from 'zod';
import type { EntryKind, PackKind, RequestKind, ExitAction } from '../contracts/generated/vocabulary.ts';
import type { PathChange } from '../contracts/src/views.ts';
import type { Coverage } from '../contracts/src/common.ts';
import type { ChecksFile, LedgerFile, KnowledgeFile, PackManifest, RequirementsFile, SlotsFile, WorkflowFile } from '../contracts/src/pack.ts';
import type { PackSummary } from '../contracts/src/run.ts';
import type { ProductDeclaration, KnownBuild } from '../contracts/src/product.ts';
import type { ProtocolError } from '../contracts/src/common.ts';
import type { RunRecord, RunRecordView } from '../contracts/src/run.ts';
import type { ResolveReferenceInput, ResolveReferenceOutput, StartRunInput, StartRunOutput, SubmitResultOutput, GetNodesOutput } from '../contracts/src/tools.ts';
import type { ValidationResult } from '../contracts/src/validation.ts';
import type { Acceptance } from '../contracts/generated/vocabulary.ts';
import type { Page, Principal, SourceArtifact } from './records/api.ts';
import type { TreeReader } from './refs/api.ts';
import type { CatalogView } from './rules/api.ts';

// ---------------------------------------------------------------- packs (provided by runs)

/** A published pack version, extracted into a read-only directory that pack functions run in. */
export interface PackHandle {
  id: string;
  version: string;
  /** SHA-256 of the pack content: the digest its publication is bound to. */
  digest: string;
  kind: PackKind;
  directory: string;
}

/** A product pack with its validated product.json. */
export interface ProductHandle extends PackHandle {
  kind: Extract<PackKind, 'product'>;
  product: ProductDeclaration;
}

export interface PacksPort {
  /** `id` (latest published version) or `id@version`. Null when unknown, withdrawn or retired. */
  pack(ref: string): Promise<PackHandle | null>;
  /** The latest published product pack that declares this name (case-insensitive, any of its names). */
  productByName(name: string): Promise<ProductHandle | null>;
  productById(id: string): Promise<ProductHandle | null>;
  products(): Promise<ProductHandle[]>;
  /** Product lines whose knowledge the user may read: those bound by a pack assigned to them. Admins read every product. */
  readableProducts(user: Principal): Promise<ReadonlySet<string>>;
}

/**
 * A published workflow pack version, loaded and validated. Everything a run needs from the pack is here; table files and
 * functions are read from `pack.directory` (tables by the engine, functions by the sandbox).
 */
export interface LoadedWorkflow {
  /** Owner of this publication, for package repair exits; absent only on legacy test ports. */
  owner?: string;
  pack: PackHandle;
  manifest: PackManifest;
  workflow: WorkflowFile;
  requirements: RequirementsFile['requirements'];
  /** The declared effect rows (V07 R[5]): the rounds a dispatch row writes decide the repetition in force. */
  effects?: RequirementsFile['effects'];
  checks: ChecksFile['checks'];
  slots: SlotsFile;
  knowledge: KnowledgeFile | null;
  ledger?: LedgerFile | null;
  /** SKILL.md: the procedure start_run hands to the model, as plain text. */
  instructions: string;
  /** SHA-256 of the SKILL.md bytes. */
  instructionsDigest: string;
  /** JSON of a pack file (a table under tables/ or policies/), parsed; throws when the file is not in the pack. */
  readJson(path: string): unknown;
}

/** Why forUser had no workflow. null from absence means the version is published, assigned and not withdrawn. */
export type WorkflowAbsence = 'unknown' | 'unassigned' | 'withdrawn' | 'disabled';

/** What the engine needs of the pack registry (provided by runs/packs, consumed by runs/engine and the server). */
export interface WorkflowStore {
  /** Owner of a published workflow version, for named B07 repair requests. */
  ownerOf?(digest: string): Promise<string | null>;
  publicationOf?(digest: string): Promise<string | null>;
  /** A version the user may use: `id` (latest published, assigned to the user) or `id@version`. Unknown, unassigned and withdrawn give the same null. */
  forUser(user: Principal, ref: string): Promise<LoadedWorkflow | null>;
  /** Installed skill packages may expose local tools without declaring a workflow method. */
  skillForTools?(user: Principal, ref: string): Promise<Pick<LoadedWorkflow, 'pack' | 'manifest'> | null>;
  /**
   * Admin-log reason when forUser returned null. Does not extract the pack. null means the version is published, assigned
   * and not withdrawn, so the caller has another reason (for example the manifest has no tools/).
   * Optional so a store that only implements forUser keeps the combined note.
   */
  absence?(user: Principal, ref: string): Promise<WorkflowAbsence | null>;
  /** The exact version a run froze, by pack digest. Answers even after a withdrawal, so that existing runs can be read and finished. */
  byDigest(digest: string): Promise<LoadedWorkflow | null>;
  /** list_task_packs: the packs the user may use, with their requirements and inputs. Product and system packs never appear. */
  summaries(user: Principal): Promise<PackSummary[]>;
}

// ---------------------------------------------------------------- external systems (provided by connectors)

export interface ExternalReadContext {
  feeding_offset?: import('../contracts/src/feeding.ts').FeedingOffset;
  /** Private diagnostics for the calling service; never part of read content. */
  adminNote?:(reason:string)=>void;
  /** Ordinary-variable decisions frozen for this caller; never persisted as run parameters. */
  variables?: ReadonlyMap<string,string>;
  /** Whose credential and visibility the read uses: the user of a run, or an admin for a standing sync. */
  principal: Principal;
  run?: string | null;
  /** Free text for the admin log, for example "sync" or "expected source". */
  purpose: string;
  /** Composition already selected by the caller; it is never replaced with a newer production. */
  composition?: string | null;
  /** Product-wide snapshot selected before the run is persisted; null explicitly means none. */
  unversioned?: {root:string;composition:string} | null;
  /** Canonical name of the build selected by the run; absent on legacy callers. */
  build?:string;
}

/** Names the engine looks for in the artifacts of a read: the response as received, the content to parse, and metadata about the object. */
export const EXTERNAL_ARTIFACT = { original: 'original', content: 'content', meta: 'meta' } as const;

export interface ExternalArtifact {
  /** `original` for the response as received; a derived artifact has the name its system pack gave it (`content`, `meta`, ...). */
  name: string;
  artifact: SourceArtifact;
}

/**
 * Result of reading one external object. On success the artifact named `original` is the response as received (stored by
 * SHA-256 before anything interprets it) and the others are artifacts derived from it by the system pack's projection. When a
 * `content` artifact exists it is what a consumer parses; otherwise the original is. A failure is never an exception: `reason`
 * is for the admin log; inputError is a deterministic caller-input problem safe for an authorized reader,
 * while read exhaustion carries retry metadata and permission failures remain neutral.
 */
export interface ExternalRedirect {status:number;location:string|null;observed_at:string;location_redacted?:true}

export interface ExternalReadRetry {code:string;at:string;attempts:number}

export type ExternalRead =
  | { ok: true; id: string; revision: string | null; artifacts: ExternalArtifact[]; manifest: string; coverage?:Coverage;absent?:SourceAbsent }
  | { ok: false; id: string; reason: string; manifest?:string|null; retry?:ExternalReadRetry; redirect?:ExternalRedirect; inputError?: { code?:ProtocolCode; message: string; fix: string } };

export interface ExternalReaderPort {
  /** Whether some enabled resource declares this external object type (`system:type:id`). */
  accepts(id: string, context?:ExternalReadContext): Promise<boolean>;
  read(id: string, context: ExternalReadContext): Promise<ExternalRead>;
}

// ---------------------------------------------------------------- runs (provided by runs-engine, consumed by the server)

/** What the server knows about the call: the W3C trace id and the client session id it observed (Circle-Session-Id). */
export interface CallContext {
  traceId: string;
  sessionId: string | null;
  /** The real reason behind a neutral answer (absent, forbidden, failed): admins see it in the call log, the caller never does. */
  adminNote?: (reason: string) => void;
}

/** A service answers with the tool output minus the trace id, which only the server knows. */
export type Untraced<T> = Omit<T, 'trace'>;

export interface RunSubmissionView {
  /** Digest of the stored submission record. */
  record: string;
  received_at: string;
  acceptance: Acceptance | null;
  errors: ProtocolError[];
  /** Digest of the validation_result record, when the submission was accepted. */
  result: string | null;
}

export interface RunRequestView {
  record:string; answer_action?:ExitAction; run?:string; pack_digest?:string; job?:string; sources?:string[]; kind:RequestKind; audience:string; due:string; missing:string; next_action:string;
  source:string; code:string; item?:string; requirement?:string; answered_by:string|null;
}

/** Everything the console shows about one run. */
export interface RunDetail {
  /** Live read qualifier, outside immutable run/result records and their digests. */
  rule_withdrawn?: true;
  management?:{record:string;disposition:'abandon';result:string|null};
  run: RunRecordView;
  submissions: RunSubmissionView[];
  requests?: RunRequestView[];
  /** The latest validation result (an accepted submission, or the result of a production run), with its record digest. */
  latest: { record: string; result: ValidationResult } | null;
  /** The result computed at start_run (submission equals this run record's digest), never a later commentary result. */
  production: { record: string; result: ValidationResult } | null;
}

export interface RunListing extends Page<RunRecordView> {requests?:RunRequestView[];overdue_requests?:RunRequestView[];open_runs?:string[]}

export interface RunsService {
  abandonRun?(user:Principal,run:string,request:string,reason:string):Promise<{record:string;result:ValidationResult;decision:string;created:boolean;current:boolean}>;
  listRequests?(user: Principal, run?: string): Promise<RunRequestView[]>;
  /** Absent and forbidden give the same SOURCE_UNAVAILABLE answer with the tool's empty shape. */
  startRun(user: Principal, input: z.infer<typeof StartRunInput>, context: CallContext): Promise<Untraced<z.infer<typeof StartRunOutput>>>;
  /** `args` are the raw arguments of the call: they are stored as received before anything else (W07). */
  submitResult(user: Principal, args: Record<string, unknown>, context: CallContext): Promise<Untraced<z.infer<typeof SubmitResultOutput>>>;
  resolveReference(user: Principal, input: z.infer<typeof ResolveReferenceInput>, context: CallContext): Promise<Untraced<z.infer<typeof ResolveReferenceOutput>>>;
  /** Own runs for a user, any run for an admin; null when absent or forbidden. */
  getRun(user: Principal, run: string): Promise<RunDetail | null>;
  /** Own runs for a user, every run for an admin, newest first. */
  listRuns(user: Principal, query?: { pack?: string; limit?: number; cursor?: string | null }): Promise<RunListing>;
}

// ---------------------------------------------------------------- read-only listings for the console

export interface PackListing {
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  /** User id of the owner (the subject of the first publication). */
  owner: string;
  digest: string;
  published_at: string;
  withdrawn: boolean;
  /** Product packs: assigned to the whole Hub by an admin. */
  active: boolean;
  /** Samples by source, summed over checks (workflow packs). */
  samples: Record<string, number>;
  /** User ids the pack is assigned to; filled for admins only. */
  assigned_to?: string[];
}

/** Provided by runs-packs. A user lists the packs assigned to them; an admin lists every pack. */
export interface PackCatalogPort {
  list(user: Principal): Promise<PackListing[]>;
}

export interface ResourceListing {
  /** A broken bound profile, admins only; absence is never silently treated as disabled. */
  binding_error?:{code:string;message:string;fix:string};
  id: string;
  system_pack: string;
  name: string;
  environment: string;
  enabled: boolean;
  /** Base URL of each role; filled for admins only. */
  origins?: Record<string, string>;
  /** Origins declared as allowed to carry credentials over plain HTTP; filled for admins only. */
  allow_plaintext?: string[];
}

/** Provided by connectors. Admins only: any other principal gets an empty list. */
export interface ResourceCatalogPort {
  list(user: Principal): Promise<ResourceListing[]>;
}

// ---------------------------------------------------------------- knowledge (provided by knowledge)

export interface RootInfo<B extends KnownBuild | null = KnownBuild> {
  /** Product command rules attested by this exact locked composition, when supplied by a knowledge backend. */
  command_policy?: import('../contracts/src/product.ts').CommandPolicy;
  /** Root node digest: what a run locks and what tree references name. Equal content gives equal roots. */
  root: string;
  /** Digest of the tree_root record that composed it (the build it was produced for and what every entry rests on). */
  composition: string;
  product: string;
  build: B;
  source_count?: number;
  produced_at: string;
}

export interface NodesQuery {
  feeding_offset?: import('../contracts/src/feeding.ts').FeedingOffset;
  root: string;
  composition?: string | null;
  /** Node paths as returned by earlier calls, `/` for the root. */
  paths: string[];
  /** Levels below each path. */
  depth: number;
  cursor?: string | null;
}

/** The node view get_nodes returns (contracts/src/tools.ts). */
export type NodeViews = NonNullable<z.infer<typeof GetNodesOutput>['nodes']>;

export interface NodesPage {
  nodes: NodeViews;
  next: string | null;
  coverage: Coverage;
}

/** Tree paths where two roots differ: nodes or entries only in `to`, only in `from`, or changed in content. */
export interface RootDiff {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * The entry-level version difference of two roots (K01 R[1]: the version difference is the regression scope): every path
 * whose own entries of the given kinds differ, with their digests in each root and the change kind (axis change_kind).
 */
export interface EntryDiff {
  from: string;
  to: string;
  kinds: EntryKind[];
  /** Sorted by path (code units of the canonical path text); at most `limit`. */
  changes: PathChange[];
  /** Every changed path, also those beyond the limit. */
  total: number;
  truncated: boolean;
}

/** A build name, a version line, or both. A named build selects its own line. */
export interface ReadRootQuery {
  build?: string | null;
  line?: string | null;
}

/**
 * The root a run locks and a view reads. `source` says which pointer won. `sync` is the sync root only when it is a
 * different digest from the seedling; views name both digests in that case.
 */
export interface ReadRoot {
  info: RootInfo;
  source: 'seedling' | 'sync';
  sync: RootInfo | null;
}

export interface KnowledgePort {
  feeding?:import('./knowledge/feeding.ts').FeedingLayer;
  seedlingRoot?(product:string,line:string):Promise<RootInfo|null>;
  /** Seedling pointer of the line, otherwise the sync root. Absent on older ports; runs then keep the seedling-then-sync fallback. */
  rootForRead?(product: string, query: ReadRootQuery): Promise<ReadRoot | null>;
  /** Current product-wide root; absent on older ports. */
  unversionedRoot?(product: string): Promise<(RootInfo<null> & { source_count: number }) | null>;
  /** Sources recorded in the compositions of a root. */
  rootSources?(root: string): Promise<import('../contracts/src/knowledge.ts').RootSource[]>;
  /** Builds the knowledge base knows for a product, any name family, newest first. */
  builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]>;
  /** Any build name, of any family, to the build record whose tree it uses (aliases resolved). Null when unknown. */
  resolveBuild(product: string, name: string): Promise<KnownBuild | null>;
  /** The root of the newest produced build of a version line. */
  currentRoot(product: string, line: string): Promise<RootInfo | null>;
  /** The sync root a build name resolves to: the latest completed production of its base. */
  rootOfBuild(product: string, name: string): Promise<RootInfo | null>;
  /** Every composition record of a root digest (equal content from different builds shares one root). */
  rootInfo(root: string): Promise<RootInfo<KnownBuild | null>[]>;
  /** The closed catalog declared by the product pack, built from the entries of the root; null when the root has none of that id. */
  catalog(root: string, catalogId: string, selection?: {base:string;lines:string[]}): Promise<CatalogView | null>;
  /**
   * Reads nodes and entries for reference resolution; permission is enforced inside. `lock.composition` binds the reader to the
   * composition a run locked (RootInfo.composition): grounds and premises come from it alone.
   */
  treeReader(lock?: { composition?: string | null; compositions?: string[] } | null): TreeReader;
  /** Absent and forbidden give the same null (D05 R[3]). */
  getNodes(query: NodesQuery, reader: Principal): Promise<NodesPage | null>;
  diffRoots(from: string, to: string): Promise<RootDiff | null>;
  /**
   * Paths whose own entries of `kinds` differ between the roots: added (only in `to`), removed (only in `from`) or modified,
   * with the digests before and after, sorted by path, at most `limit` (default 20000). Null when a root is unknown. Like
   * diffRoots it takes no reader: callers check the reader first.
   */
  diffEntries(from: string, to: string, options: { kinds: readonly EntryKind[]; limit?: number }): Promise<EntryDiff | null>;
}

/** Internal effect-boundary metadata, frozen with the same ordinary-variable snapshot as start_run. */
export interface EffectRegistryPort {
 snapshot(variables:import('./records/api.ts').VariableSnapshot):Promise<{policy:string;executors:string}>;
}

/** Pure re-evaluation of named frozen-package checks; it cannot store submissions or spend repair rounds. */
export interface EffectCheckReplay {
 (input:{run:string;submission:string;result?:string;checks:readonly string[]}):Promise<Record<string,import('../contracts/src/tables.ts').CheckOutcome[]>>;
}
