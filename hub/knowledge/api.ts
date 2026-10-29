// Public surface of hub/knowledge: the content-addressed knowledge tree (K01-K05). createKnowledge returns an object that
// implements KnowledgePort (hub/ports.ts) exactly, plus the production, sync, current-root, calibration, placement,
// provenance, layer and view operations of this package. createKnowledgeReader serves the knowledge views as external
// objects (ExternalReaderPort); routeKnowledgeViews puts it beside the connectors' reader for the run engine. Other packages
// import only from this file.
import type { ExternalReaderPort } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { KnowledgeError } from './errors.ts';
import type { FeedingLayer } from './feeding.ts';
import type { Knowledge } from './service.ts';
import { viewReader } from './views.ts';

export { createKnowledge } from './service.ts';
export { recoverySourcesReadable } from './recovery-sources.ts';
export type { BuildCalibrationInput, Knowledge, KnowledgeCalibration, KnowledgeOptions, KnowledgePlacement } from './service.ts';
export type { ReadRoot, ReadRootQuery } from '../ports.ts';

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

export interface KnowledgeRetractRequest {
  entries: readonly string[];
  runs: readonly string[];
  objects: readonly string[];
  reason: string;
  /** Command clock, not a clock read inside retract. */
  at: string;
}

export interface KnowledgeRetractReport {
  appended: Array<{ record: string; kind: 'entries' | 'runs' | 'objects'; count: number; reason: string }>;
  skipped: Array<{ kind: 'entry' | 'run' | 'object'; id: string; records: readonly string[] }>;
}

const RETRACT_LABEL = { entries: '条目', runs: '运行', objects: '对象', entry: '条目', run: '运行', object: '对象' } as const;

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** Appends one retraction@1 per target kind through FeedingLayer.retract. Already covered targets are not appended. */
export async function knowledgeRetract(feeding: FeedingLayer, by: Principal, request: KnowledgeRetractRequest): Promise<KnowledgeRetractReport> {
  const groups = [
    { kind: 'entries' as const, cover: 'entry' as const, ids: uniqueIds(request.entries) },
    { kind: 'runs' as const, cover: 'run' as const, ids: uniqueIds(request.runs) },
    { kind: 'objects' as const, cover: 'object' as const, ids: uniqueIds(request.objects) },
  ].filter(group => group.ids.length > 0);
  if (groups.length === 0) throw new KnowledgeError('knowledge retract 至少要一个 --entry、--run 或 --object');
  for (const group of groups) await feeding.screenRetraction(by, { schema: 'retraction@1', [group.kind]: group.ids, by: by.id, at: request.at, reason: request.reason });
  const skipped: KnowledgeRetractReport['skipped'] = [];
  const pending: typeof groups = [];
  for (const group of groups) {
    const fresh: string[] = [];
    for (const id of group.ids) {
      const records = await feeding.retractionCover(by, group.cover, id);
      if (records.length > 0) skipped.push({ kind: group.cover, id, records });
      else fresh.push(id);
    }
    if (fresh.length > 0) pending.push({ ...group, ids: fresh });
  }
  const appended: KnowledgeRetractReport['appended'] = [];
  for (const group of pending) {
    const record = await feeding.retract(by, { schema: 'retraction@1', [group.kind]: group.ids, by: by.id, at: request.at, reason: request.reason });
    appended.push({ record, kind: group.kind, count: group.ids.length, reason: request.reason });
  }
  return { appended, skipped };
}

/** Chinese lines for one knowledge retract command. */
export function formatKnowledgeRetract(report: KnowledgeRetractReport): string[] {
  if (report.appended.length === 0) {
    const prefixes: string[] = [];
    for (const row of report.skipped) for (const record of row.records) {
      const prefix = record.slice(0, 12);
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
    return [`这些目标已撤回（撤回记录 ${prefixes.join('、')}），没有追加`];
  }
  const lines = report.appended.map(row => `撤回记录 ${row.record.slice(0, 12)}：${RETRACT_LABEL[row.kind]} ${row.count} 个，原因 ${row.reason}`);
  for (const row of report.skipped) {
    const prefixes: string[] = [];
    for (const record of row.records) {
      const prefix = record.slice(0, 12);
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
    lines.push(`已跳过${RETRACT_LABEL[row.kind]} ${row.id.slice(0, 12)}：已有撤回记录 ${prefixes.join('、')}`);
  }
  lines.push('原记录未改动；读侧将显示根据已撤回');
  return lines;
}
