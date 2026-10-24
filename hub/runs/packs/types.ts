// Types of the pack registry (T01 T02 B04): a pack directory as read, what validation and the publish check report, and a
// published version as the registry answers it. Stored bodies use snake_case field names like the contracts.
import type { CheckTier, PackKind, QualifierMark } from '../../../contracts/generated/vocabulary.ts';
import type {
  ChecksFile,
  KnowledgeFile,
  LedgerFile,
  PackManifest,
  PackSample,
  RequirementsFile,
  SAMPLE_SOURCES,
  SlotsFile,
  WorkflowFile,
} from '../../../contracts/src/pack.ts';
import type { ProductDeclaration } from '../../../contracts/src/product.ts';
import type { SystemProfile } from '../../../contracts/src/resources.ts';

/** Where a sample comes from (T02 R[1]), from the contracts. */
export type SampleSource = (typeof SAMPLE_SOURCES)[number];

/** The two sample folders of PACK_FILE_PATHS: a positive sample expects support only, a negative one some refutation. */
export type SamplePolarity = 'positive' | 'negative';

/**
 * One thing wrong with a pack, for its author. `rule` names the validator rule that failed (an identifier of this package
 * for tests and tools, not a protocol code). Messages and fixes are Chinese and name the file and the field.
 */
export interface PackProblem {
  rule: string;
  /** Pack-relative path of the file, or `.` for the directory itself. */
  file: string;
  /** RFC 6901 JSON Pointer into a JSON file, when the problem is one field. */
  field?: string;
  /** 1-based line in a code file. */
  line?: number;
  message: string;
  fix: string;
}

/** Size caps of a pack directory. A pack over a cap is refused whole, never truncated. */
export interface PackLimits {
  /** Files besides pack.json. */
  maxFiles: number;
  maxFileBytes: number;
  /** All listed files together. */
  maxTotalBytes: number;
  maxManifestBytes: number;
  /** Directory levels below the pack root. */
  maxDepth: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxDepth: 16,
};

/** A listed file with the bytes that were hashed: the bytes stored are exactly the bytes checked. */
export interface PackFile {
  path: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}

export interface PackDirectory {
  /** Absolute real path of the directory that was read. */
  root: string;
  manifest: PackManifest;
  /** SHA-256 of the RFC 8785 canonical JSON of the manifest (T01 F[0]): what a publication is bound to. */
  digest: string;
  /** The canonical JSON bytes of the manifest; their SHA-256 is the digest. Extracted packs carry them as pack.json. */
  manifestBytes: Uint8Array;
  /** Every listed file, in manifest order. */
  files: PackFile[];
}

export type PackRead = { ok: true; pack: PackDirectory } | { ok: false; problems: PackProblem[] };

export interface LoadedSample {
  file: string;
  polarity: SamplePolarity;
  sample: PackSample;
}

export interface WorkflowDeclarations {
  kind: Extract<PackKind, 'workflow'>;
  workflow: WorkflowFile;
  requirements: RequirementsFile;
  checks: ChecksFile;
  slots: SlotsFile;
  knowledge: KnowledgeFile | null;
  ledger?: LedgerFile | null;
  /** SKILL.md as text. */
  instructions: string;
  /** SHA-256 of the SKILL.md bytes. */
  instructionsDigest: string;
}

export interface ProductDeclarations {
  kind: Extract<PackKind, 'product'>;
  product: ProductDeclaration;
}

export interface SystemDeclarations {
  kind: Extract<PackKind, 'system'>;
  /** system.json (system@1 of contracts/src/resources.ts). */
  system: SystemProfile;
}

export type PackDeclarations = WorkflowDeclarations | ProductDeclarations | SystemDeclarations;

export interface ValidatedPack {
  directory: PackDirectory;
  declarations: PackDeclarations;
  /** The samples of a workflow pack (T01 F[10]); empty for other kinds. */
  samples: LoadedSample[];
  /** Problems that do not stop a publication. */
  warnings: PackProblem[];
}

export type PackValidation = { ok: true; pack: ValidatedPack } | { ok: false; problems: PackProblem[]; warnings: PackProblem[] };

// ---------------------------------------------------------------- publish check (T02)

export interface SampleFailure {
  check: string;
  sample: string;
  file: string;
  source: SampleSource;
  /** What differed between the declared expectation and the outcomes, in Chinese. */
  differences: string[];
}

export interface CheckSamples {
  check: string;
  /** The tier the check's outcomes get (declaration, else table, else advisory). */
  tier: CheckTier;
  positive: number;
  negative: number;
  sources: Record<SampleSource, number>;
  /** author_samples_only when no sample comes from outside the author (T02 R[1]). */
  marks: QualifierMark[];
}

export interface UnsampledCheck {
  check: string;
  tier: CheckTier;
  missing: SamplePolarity[];
}

export interface PublishReport {
  samples: { total: number; passed: number; failed: number; sources: Record<SampleSource, number> };
  checks: CheckSamples[];
  failures: SampleFailure[];
  /** Checks without a positive or a negative sample; a blocking one refuses the publication (C05 R[0]). */
  unsampled: UnsampledCheck[];
  warnings: PackProblem[];
}

// ---------------------------------------------------------------- the registry

/** Body of a `pack_version@1` record: one published pack version and what its publish check found. */
export interface PackVersionBody {
  pack: string;
  version: string;
  kind: PackKind;
  digest: string;
  title: string;
  description: string;
  manifest: PackManifest;
  publisher: string;
  report: PublishReport;
}

export interface PackVersionInfo {
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  digest: string;
  /** The subject of the first publication of the pack id. */
  owner: string;
  publisher: string;
  /** When the publication was decided. */
  published_at: string;
  withdrawn: boolean;
  withdrawn_at: string | null;
  /** Digest of the pack_version record. */
  record: string;
  /** Digest of the publication (authorization) record that published this version. */
  publication: string;
  /** Samples by source, summed over checks. */
  samples: Record<SampleSource, number>;
  report: PublishReport;
  manifest: PackManifest;
}

export interface PackInfo {
  id: string;
  kind: PackKind;
  owner: string;
  /** Product packs: assigned to the whole Hub. */
  active: boolean;
  /** Highest version that is not withdrawn. */
  latest: string | null;
  /** Every published version, withdrawn ones included, highest first. */
  versions: PackVersionInfo[];
}

export type PublishOutcome =
  | { ok: true; created: boolean; version: PackVersionInfo; report: PublishReport }
  | { ok: false; problems: PackProblem[]; report: PublishReport | null };

export interface AssignmentInfo {
  user: string;
  pack: string;
  decided_by: string;
  decided_at: string;
  expires_at: string | null;
  /** Digest of the authorization record. */
  record: string;
}
