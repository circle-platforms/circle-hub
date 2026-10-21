// Public surface of hub/knowledge: the content-addressed knowledge tree (K01-K05). createKnowledge returns an object that
// implements KnowledgePort (hub/ports.ts) exactly, plus the production, sync, current-root, calibration, placement,
// provenance and layer operations of this package. Other packages import only from this file.
export { createKnowledge } from './service.ts';
export type { BuildCalibrationInput, Knowledge, KnowledgeCalibration, KnowledgeOptions, KnowledgePlacement } from './service.ts';

export type { KnowledgeLimits, KnowledgeRecords } from './context.ts';
export { DEFAULT_KNOWLEDGE_LIMITS, DEFAULT_SANDBOX } from './context.ts';

export type { ProduceInput, ProduceResult, PlannedSource } from './produce.ts';
export { catalogData, plannedSources } from './produce.ts';

export type { BuildOutcome, SyncBuildReport, SyncOptions, SyncReport } from './sync.ts';
export { DEFAULT_MAX_READS, DEFAULT_MAX_ROUNDS } from './sync.ts';

export type { LineReconciliation, MoveRootOptions, MoveRootResult } from './builds.ts';
export { compareNewestFirst, pointerName } from './builds.ts';

export type { CompositionIndex, ProvenanceRow, TreeLock } from './read.ts';
export { MAX_NODE_PATHS, UNDECLARED, applicabilityText } from './read.ts';

export type { CalibrationState, LabelledSamplesInput, ThresholdResult } from './calibration.ts';
export { CALIBRATION, PLACEMENT_CHAIN, maskLiterals, thresholdOf, wilsonLowerBound } from './calibration.ts';

export type { PlaceOptions, PlacementChild, PlacementOutcome, PlacementSpan, PlacementTree } from './placement.ts';
export { MAX_REAL_OPTIONS, belowThreshold, narrowCandidates, optionNames, placementNote, placementQuestion, questionId, sampleInput } from './placement.ts';

export type { CandidateInput, CandidateView } from './layers.ts';
export { CandidateLayer, ObservationLayer } from './layers.ts';

export type { EntryContent, NodeContent } from './digest.ts';
export { cutText, entryContentOf, entryDigest, nodeDigest, normaliseApplicability, normaliseStatement } from './digest.ts';

export { COMPONENTS, INDEX, SCHEMAS, KnowledgeStore, buildProblem } from './store.ts';
export { KnowledgeError } from './errors.ts';

export type { KnowledgeCliCommand, KnowledgeCliContext, KnowledgeSyncArgs } from './cli.ts';
export { KNOWLEDGE_SYNC_USAGE, formatSyncReport, knowledgeCliCommand, knowledgeSync, parseKnowledgeSyncArgs } from './cli.ts';
