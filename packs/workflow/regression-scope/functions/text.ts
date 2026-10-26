// Small pure helpers; runtime imports stay inside the pack.
import { CHANGE_KIND_LABEL } from './generated/vocabulary.ts';
import type { ChangeKind } from '../../../../contracts/generated/vocabulary.ts';

export const PACK = 'regression-scope';

export const CHANGE_LABEL = CHANGE_KIND_LABEL;

/** What a reason's conclusion says, by the command definition's change (a new command is not called modified). */
export const DEFINITION_CHANGE_LABEL = { added: '新增命令', removed: '删除命令', modified: '命令定义有变更', none: '仅说明文字有变更' } as const satisfies Record<ChangeKind | 'none', string>;

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** At most `max` code points; a clipped text ends with an ellipsis. */
export function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

export function internalError(error: unknown): string {
  let detail = '未知错误';
  try {
    detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    // keep the generic detail
  }
  return detail.slice(0, 200);
}

/** Runs a function entry so that it never throws. */
export function guarded<T>(run: () => T, fallback: (message: string) => T): T {
  try {
    return run();
  } catch (error) {
    return fallback(internalError(error));
  }
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
