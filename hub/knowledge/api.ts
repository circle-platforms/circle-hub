// Public surface of hub/knowledge: the content-addressed knowledge tree (K01-K05). createKnowledge returns an object that
// implements KnowledgePort (hub/ports.ts) exactly, plus the production, sync, current-root, calibration, placement,
// provenance, layer and view operations of this package. createKnowledgeReader serves the knowledge views as external
// objects (ExternalReaderPort); routeKnowledgeViews puts it beside the connectors' reader for the run engine. Other packages
// import only from this file.
import type { ExternalReaderPort } from '../ports.ts';
import type { Knowledge } from './service.ts';
import { viewReader } from './views.ts';

export { createKnowledge } from './service.ts';
export type { BuildCalibrationInput, Knowledge, KnowledgeCalibration, KnowledgeOptions, KnowledgePlacement } from './service.ts';

/** The knowledge views (`knowledge:impact|facets|index:...`, contracts/src/views.ts) as an ExternalReaderPort. */
export function createKnowledgeReader(knowledge: Knowledge): ExternalReaderPort {
  return viewReader(knowledge.views);
}

export type { KnowledgeLimits, KnowledgeRecords } from './context.ts';
export { DEFAULT_KNOWLEDGE_LIMITS, DEFAULT_SANDBOX } from './context.ts';

export type { ProduceInput, ProduceResult, PlannedSource } from './produce.ts';
export { catalogData, plannedSources } from './produce.ts';

export { DEFAULT_BATCH, buildDigest, listBatches, memoKey, uniqueList } from './lists.ts';
export type { ListBatch, MemoKeyInput } from './lists.ts';

export { CompositionView, PART_MAX_BYTES, PART_MAX_ROWS, PART_MIN_ROWS, PART_TARGET_ROWS, splitRows } from './composition.ts';
export type { ReadRow } from './composition.ts';

export type { BuildOutcome, SyncBuildReport, SyncOptions, SyncReport } from './sync.ts';
export { DEFAULT_MAX_READS, DEFAULT_MAX_ROUNDS } from './sync.ts';

export type { LineReconciliation, MoveRootOptions, MoveRootResult } from './builds.ts';
export { compareNewestFirst, pointerName } from './builds.ts';

export type { ProvenanceRow, TreeLock } from './read.ts';
export { MAX_NODE_PATHS, UNDECLARED, applicabilityText } from './read.ts';

export type { ViewRequest } from './views.ts';
export {
  DEFAULT_ATTACHED_KINDS,
  DEFAULT_CHANGED_KINDS,
  KnowledgeViews,
  MAX_FACET_COMBINATIONS,
  MAX_ONLY_VALUES,
  VIEW_SYSTEM,
  compareValues,
  parseViewId,
  routeKnowledgeViews,
} from './views.ts';

export type { CalibrationState, LabelledSamplesInput, ThresholdResult } from './calibration.ts';
export { CALIBRATION, PLACEMENT_CHAIN, maskLiterals, thresholdOf, wilsonLowerBound } from './calibration.ts';

export type { PlaceOptions, PlacementChild, PlacementOutcome, PlacementSpan, PlacementTree } from './placement.ts';
export { MAX_REAL_OPTIONS, belowThreshold, narrowCandidates, optionNames, placementNote, placementQuestion, questionId, sampleInput } from './placement.ts';

export { ObservationLayer } from './layers.ts';
export { ContributionLayer, ContributionRefusal } from './contributions.ts';
export type { ContributionScope, ContributionOrigin, PreparedContribution, ContributionAdmissionCode } from './contributions.ts';

export type { EntryContent, NodeContent } from './digest.ts';
export { cutText, entryContentOf, entryDigest, nodeDigest, normaliseApplicability, normaliseStatement } from './digest.ts';

export { COMPONENTS, INDEX, SCHEMAS, KnowledgeStore, buildProblem } from './store.ts';
export { KnowledgeError } from './errors.ts';

export type { KnowledgeCliCommand, KnowledgeCliContext, KnowledgeSyncArgs } from './cli.ts';
export { KNOWLEDGE_SYNC_USAGE, formatSyncReport, knowledgeCliCommand, knowledgeSync, parseKnowledgeSyncArgs } from './cli.ts';
export type { KnowledgeSeedArgs, SeedReport, SeedRoleName } from './seed.ts';
export { KNOWLEDGE_SEED_USAGE, formatSeedReport, knowledgeSeed, parseKnowledgeSeedArgs, seedRoles } from './seed.ts';

export { LinkReading, relationFacts, resolveLiteral } from './links.ts';
export type { RelationFacts, RelationNodes, LiteralSource, LinkRequest } from './links.ts';

export {completeKnowledgeView} from './complete-view.ts';

export {scheduleSync} from './sync-schedule.ts';
export {productVariableProblems,variableUsesOfRoot} from './variables.ts';

export {FeedingLayer} from './feeding.ts';
export type {FeedingScope,FeedingReceipt,FeedingView} from './feeding.ts';
