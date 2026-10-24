// Typed errors of the knowledge package. `code` is a registered protocol code only when the failure belongs to the caller;
// otherwise null and the caller reports it as the Hub's own failure. Messages are Chinese.
import { PROTOCOL_CODES, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import { cutText } from './digest.ts';

export interface KnowledgeErrorOptions {
  code?: ProtocolCode | null;
  detail?: Record<string, unknown>;
  cause?: unknown;
  fix?: string;
}

export class KnowledgeError extends Error {
  readonly code: ProtocolCode | null;
  readonly fix: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KnowledgeError';
    this.code = options.code ?? null;
    this.fix = options.fix ?? (this.code === null ? null : PROTOCOL_CODES[this.code].fix);
    this.detail = Object.freeze({ ...(options.detail ?? {}) });
  }
}

/** Short, storable text of any thrown value, for reports and admin details (never a stack). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return cutText(`${error.name}: ${error.message}`, 500);
  return cutText(String(error), 500);
}
