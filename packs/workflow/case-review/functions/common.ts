// Helpers shared by the case-review functions: record checks, the warning collector and refusals. No imports at run time.
import type { Failure, PackError, Warning } from './types.ts';

export const PACK = 'case-review';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type WarningSink = {
  /** A warning about one node or item; the first `max` are kept. */
  add(warning: Warning): void;
  /** A summary (about a document or the call): kept outside the per-node budget, so a full budget never hides it. */
  note(warning: Warning): void;
  list(): Warning[];
};

/**
 * Keeps the first `max` per-node warnings and up to `maxNotes` summaries, in the order they were added; the list ends with
 * one warnings_clipped entry that counts what was dropped, per code.
 */
export function warningSink(max = 100, maxNotes = 1000): WarningSink {
  const kept: Warning[] = [];
  let details = 0;
  let notes = 0;
  const dropped = new Map<string, number>();
  const drop = (code: string): void => {
    dropped.set(code, (dropped.get(code) ?? 0) + 1);
  };
  return {
    add(warning) {
      if (details < max) {
        kept.push(warning);
        details += 1;
      } else drop(warning.code);
    },
    note(warning) {
      if (notes < maxNotes) {
        kept.push(warning);
        notes += 1;
      } else drop(warning.code);
    },
    list() {
      if (dropped.size === 0) return [...kept];
      const codes: { [code: string]: number } = {};
      let total = 0;
      for (const code of [...dropped.keys()].sort()) {
        const count = dropped.get(code) ?? 0;
        codes[code] = count;
        total += count;
      }
      return [...kept, { code: `${PACK}.warnings_clipped`, message: `还有 ${total} 条警告没有列出（按码计数见 data.codes）`, data: { dropped: total, codes } }];
    },
  };
}

export function failure(code: string, message: string, fix: string, warnings: Warning[] = [], documents?: string[]): Failure {
  const error: PackError = { code: `${PACK}.${code}`, message, fix };
  if (documents !== undefined) error.documents = documents;
  return { error, warnings };
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
