// Public surface of the APV/NSAE product pack functions. The Hub runs them in its sandbox by module path and export name
// (FUNCTIONS); TypeScript callers and tests may import the types and the named functions from here.
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
} from './types.ts';

export { parseListing } from './listing.ts';
export { selectBuild } from './select-build.ts';
export { planSync, syncBuilds } from './sync-plan.ts';
export { produceCommandEntries, ARGUMENT_TYPES } from './command-tree.ts';
export { produceManualEntries } from './manual.ts';
export { produceReleaseEntries } from './release-notes.ts';
export { extractCommands } from './commands.ts';
export { locateFromAncestors } from './locate.ts';
export { idsFromTitle } from './ids.ts';
export { PRODUCT_LINE, lineKey, parseBuildName, parseHubName, parsePageName } from './naming.ts';
export { hasCommandTree } from './builds.ts';

/** Sandbox entry points: module path relative to the pack directory and export name. Every one is total over JSON input. */
export const FUNCTIONS = {
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
