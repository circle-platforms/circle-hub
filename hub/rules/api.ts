// Public surface of the rules package: generic interpreters over versioned tables, the catalog view they match against,
// runCheck for declared checks, and the pack-function sandbox. Other packages import only from this file.
import type { SourceView } from './types.ts';

export type { CatalogEntry, CatalogParam, CatalogParamType, CatalogSignature, CheckOutcome, TableKind } from '../../contracts/src/tables.ts';
export { TABLE_SCHEMAS } from '../../contracts/src/tables.ts';

export type { CheckContext, CheckRequest, Interpreter, SourceView, FragmentReadFailure, TableIssue } from './types.ts';
export { INTERPRETERS, getInterpreter } from './interpreters/registry.ts';

export type { CatalogLookupOptions, CatalogMatch, CatalogSpec, CatalogView, CatalogViewOptions } from './catalog/view.ts';
export { buildCatalog, createCatalogView } from './catalog/view.ts';

export type { CheckBindings, CheckDeclaration, PackCheckInput, UnreadSource } from './check.ts';
export { runCheck } from './check.ts';

export type { SandboxBatchItem, PackFunctionTarget, SandboxLimits, SandboxOptions, SandboxResult } from './sandbox/sandbox.ts';
/** stopAll: call from the server's SIGTERM and SIGINT handlers before exiting (it also runs on process exit). */
export { callPackFunction, callPackFunctionBatch, DEFAULT_LIMITS, stopAll } from './sandbox/sandbox.ts';
export type { SandboxErrorCode } from './sandbox/errors.ts';
export { SANDBOX_ERRORS, SandboxError } from './sandbox/errors.ts';
export { osIsolationAvailable, osIsolationFailure } from './sandbox/isolation.ts';
/** sweepOrphans: call once when the Hub starts, to end children an earlier Hub process left running. */
export { sweepOrphans } from './sandbox/orphans.ts';

export type { SampleResult } from './samples.ts';
export { runSamples } from './samples.ts';

export { quoteMatches } from './text.ts';

/** A SourceView over fragment texts the caller has already resolved, keyed by reference URI. */
export function sourcesFrom(texts: Readonly<Record<string, string>> | ReadonlyMap<string, string>): SourceView {
  if (texts instanceof Map) return { text: (reference) => texts.get(reference) };
  const record = texts as Readonly<Record<string, string>>;
  return { text: (reference) => (Object.hasOwn(record, reference) ? record[reference] : undefined) };
}

export { isExhaustedFunctionFailure } from './sandbox/retry.ts';
