// Interfaces between packages that are built at the same time. A package that provides a port exports a factory returning it
// from its api.ts; a package that needs one takes it as an argument and imports nothing else of the provider. Tests use fakes.
// A port answers only what its consumers need; whatever else a provider offers stays in the provider's own api.ts.
import type { z } from 'zod';
import type { PackKind } from '../contracts/generated/vocabulary.ts';
import type { Coverage } from '../contracts/src/common.ts';
import type { ChecksFile, KnowledgeFile, PackManifest, RequirementsFile, SlotsFile, WorkflowFile } from '../contracts/src/pack.ts';
import type { PackSummary } from '../contracts/src/run.ts';
import type { ProductDeclaration, KnownBuild } from '../contracts/src/product.ts';
import type { ProtocolError } from '../contracts/src/common.ts';
import type { RunRecord } from '../contracts/src/run.ts';
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
  pack: PackHandle;
  manifest: PackManifest;
  workflow: WorkflowFile;
  requirements: RequirementsFile['requirements'];
  checks: ChecksFile['checks'];
  slots: SlotsFile;
  knowledge: KnowledgeFile | null;
  /** SKILL.md: the procedure start_run hands to the model, as plain text. */
  instructions: string;
  /** SHA-256 of the SKILL.md bytes. */
  instructionsDigest: string;
  /** JSON of a pack file (a table under tables/ or policies/), parsed; throws when the file is not in the pack. */
  readJson(path: string): unknown;
}

/** What the engine needs of the pack registry (provided by runs/packs, consumed by runs/engine and the server). */
export interface WorkflowStore {
  /** A version the user may use: `id` (latest published, assigned to the user) or `id@version`. Unknown, unassigned and withdrawn give the same null. */
  forUser(user: Principal, ref: string): Promise<LoadedWorkflow | null>;
  /** The exact version a run froze, by pack digest. Answers even after a withdrawal, so that existing runs can be read and finished. */
  byDigest(digest: string): Promise<LoadedWorkflow | null>;
  /** list_task_packs: the packs the user may use, with their requirements and inputs. Product and system packs never appear. */
  summaries(user: Principal): Promise<PackSummary[]>;
}

// ---------------------------------------------------------------- external systems (provided by connectors)

export interface ExternalReadContext {
  /** Whose credential and visibility the read uses: the user of a run, or an admin for a standing sync. */
  principal: Principal;
  run?: string | null;
  /** Free text for the admin log, for example "sync" or "expected source". */
  purpose: string;
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
 * is for the admin log, callers show the neutral SOURCE_UNAVAILABLE.
 */
export type ExternalRead =
  | { ok: true; id: string; revision: string | null; artifacts: ExternalArtifact[]; manifest: string }
  | { ok: false; id: string; reason: string };

export interface ExternalReaderPort {
  /** Whether some enabled resource declares this external object type (`system:type:id`). */
  accepts(id: string): Promise<boolean>;
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
  acceptance: Acceptance;
  errors: ProtocolError[];
  /** Digest of the validation_result record, when the submission was accepted. */
  result: string | null;
}

/** Everything the console shows about one run. */
export interface RunDetail {
  run: RunRecord;
  submissions: RunSubmissionView[];
  /** The latest validation result (an accepted submission, or the result of a production run), with its record digest. */
  latest: { record: string; result: ValidationResult } | null;
}

export interface RunsService {
  /** Absent and forbidden give the same SOURCE_UNAVAILABLE answer with the tool's empty shape. */
  startRun(user: Principal, input: z.infer<typeof StartRunInput>, context: CallContext): Promise<Untraced<z.infer<typeof StartRunOutput>>>;
  /** `args` are the raw arguments of the call: they are stored as received before anything else (W07). */
  submitResult(user: Principal, args: Record<string, unknown>, context: CallContext): Promise<Untraced<z.infer<typeof SubmitResultOutput>>>;
  resolveReference(user: Principal, input: z.infer<typeof ResolveReferenceInput>, context: CallContext): Promise<Untraced<z.infer<typeof ResolveReferenceOutput>>>;
  /** Own runs for a user, any run for an admin; null when absent or forbidden. */
  getRun(user: Principal, run: string): Promise<RunDetail | null>;
  /** Own runs for a user, every run for an admin, newest first. */
  listRuns(user: Principal, query?: { pack?: string; limit?: number; cursor?: string | null }): Promise<Page<RunRecord>>;
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

export interface RootInfo {
  /** Root node digest: what a run locks and what tree references name. Equal content gives equal roots. */
  root: string;
  /** Digest of the tree_root record that composed it (the build it was produced for and what every entry rests on). */
  composition: string;
  product: string;
  build: KnownBuild;
  produced_at: string;
}

export interface NodesQuery {
  root: string;
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

export interface KnowledgePort {
  /** Builds the knowledge base knows for a product, any name family, newest first. */
  builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]>;
  /** Any build name, of any family, to the build record whose tree it uses (aliases resolved). Null when unknown. */
  resolveBuild(product: string, name: string): Promise<KnownBuild | null>;
  /** The root of the newest produced build of a version line. */
  currentRoot(product: string, line: string): Promise<RootInfo | null>;
  /** The root a build name of any family resolves to. This is what a run locks. */
  rootOfBuild(product: string, name: string): Promise<RootInfo | null>;
  /** Every composition record of a root digest (equal content from different builds shares one root). */
  rootInfo(root: string): Promise<RootInfo[]>;
  /** The closed catalog declared by the product pack, built from the entries of the root; null when the root has none of that id. */
  catalog(root: string, catalogId: string): Promise<CatalogView | null>;
  /**
   * Reads nodes and entries for reference resolution; permission is enforced inside. `lock.composition` binds the reader to the
   * composition a run locked (RootInfo.composition): grounds and premises come from it alone.
   */
  treeReader(lock?: { composition?: string | null } | null): TreeReader;
  /** Absent and forbidden give the same null (D05 R[3]). */
  getNodes(query: NodesQuery, reader: Principal): Promise<NodesPage | null>;
  diffRoots(from: string, to: string): Promise<RootDiff | null>;
}
