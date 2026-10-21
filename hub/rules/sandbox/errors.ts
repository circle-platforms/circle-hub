// Typed errors of the pack-function sandbox. These codes are internal to the Hub: runCheck turns them into unknown outcomes
// (reason timeout, budget_exhausted or check_error); they are not protocol codes and never reach a model as such.

export const SANDBOX_ERRORS = {
  SANDBOX_TIMEOUT: '包内函数超过了时间上限，已被终止',
  SANDBOX_OUTPUT_TOO_LARGE: '包内函数的输出超过了大小上限，已被终止',
  SANDBOX_VIOLATION: '包内函数试图越过沙箱边界，已被拒绝',
  // detail.reason: os_isolation (no operating-system isolation here), cpu_limit, spawn_failed, queue_full, stopping.
  SANDBOX_UNAVAILABLE: '沙箱现在不能运行包内函数（没有操作系统隔离、子进程无法启动、排队已满或 Hub 正在停止）',
  FUNCTION_THREW: '包内函数抛出了错误',
  FUNCTION_NOT_FOUND: '找不到要调用的包内函数',
  IMPORT_NOT_DECLARED: '包内函数导入了未声明的模块',
} as const;

export type SandboxErrorCode = keyof typeof SANDBOX_ERRORS;

export function isSandboxErrorCode(value: unknown): value is SandboxErrorCode {
  return typeof value === 'string' && Object.hasOwn(SANDBOX_ERRORS, value);
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** Machine-readable cause: which limit, which import, which path (relative to the pack). */
  readonly detail: Record<string, unknown>;
  /** Captured, capped output of the function, when the child got far enough to report it. */
  readonly stdout: string;
  readonly stderr: string;

  constructor(code: SandboxErrorCode, detail: Record<string, unknown> = {}, logs: { stdout?: string; stderr?: string } = {}, message?: string) {
    super(message ?? SANDBOX_ERRORS[code]);
    this.name = 'SandboxError';
    this.code = code;
    this.detail = detail;
    this.stdout = logs.stdout ?? '';
    this.stderr = logs.stderr ?? '';
  }
}
