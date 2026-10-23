// Client-side adaptation of the repository pure judgment rules; never imported by Hub runtime.
// Typed errors of the Jev client. Messages are Chinese and never contain the API key, a request body or a response body.

export const JEV_ERROR_CODES = [
  'JEV_UNAUTHORIZED',
  'JEV_RATE_LIMITED',
  'JEV_BAD_REQUEST',
  'JEV_TOO_LARGE',
  'JEV_UNAVAILABLE',
  'JEV_BAD_RESPONSE',
] as const;

export type JevErrorCode = (typeof JEV_ERROR_CODES)[number];

export interface JevErrorOptions {
  /** HTTP status of the last request sent, when it got a response. */
  status?: number | null;
  /** The request id of the last response, when the service sent one. */
  requestId?: string | null;
  /** Requests sent: 0 when nothing was sent (a refused request, a failing key source, a batch never started). */
  attempts?: number;
  /** Machine-readable reasons from an error body, restricted to a safe alphabet (for example `missing`). */
  reasons?: readonly string[];
  /** The question the failure concerns, when it concerns one. */
  questionId?: string | null;
}

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly attempts: number;
  readonly reasons: readonly string[];
  readonly questionId: string | null;

  constructor(code: JevErrorCode, message: string, options: JevErrorOptions = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.attempts = options.attempts ?? 0;
    this.reasons = Object.freeze([...(options.reasons ?? [])]);
    this.questionId = options.questionId ?? null;
  }
}

export function isJevError(value: unknown, code?: JevErrorCode): value is JevError {
  return value instanceof JevError && (code === undefined || value.code === code);
}

export function isJevErrorCode(value: unknown): value is JevErrorCode {
  return typeof value === 'string' && (JEV_ERROR_CODES as readonly string[]).includes(value);
}
