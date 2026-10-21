// Refusals: a call the engine answers with protocol errors instead of a result. A Refusal carries the errors the caller sees
// and, separately, the real reason for the admin log (absent and forbidden look the same to the caller, D05 R[3]).
import { CORE_VIOLATION_CODES, PROTOCOL_CODES, type ProtocolCode } from '../../../contracts/generated/protocol.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { UNAVAILABLE_MESSAGE } from '../../refs/api.ts';

export class Refusal extends Error {
  readonly errors: ProtocolError[];
  /** The real reason, for admins only. */
  readonly adminNote: string | null;
  constructor(errors: ProtocolError[], adminNote: string | null = null) {
    super(errors.map((e) => `${e.code}: ${e.message}`).join('; '));
    this.name = 'Refusal';
    this.errors = errors;
    this.adminNote = adminNote;
  }
}

/** A protocol error with the registered fix unless another is given. */
export function protocolError(code: ProtocolCode, message: string, extra: Omit<Partial<ProtocolError>, 'code' | 'message'> = {}): ProtocolError {
  return { code, message, fix: PROTOCOL_CODES[code].fix, ...extra };
}

/** The neutral answer for absent and forbidden alike. */
export function unavailableError(path?: string): ProtocolError {
  return protocolError('SOURCE_UNAVAILABLE', UNAVAILABLE_MESSAGE, path === undefined ? {} : { path });
}

export function unavailable(path: string | undefined, adminNote: string): Refusal {
  return new Refusal([unavailableError(path)], adminNote);
}

/** The registered fix of a core violation or protocol code; pack codes have none here. */
export function fixOf(code: string): string | undefined {
  if (Object.hasOwn(CORE_VIOLATION_CODES, code)) return CORE_VIOLATION_CODES[code as keyof typeof CORE_VIOLATION_CODES].fix;
  if (Object.hasOwn(PROTOCOL_CODES, code)) return PROTOCOL_CODES[code as ProtocolCode].fix;
  return undefined;
}

/** The text of a thrown value for the admin log, never for callers. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}: ${error.message}${detail !== undefined ? ` ${safeJson(detail)}` : ''}`;
  }
  return String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 2000) ?? '';
  } catch {
    return '';
  }
}
