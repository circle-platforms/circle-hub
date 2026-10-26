// Public surface of the FAMX/FAMY product pack for other packages and tools: where the pack lives, its packaging (pack.json
// lists exactly the pack files: product.json and functions/, never this file, the README, the tests or testing/), the
// sandbox entry points and the pure functions with their types.
//
//   node packs/product/famx/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'famx';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export type {
  Alias,
  Applicability,
  ArgumentTypeDeclaration,
  Build,
  BuildFiles,
  CommandEntryData,
  CommandTreeInput,
  CommandTreeParams,
  CommandTreeResult,
  CommandsInput,
  CommandsResult,
  EntryKind,
  Family,
  FileRef,
  FragmentRef,
  HubPage,
  IdsInput,
  IdsResult,
  ImageRef,
  ListingContext,
  ListingInput,
  ListingPage,
  ListingResult,
  LocateInput,
  LocateResult,
  ManualCatalog,
  ManualInput,
  ManualResult,
  PageKind,
  Phrase,
  PlanSyncInput,
  PlanSyncOptions,
  PlanSyncResult,
  ProducedEntry,
  ReadHub,
  ReleaseInput,
  ReleaseResult,
  SelectBuildInput,
  SelectBuildResult,
  SelectionBasis,
  SyncBuildsInput,
  SyncBuildsResult,
  Unplaced,
} from './functions/types.ts';

export { parseListing } from './functions/listing.ts';
export { selectBuild } from './functions/select-build.ts';
export { planSync, syncBuilds } from './functions/sync-plan.ts';
export { produceCommandEntries, ARGUMENT_TYPES } from './functions/command-tree.ts';
export { produceManualEntries } from './functions/manual.ts';
export { produceReleaseEntries } from './functions/release-notes.ts';
export { extractCommands } from './functions/commands.ts';
export { locateFromAncestors } from './functions/locate.ts';
export { idsFromTitle } from './functions/ids.ts';
export { PRODUCT_LINE, lineKey, parseBuildName, parseHubName, parsePageName } from './functions/naming.ts';
export { hasCommandTree } from './functions/builds.ts';
export { planBuilds, isoTime } from './functions/sync.ts';
export { chooseBuild, asBuild } from './functions/select.ts';
export { commandTree as commandTreeProducer, manual as manualProducer, releaseNotes as releaseNotesProducer } from './functions/producers.ts';
export { fixedBugEntries } from './functions/fixed-bugs.ts';
export { specifications as specificationsProducer, specificationScope, productDocument } from './functions/specifications.ts';
export { documentLines, folderLine, folderNames } from './functions/documents.ts';
export { INDEX_ID, SOURCE_ROLES, fileId, fileKey, listingId } from './functions/sources.ts';
export { cases as casesProducer, caseStatement, elementDocument, elementDocuments, listedIds, storable, treeFolders } from './functions/cases.ts';
export { MAX_DEPTH as CASE_MAX_DEPTH, MAX_ITEM_ID, caseKeys, caseNodes } from './functions/cases-nodes.ts';
export type { CaseNode, CaseScan } from './functions/cases-nodes.ts';
export { commandCatalog, foldText, resolvePhrase, resolvePhrasePaths, textCommands, withoutListNumbers } from './functions/cases-commands.ts';
export type { CommandCatalog, TextCommands } from './functions/cases-commands.ts';
export { MAX_CASE_DOCUMENTS, NOTE_EXAMPLES, caseDocumentsFor, caseIndexOptions, caseNote, caseSources, caseTree, isProductRoot, uncoveredDocuments, unversionedCaseSources } from './functions/cases-sync.ts';
export type { CaseCounts, CaseDocument, CaseIndexOptions, CaseTree, Counted } from './functions/cases-sync.ts';
export {
  AGILE_ID,
  CASE_DOCUMENTS_ROLE,
  CASE_MEMBER,
  CASE_PREFIX,
  CASE_RULE,
  CASE_TREE_ID,
  CASE_TREE_ROLE,
  DEFAULT_MIN_LINE,
  MINDMAP_PREFIX,
  negativeOf,
  tagKey,
} from './functions/cases-rules.ts';

/**
 * Sandbox entry points: module path relative to the pack directory and export name. Every one is total over JSON input. The
 * first six are what product.json declares (the product@1 shapes); the rest are the building blocks and later capabilities.
 */
export const FUNCTIONS = {
  syncPlan: { module: 'functions/sync.ts', export: 'default' },
  selectBuildRule: { module: 'functions/select.ts', export: 'default' },
  commandTreeProducer: { module: 'functions/producers.ts', export: 'commandTree' },
  manualProducer: { module: 'functions/producers.ts', export: 'manual' },
  releaseNotesProducer: { module: 'functions/producers.ts', export: 'releaseNotes' },
  casesProducer: { module: 'functions/cases.ts', export: 'cases' },
  documents: { module: 'functions/documents.ts', export: 'default' },
  listing: { module: 'functions/listing.ts', export: 'default' },
  selectBuild: { module: 'functions/select-build.ts', export: 'default' },
  planSync: { module: 'functions/sync-plan.ts', export: 'default' },
  syncBuilds: { module: 'functions/sync-plan.ts', export: 'syncBuildsFunction' },
  commandTree: { module: 'functions/command-tree.ts', export: 'default' },
  manual: { module: 'functions/manual.ts', export: 'default' },
  releaseNotes: { module: 'functions/release-notes.ts', export: 'default' },
  commands: { module: 'functions/commands.ts', export: 'default' },
  locate: { module: 'functions/locate.ts', export: 'default' },
  ids: { module: 'functions/ids.ts', export: 'default' },
} as const;

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
