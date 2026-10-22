// Helpers shared by the template-gap functions (adapted from the case-review pack): record checks, the warning collector,
// refusals and the totality guard. No imports at run time besides type-only ones.
import type { PackError, PackFailure, PackWarning } from './types.ts';

export const PACK = 'template-gap';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type WarningSink = {
  /** A summary about one document (one per document and code at most), in the order they were noted. */
  note(warning: PackWarning): void;
  list(): PackWarning[];
};

/**
 * The warnings of a call. Every warning is a per-document summary (at most one per document and code), so the list grows
 * with the documents and the output limit (too_large) bounds it; the engine keeps the first 100 in the parse action.
 */
export function warningSink(): WarningSink {
  const kept: PackWarning[] = [];
  return {
    note(warning) {
      kept.push(warning);
    },
    list() {
      return [...kept];
    },
  };
}

export function failure(code: string, message: string, fix: string, warnings: PackWarning[] = [], documents?: string[]): PackFailure {
  const error: PackError = { code: `${PACK}.${code}`, message, fix };
  if (documents !== undefined) error.documents = documents;
  return { error, warnings };
}

export function isFailure(value: unknown): value is PackFailure {
  return isRecord(value) && isRecord(value.error);
}

/** Totality guard for default exports: an unexpected exception becomes a refusal instead of a throw. */
export function guarded(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    let detail = '未知错误';
    try {
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } catch {
      // keep the generic detail
    }
    return failure('internal_error', `函数内部出错：${detail.slice(0, 200)}`, '这是任务包的缺陷，请把输入交给任务包维护人');
  }
}
