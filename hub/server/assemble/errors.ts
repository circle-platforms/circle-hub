// Errors of the assembly. Messages are Chinese and never carry a token, a key or a credential value; `hint` is what the
// operator can do next (main.ts prints it after the message).

/** The Hub cannot be assembled (no vault key, a broken configuration of a package): the process does not start. */
export class AssemblyError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AssemblyError';
    this.hint = hint;
  }
}

/** The message of any thrown value, for an operator message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The operator hint a package error carries (`hint` of hub/platform, `fix` of hub/records), when it has one. */
export function hintOf(error: unknown): string | null {
  const value = error as { hint?: unknown; fix?: unknown } | null;
  if (typeof value?.hint === 'string' && value.hint.length > 0) return value.hint;
  if (typeof value?.fix === 'string' && value.fix.length > 0) return value.fix;
  return null;
}
