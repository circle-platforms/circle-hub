import {
  errorCodeInfo,
  StructuredErrorSchema,
  type ErrorCode,
  type StructuredError,
} from "@infosec/contracts";

/** Core services return domain results; the wire layer maps them to envelopes. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuredError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(
  code: ErrorCode,
  message: string,
  userAction?: string,
): Result<T> {
  const info = errorCodeInfo(code);
  const error = StructuredErrorSchema.parse({
    code,
    category: info.category,
    message,
    retryable: info.retryable,
    evidenceRefs: [],
    ...(info.requiresUserAction
      ? { userAction: userAction ?? "Review the message and correct the request." }
      : {}),
  });
  return { ok: false, error };
}
