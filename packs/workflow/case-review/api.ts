// Public surface of the case-review workflow pack (the draft review) for other packages and tooling: where the pack lives, its
// packaging (pack.json lists exactly the pack files: the declarations, SKILL.md, functions/, tables/, samples/, examples/;
// never this file, packaging.ts, the README, the tests or testing/), the entry points its declarations name, and the pure
// functions. `packaging.ts` beside this file is the shared packaging tool of every pack of this package.
//
//   node packs/workflow/case-review/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from './packaging.ts';

export const PACK_ID = 'case-review';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export { projection, documentIdOf, blockNodes, blocksOf, outerGroups, summaryOf, MAX_ITEMS, MAX_SUMMARY, SUBJECT_SLOT, CASE_PARAMETERS } from './functions/projection.ts';
export { expected, HISTORY_SEARCH, STRATEGY_SEARCH, SOURCE_PARAMETERS } from './functions/expected.ts';
export { structureSubject, commandSubject, scanSubject, citedCommands, caseLines } from './functions/subjects.ts';
export { quotableLines, quotedFromCase } from './functions/lines.ts';
export { findingSources, tagSpelling, HINT_ONLY, LOCATION_MISSING, QUOTE_MISSING, COMMAND_NOT_IN_CASE, TAG_VARIANT } from './functions/checks.ts';
export { projectItems } from './functions/project.ts';
export { expectedSources, extractIds, featureTerms, specSearchId } from './functions/expected-sources.ts';
export { templateCoverage } from './functions/template-coverage.ts';
export { declareResourceTags, normalizeTag, CANONICAL_TAGS } from './functions/tags.ts';
export { workflowNames } from './functions/common.ts';

/** The functions the declarations name (workflow.json and checks.json), as the sandbox calls them. */
export const FUNCTIONS = {
  projection: { module: 'functions/projection.ts', export: 'default' },
  expectedSources: { module: 'functions/expected.ts', export: 'default' },
  structureSubject: { module: 'functions/subjects.ts', export: 'structureSubject' },
  commandSubject: { module: 'functions/subjects.ts', export: 'commandSubject' },
  scanSubject: { module: 'functions/subjects.ts', export: 'scanSubject' },
  findingSources: { module: 'functions/checks.ts', export: 'findingSources' },
  tagSpelling: { module: 'functions/checks.ts', export: 'tagSpelling' },
} as const;

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
