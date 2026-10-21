// Operator-facing failure of a platform command. Messages are Chinese and never carry secrets.
export class PlatformError extends Error {
  /** What the operator can do next, when there is something to do. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlatformError';
    this.hint = hint;
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof PlatformError) return error.hint ? `${error.message}（${error.hint}）` : error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
