// Public surface of hub/runs. Other packages import only from this file. The pack registry (runs-packs, hub/runs/packs)
// provides PacksPort, WorkflowStore and PackCatalogPort of hub/ports.ts; the run engine (hub/runs/engine) consumes them only
// through hub/ports.ts and publishes its surface in hub/runs/engine/api.ts, re-exported here whole.

// ---------------------------------------------------------------- run engine (its own api.ts)
export * from './engine/api.ts';

// ---------------------------------------------------------------- pack registry (T01 T02 B04)
export { createPackRegistry, PACK_VERSION_SCHEMA, productNameKey } from './packs/registry.ts';
export type { ActiveProduct, OpenedPack, PackRegistry, PackRegistryOptions, RegistryRecords } from './packs/registry.ts';

export { createPackCatalog, createPacksPort, createWorkflowStore, boundProducts, packSummary } from './packs/ports.ts';
/** T02 R[1] for a run: check id -> marks (author_samples_only) of a LoadedWorkflow, as its stored publish report has them. */
export { publishCheckMarks } from './packs/marks.ts';

// Reading and validating a pack directory without a database (publish tooling, pack authors' checks).
export { readPackDirectory, manifestDigest, MANIFEST_FILE } from './packs/directory.ts';
export { validatePack, closedSetsOf, effectiveTier, isKnownCode } from './packs/validate.ts';
export type { ValidateOptions } from './packs/validate.ts';
export { runPublishCheck, refusalsOf, sampleDifferences } from './packs/samples.ts';
export type { PublishCheckInput } from './packs/samples.ts';
export { scanFunctions, SANDBOX_IMPORT_POLICY } from './packs/imports.ts';
export type { FunctionEntry, ImportPolicy } from './packs/imports.ts';
export { PackFileError } from './packs/load.ts';
export type { TamperEvent } from './packs/extract.ts';
export { compareVersions, highestVersion, isCanonicalVersion, MAX_PACK_REF_LENGTH, parsePackRef } from './packs/versions.ts';
export type { PackRef } from './packs/versions.ts';
export { DEFAULT_PACK_LIMITS } from './packs/types.ts';
export type {
  AssignmentInfo,
  CheckSamples,
  LoadedSample,
  PackDeclarations,
  PackDirectory,
  PackFile,
  PackInfo,
  PackLimits,
  PackProblem,
  PackRead,
  PackValidation,
  PackVersionBody,
  PackVersionInfo,
  ProductDeclarations,
  PublishOutcome,
  PublishReport,
  SampleFailure,
  SamplePolarity,
  SampleSource,
  SystemDeclarations,
  UnsampledCheck,
  ValidatedPack,
  WorkflowDeclarations,
} from './packs/types.ts';

// ---------------------------------------------------------------- test support (synthetic packs; never product content)
export {
  corruptByte,
  editJson,
  productPack,
  signPack,
  systemPack,
  temporaryDirectory,
  withFiles,
  workflowPack,
  writeManifest,
  writePack,
} from './packs/testing/builder.ts';
export type { FileContent, PackDescription, WrittenManifest, WrittenPack } from './packs/testing/builder.ts';

export {recheckEffectChecks} from './engine/recheck-effect.ts';
export { packSchema } from './engine/slots.ts';

export {runById} from './engine/store.ts';
export {canViewRun} from './engine/readers.ts';
