// Shared helpers of case-review-report (the pack id, small value checks, the failure shapes). Pure TypeScript, no Hub
// import beyond the contracts the sandbox allows a pack to read.
export const PACK = 'case-review-report';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refusal: { error, warnings } — the whole call is refused (ProjectionOutput's failure variant). */
export function failure(code: string, message: string, fix: string): { error: { code: string; message: string; fix: string }; warnings: [] } {
  return { error: { code: `${PACK}.${code}`, message, fix }, warnings: [] };
}

/** Totality guard for default exports: an unexpected exception becomes a refusal instead of a silent empty success. */
export function guarded(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return failure('internal_error', `函数内部出错：${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`, '这是任务包的缺陷，请把输入交给任务包维护人');
  }
}
