// Public surface of the case-review-verify workflow pack (the independent verification) for other packages and tooling: where
// the pack lives, its packaging (pack.json lists exactly the pack files; never this file, the README, the tests or testing/),
// the entry points its declarations name, and the pure functions.
//
//   node packs/workflow/case-review-verify/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../case-review/packaging.ts';

export const PACK_ID = 'case-review-verify';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export { projection, summaryOf, TARGET_SLOT, DRAFT_SLOT, DRAFT_PACK, FINDINGS, LEVEL, MAX_ITEMS, MAX_SUMMARY } from './functions/projection.ts';
export type { DraftFinding, DraftLevel, DraftQuote } from './functions/projection.ts';
export { expected, documentIdOf, HISTORY_SEARCH, STRATEGY_SEARCH } from './functions/expected.ts';
export { dispositions, verdict, CODES, DISPOSITIONS, NEW_FINDING, VERDICTS, PROBES } from './functions/verify.ts';
export { claimSubject } from './functions/subjects.ts';

/** The functions the declarations name (workflow.json and checks.json), as the sandbox calls them. */
export const FUNCTIONS = {
  projection: { module: 'functions/projection.ts', export: 'default' },
  expectedSources: { module: 'functions/expected.ts', export: 'default' },
  dispositions: { module: 'functions/verify.ts', export: 'dispositionsCheck' },
  claimSubject: { module: 'functions/subjects.ts', export: 'claimSubject' },
  verdict: { module: 'functions/verify.ts', export: 'verdictCheck' },
} as const;

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
